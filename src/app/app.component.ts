import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Store } from '@ngrx/store';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  approveBatch,
  changeChecksum,
  createBatch,
  pauseBatch,
  reportReceipt,
  resumeBatch,
  retryRollback,
  rollbackBatch,
  telemetryTick
} from './state/release.actions';
import { selectAudits, selectBatchViews, selectGroups, selectPendingTotal, selectRelease } from './state/release.selectors';
import { buildStages, makeChecksum, shortChecksum } from './state/release.helpers';
import type { BatchView } from './state/release.helpers';
import type { ReleaseBatch } from './state/release.models';

interface ManualForm { deviceId: string; packageVersion: string; checksum: string; }
interface RepackForm { firmware: string; checksum: string; }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>固件包 · 发布批次 · 设备回执按校验码对账，对不上不进档、不计数</p></div>
      <mat-chip-set><mat-chip highlighted>校验码对账</mat-chip><mat-chip>待核实隔离</mat-chip><mat-chip>回滚只覆盖对得上的设备</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>发布批次</span><strong>{{ views().length }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待核实回执</span><strong class="warn">{{ pendingTotal() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>对账通过已装</span><strong>{{ installedTotal() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ audits().length }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>发布包校验码（发布时登记）</mat-label>
              <input matInput [(ngModel)]="draft.packageChecksum">
              <button mat-icon-button matSuffix type="button" (click)="draft.packageChecksum = newChecksum(draft.firmware)">↻</button>
            </mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>回滚包校验码</mat-label>
              <input matInput [(ngModel)]="draft.rollbackChecksum">
              <button mat-icon-button matSuffix type="button" (click)="draft.rollbackChecksum = newChecksum(draft.rollbackVersion)">↻</button>
            </mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups()" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建批次并登记校验码</button>
          </mat-card-content>
        </mat-card>

        <section class="batch-list">
          <mat-card appearance="outlined" class="batch-panel" *ngFor="let view of views()">
            <mat-card-content>
              <div class="row">
                <div>
                  <b>{{ view.batch.name }}</b>
                  <small>{{ view.batch.firmware }} · 发布包 <code>{{ short(view.batch.packageChecksum) }}</code> → 回滚 {{ view.batch.rollbackVersion }} / <code>{{ short(view.batch.rollbackChecksum) }}</code></small>
                </div>
                <mat-chip-set><mat-chip [color]="statusColor(view.batch.status)" highlighted>{{ statusLabel(view.batch.status) }}</mat-chip></mat-chip-set>
              </div>

              <div class="stages">
                <ng-container *ngFor="let stage of view.batch.stages; let i = index">
                  <span class="stage" [class.done]="stage.status === 'done'" [class.active]="stage.status === 'active'">
                    档{{ i + 1 }} · {{ stage.percent }}%<br>
                    <small>{{ stage.status === 'pending' ? '未下发（待按当前包重算）' : '锁定 ' + short(stage.checksum) }}</small>
                  </span>
                  <span class="arrow" *ngIf="i < view.batch.stages.length - 1">→</span>
                </ng-container>
              </div>

              <mat-progress-bar mode="determinate" [value]="view.progress"></mat-progress-bar>
              <div class="row counters">
                <span>已装（对账通过）<b>{{ view.verifiedCount }}</b>/{{ view.activeTarget }} 台</span>
                <span class="warn">待核实 {{ view.pendingCount }}</span>
                <span class="muted">已作废 {{ view.invalidatedCount }}</span>
                <span class="muted">安装失败 {{ view.batch.failed }} · 阈值 {{ view.batch.failureThreshold }}%</span>
                <span>{{ view.progress }}%</span>
              </div>

              <div class="actions">
                <button mat-stroked-button *ngIf="view.batch.status === 'draft'" (click)="approve(view.batch.id)">审批</button>
                <button mat-stroked-button *ngIf="view.batch.status === 'approved'" (click)="resume(view.batch.id)">开始发布</button>
                <button mat-stroked-button *ngIf="view.batch.status === 'running'" (click)="pause(view.batch.id)">暂停</button>
                <button mat-stroked-button *ngIf="view.batch.status === 'paused'" (click)="resume(view.batch.id)">继续</button>
                <button mat-flat-button color="warn" [disabled]="view.batch.status === 'rolled_back'" (click)="rollback(view.batch.id)">紧急回滚</button>
              </div>

              <!-- 改动发布包：旧回执作废、未下发档位按新包重算、已装结果保留 -->
              <div class="sub-box" *ngIf="view.batch.status !== 'rolled_back'">
                <b>改动发布包（校验码变更）</b>
                <div class="inline-form">
                  <mat-form-field appearance="outline" class="compact"><mat-label>新版本</mat-label><input matInput [(ngModel)]="repack(view.batch.id).firmware"></mat-form-field>
                  <mat-form-field appearance="outline" class="compact grow"><mat-label>新包校验码</mat-label><input matInput [(ngModel)]="repack(view.batch.id).checksum"></mat-form-field>
                  <button mat-stroked-button type="button" (click)="repack(view.batch.id).checksum = newChecksum(repack(view.batch.id).firmware)">生成</button>
                  <button mat-stroked-button color="accent" type="button" (click)="changePackage(view.batch.id)">登记新包并作废旧回执</button>
                </div>
              </div>

              <!-- 手工回执：值班员录入设备实际安装那份包的校验码 -->
              <div class="sub-box" *ngIf="view.batch.status === 'running' || view.batch.status === 'paused'">
                <b>设备回执上报（同一设备只留最新一条）</b>
                <div class="inline-form">
                  <mat-form-field appearance="outline" class="compact"><mat-label>设备号</mat-label><input matInput [(ngModel)]="manual(view.batch.id).deviceId" placeholder="dev-1"></mat-form-field>
                  <mat-form-field appearance="outline" class="compact"><mat-label>实装版本</mat-label><input matInput [(ngModel)]="manual(view.batch.id).packageVersion"></mat-form-field>
                  <mat-form-field appearance="outline" class="compact grow"><mat-label>实装包校验码</mat-label><input matInput [(ngModel)]="manual(view.batch.id).checksum"></mat-form-field>
                  <button mat-stroked-button type="button" (click)="fillCorrect(view)">填登记值</button>
                  <button mat-stroked-button color="warn" type="button" (click)="fillBypass(view)">模拟绕过控制台手刷</button>
                  <button mat-flat-button color="primary" type="button" (click)="submitReceipt(view, actorSel)">值班员上报</button>
                  <mat-form-field appearance="outline" class="compact"><mat-label>值班员</mat-label>
                    <mat-select [(ngModel)]="actorSel"><mat-option value="值班员甲">值班员甲</mat-option><mat-option value="值班员乙">值班员乙</mat-option></mat-select>
                  </mat-form-field>
                  <button mat-stroked-button type="button" (click)="doubleSubmit(view)">甲乙同时上报同机</button>
                </div>
              </div>

              <!-- 回滚执行：只覆盖校验码对得上的设备，失败按设备重试 -->
              <div class="sub-box rollback" *ngIf="view.batch.status === 'rolled_back'">
                <b>回滚执行（回滚包 {{ view.batch.rollbackVersion }} / <code>{{ short(view.batch.rollbackChecksum) }}</code>）</b>
                <div class="row counters">
                  <span>校验码对得上 <b>{{ view.rollbackMatched }}</b></span>
                  <span>已回滚 {{ view.rollbackDone }}</span>
                  <span class="warn">失败 {{ view.rollbackFailed }}</span>
                  <button mat-stroked-button color="warn" [disabled]="view.rollbackFailed === 0" (click)="retry(view.batch.id)">失败设备按设备重试</button>
                </div>
                <div class="rb-list">
                  <span *ngFor="let rb of view.batch.rollbackReport" class="rb" [class.ok]="rb.state === 'reported'" [class.bad]="rb.state === 'failed'" [title]="rb.lastError ?? ''">
                    {{ rb.deviceId }}·{{ short(rb.checksum) }}·{{ rb.state === 'reported' ? '成功' : rb.state === 'failed' ? '失败' : '排队' }}
                  </span>
                </div>
              </div>

              <!-- 回执对账明细 -->
              <div class="receipts">
                <div class="receipt" *ngFor="let r of receiptsOf(view.batch.id)">
                  <mat-chip-set>
                    <mat-chip [highlighted]="true" [color]="r.state === 'verified' ? 'primary' : r.state === 'pending_verification' ? 'warn' : 'default'">
                      {{ r.state === 'verified' ? '对账通过' : r.state === 'pending_verification' ? '待核实' : '已作废' }}
                    </mat-chip>
                  </mat-chip-set>
                  <span class="dev">{{ r.deviceId }}</span>
                  <span class="muted">{{ r.packageVersion }} · <code>{{ short(r.checksum) }}</code> · {{ r.reporter }}</span>
                  <span class="muted time">{{ r.receivedAt.replace('T', ' ').slice(5, 19) }}</span>
                  <button mat-button *ngIf="r.state === 'pending_verification'" (click)="reReport(view, r.deviceId)">设备刷回登记包，重报</button>
                  <small class="note" *ngIf="r.note">{{ r.note }}</small>
                </div>
              </div>
            </mat-card-content>
          </mat-card>
        </section>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits()"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(26px,3.4vw,44px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.85 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(320px,.85fr) minmax(460px,1.15fr); gap:20px; align-items:start; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:16px }
    .batch-list { display:grid; gap:14px; } .batch-panel { padding:6px 10px; }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap } small { color:#71858c } code { background:#eef3f4; padding:1px 5px; border-radius:4px; font-size:12px }
    .stages { display:flex; align-items:center; gap:8px; margin:12px 0; flex-wrap:wrap }
    .stage { border:1px solid #cfdadd; border-radius:8px; padding:6px 10px; font-size:12px; background:#f7fafb; line-height:1.5 }
    .stage.active { border-color:#2a9d8f; background:#e7f6f3; font-weight:600 } .stage.done { opacity:.62; text-decoration:line-through } .arrow { color:#8aa0a6 }
    .counters { margin-top:8px; gap:14px } .warn { color:#c0512f; font-weight:600 } .muted { color:#8aa0a6 }
    .actions { display:flex;gap:8px;flex-wrap:wrap; margin:12px 0 }
    .sub-box { border-top:1px dashed #cfdadd; padding-top:10px; margin-top:10px; display:grid; gap:8px; font-size:13px }
    .inline-form { display:flex; gap:8px; flex-wrap:wrap; align-items:center }
    .compact { width:130px } .compact.grow { width:220px } .mat-mdc-form-field.compact { display:inline-block }
    .receipts { margin-top:10px; max-height:230px; overflow:auto; border-top:1px dashed #cfdadd; padding-top:8px; display:grid; gap:4px }
    .receipt { display:flex; align-items:center; gap:10px; font-size:12.5px; flex-wrap:wrap } .receipt .dev { font-weight:600; min-width:54px } .receipt .time { margin-left:auto } .note { flex-basis:100%; color:#a0662a }
    .rb-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px } .rb { font-size:11.5px; padding:2px 8px; border-radius:10px; background:#eef3f4 } .rb.ok { background:#e2f3ea; color:#1d7a4d } .rb.bad { background:#fbe6e0; color:#b0432a }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:130px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:960px){ .stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups = toSignal(this.store.select(selectGroups), { initialValue: [] });
  private readonly release = toSignal(this.store.select(selectRelease), { initialValue: null });
  readonly views = toSignal(this.store.select(selectBatchViews), { initialValue: [] as BatchView[] });
  readonly audits = toSignal(this.store.select(selectAudits), { initialValue: [] });
  readonly pendingTotal = toSignal(this.store.select(selectPendingTotal), { initialValue: 0 });
  actorSel = '值班员甲';
  private timer?: number;
  private manualForms = new Map<string, ManualForm>();
  private repackForms = new Map<string, RepackForm>();

  draft = {
    name: '', firmware: '3.0.0', packageChecksum: makeChecksum('3.0.0'),
    rollbackVersion: '2.9.2', rollbackChecksum: makeChecksum('2.9.2'),
    groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3
  };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1600);
    this.store.select(selectRelease).subscribe((state) => localStorage.setItem('firmware-release-v2', JSON.stringify(state)));
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  installedTotal(): number {
    const state = this.release();
    if (!state) return 0;
    let count = 0;
    for (const batch of state.batches) {
      const seen = new Set<string>();
      for (const r of state.receipts) {
        if (r.batchId === batch.id && r.state === 'verified' && !seen.has(r.deviceId)) { seen.add(r.deviceId); count++; }
      }
    }
    return count;
  }

  short = shortChecksum;
  newChecksum = makeChecksum;
  statusLabel(status: ReleaseBatch['status']) {
    return { draft: '草稿', approved: '已审批', running: '发布中', paused: '已暂停', completed: '已完成', rolled_back: '回滚中/已回滚' }[status];
  }
  statusColor(status: ReleaseBatch['status']): 'primary' | 'warn' | 'accent' {
    return status === 'paused' || status === 'rolled_back' ? 'warn' : status === 'completed' ? 'accent' : 'primary';
  }

  manual(batchId: string): ManualForm {
    let form = this.manualForms.get(batchId);
    if (!form) { form = { deviceId: '', packageVersion: '', checksum: '' }; this.manualForms.set(batchId, form); }
    return form;
  }
  repack(batchId: string): RepackForm {
    let form = this.repackForms.get(batchId);
    if (!form) {
      const batch = this.views().find((v) => v.batch.id === batchId)?.batch;
      form = { firmware: batch?.firmware ?? '', checksum: '' };
      this.repackForms.set(batchId, form);
    }
    return form;
  }

  receiptsOf(batchId: string) {
    const state = this.release();
    if (!state) return [];
    return state.receipts
      .filter((receipt) => receipt.batchId === batchId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, 60);
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId || !this.draft.packageChecksum) return;
    const batch: ReleaseBatch = {
      id: crypto.randomUUID(),
      name: this.draft.name,
      firmware: this.draft.firmware,
      packageChecksum: this.draft.packageChecksum.trim(),
      rollbackVersion: this.draft.rollbackVersion,
      rollbackChecksum: this.draft.rollbackChecksum.trim(),
      groupId: this.draft.groupId,
      rolloutPercent: Number(this.draft.rolloutPercent) || 1,
      failureThreshold: Number(this.draft.failureThreshold) || 1,
      status: 'draft',
      stages: buildStages(Number(this.draft.rolloutPercent) || 1),
      failed: 0,
      seq: 0,
      rollbackReport: [],
      updatedAt: new Date().toISOString()
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft.name = '';
  }

  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  retry(id: string) { this.store.dispatch(retryRollback({ batchId: id, actor: this.actorSel })); }

  changePackage(id: string) {
    const form = this.repack(id);
    if (!form.checksum.trim()) return;
    this.store.dispatch(changeChecksum({ id, firmware: form.firmware, packageChecksum: form.checksum.trim(), actor: '发布负责人' }));
    form.checksum = '';
  }

  fillCorrect(view: BatchView) {
    const form = this.manual(view.batch.id);
    form.packageVersion = view.batch.firmware;
    form.checksum = view.batch.packageChecksum;
  }
  fillBypass(view: BatchView) {
    const form = this.manual(view.batch.id);
    form.packageVersion = '手工刷机包';
    form.checksum = makeChecksum(`bypass-${form.deviceId || 'x'}-${Date.now()}`);
  }

  submitReceipt(view: BatchView, reporter: string) {
    const form = this.manual(view.batch.id);
    if (!form.deviceId.trim() || !form.checksum.trim()) return;
    this.store.dispatch(reportReceipt({
      batchId: view.batch.id, deviceId: form.deviceId.trim(),
      packageVersion: form.packageVersion || '未知', checksum: form.checksum.trim(), reporter
    }));
  }

  /** 两名值班员同一时刻提交同一设备：receivedAt 相同，按后到（序号更大）那条为准 */
  doubleSubmit(view: BatchView) {
    const form = this.manual(view.batch.id);
    if (!form.deviceId.trim()) return;
    const at = new Date().toISOString();
    const wrong = makeChecksum(`bypass-${form.deviceId}-${Date.now()}`);
    this.store.dispatch(reportReceipt({ batchId: view.batch.id, deviceId: form.deviceId.trim(), packageVersion: '甲手刷版', checksum: wrong, reporter: '值班员甲', receivedAt: at }));
    this.store.dispatch(reportReceipt({ batchId: view.batch.id, deviceId: form.deviceId.trim(), packageVersion: view.batch.firmware, checksum: view.batch.packageChecksum, reporter: '值班员乙', receivedAt: at }));
  }

  reReport(view: BatchView, deviceId: string) {
    this.store.dispatch(reportReceipt({
      batchId: view.batch.id, deviceId, packageVersion: view.batch.firmware,
      checksum: view.batch.packageChecksum, reporter: this.actorSel
    }));
  }
}
