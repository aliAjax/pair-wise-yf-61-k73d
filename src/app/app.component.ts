import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  approveBatch,
  changePackageChecksum,
  createBatch,
  pauseBatch,
  reportReceipt,
  resumeBatch,
  retryRollback,
  reverifyDevice,
  rollbackBatch,
  telemetryTick
} from './state/release.actions';
import {
  selectAudits,
  selectBatchViews,
  selectBatches,
  selectGroups,
  selectInstalledTotal,
  selectMismatchReceipts,
  selectReceipts,
  selectRelease,
  selectRollbackTasks
} from './state/release.selectors';
import type { DeviceReceipt, ReleaseBatch, ReleaseBatchInput } from './state/release.models';
import { generateChecksum } from './state/checksum';
import { STORAGE_KEY } from './state/release.reducer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA RECONCILE</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>校验码对账</mat-chip><mat-chip>待核实不计数</mat-chip><mat-chip>回滚按设备重试</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batchViews$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待核实回执</span><strong class="warn">{{ (mismatch$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已装台数(校验一致)</span><strong>{{ (installedTotal$ | async) ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>包校验码(发布登记)</mat-label><input matInput [(ngModel)]="draft.packageChecksum"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>回滚包校验码</mat-label><input matInput [(ngModel)]="draft.rollbackChecksum"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <div class="form-actions">
              <button mat-stroked-button type="button" (click)="regenerateChecksums()">重新生成校验码</button>
              <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
            </div>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="210" class="viewport">
              <article class="batch" *cdkVirtualFor="let view of batchViews$ | async">
                <div class="row">
                  <div><b>{{ view.name }}</b><small>{{ view.firmware }} → 回滚 {{ view.rollbackVersion }}</small></div>
                  <mat-chip [color]="batchColor(view.status)" highlighted>{{ view.status }}</mat-chip>
                </div>
                <div class="checksums">
                  <mat-chip>包校验码 {{ view.packageChecksum }}</mat-chip>
                  <mat-chip>回滚包 {{ view.rollbackChecksum }}</mat-chip>
                </div>
                <div class="tiers">
                  <mat-chip *ngFor="let tier of view.tiers" [color]="tierColor(tier.status)" highlighted>档位 {{ tier.index + 1 }} · {{ tier.percent }}% · {{ tier.status }}</mat-chip>
                </div>
                <mat-progress-bar mode="determinate" [value]="view.progress"></mat-progress-bar>
                <div class="row"><span>已装 {{ view.installedTotal }}（含保留 {{ view.preservedInstalled }}） · 待核实 <b class="warn">{{ view.mismatch }}</b> · 失败 {{ view.failed }} · 阈值 {{ view.status === 'rolled_back' ? '—' : '' }}</span><span>{{ view.progress }}%</span></div>
                <div class="row" *ngIf="view.checksumChangedAt"><small class="warn">校验码已于 {{ view.checksumChangedAt | date:'MM-dd HH:mm:ss' }} 变更：旧回执作废，未下发档位按新包重算</small></div>
                <div class="rollback-progress" *ngIf="view.status === 'rolled_back'">
                  <mat-progress-bar mode="determinate" [value]="view.rollbackTotal ? view.rollbackSucceeded / view.rollbackTotal * 100 : 0" color="warn"></mat-progress-bar>
                  <small>回滚覆盖 {{ view.rollbackSucceeded }}/{{ view.rollbackTotal }} 台校验一致设备<span *ngIf="view.rollbackFailed"> · 失败 {{ view.rollbackFailed }} 台待重试</span></small>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="view.status === 'draft'" (click)="approve(view.batchId)">审批</button>
                  <button mat-stroked-button *ngIf="view.status === 'approved'" (click)="resume(view.batchId)">开始发布</button>
                  <button mat-stroked-button *ngIf="view.status === 'running'" (click)="pause(view.batchId)">暂停</button>
                  <button mat-stroked-button *ngIf="view.status === 'paused'" (click)="resume(view.batchId)">继续</button>
                  <button mat-stroked-button *ngIf="view.status !== 'completed' && view.status !== 'rolled_back'" (click)="changeChecksum(view.batchId)">变更校验码</button>
                  <button mat-flat-button color="warn" [disabled]="view.status === 'completed' || view.status === 'rolled_back'" (click)="rollback(view.batchId)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>待核实回执（校验码对不上，不计入已装台数、不推进档位）</mat-card-title></mat-card-header>
        <mat-card-content>
          <div class="pending-list" *ngIf="(mismatch$ | async)?.length; else emptyMismatch">
            <div class="pending" *ngFor="let item of mismatch$ | async">
              <div><b>{{ item.deviceId }}</b><small>批次 {{ item.batchId }} · 上报版本 {{ item.reportedVersion }}</small><small>校验码 {{ item.checksum }} · {{ item.operator }} · {{ item.reportedAt | date:'MM-dd HH:mm:ss' }}</small></div>
              <button mat-stroked-button color="primary" (click)="reverify(item.batchId, item.deviceId)">重新下发正确包</button>
            </div>
          </div>
          <ng-template #emptyMismatch><p class="empty">暂无待核实回执</p></ng-template>
        </mat-card-content>
      </mat-card>

      <section class="two-col">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>回滚任务（仅覆盖校验码对得上的设备）</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="task-list" *ngIf="(rollbackTasks$ | async)?.length; else emptyTasks">
              <div class="task" *ngFor="let task of rollbackTasks$ | async">
                <div><b>{{ task.deviceId }}</b><small>批次 {{ task.batchId }} · 第 {{ task.attempts }} 次<ng-container *ngIf="task.lastError"> · {{ task.lastError }}</ng-container></small></div>
                <div class="task-actions">
                  <mat-chip [color]="taskColor(task.status)" highlighted>{{ task.status }}</mat-chip>
                  <button mat-stroked-button color="warn" *ngIf="task.status === 'failed'" (click)="retryRollback(task.batchId, task.deviceId)">按设备重试</button>
                </div>
              </div>
            </div>
            <ng-template #emptyTasks><p class="empty">暂无回滚任务</p></ng-template>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>回执台账（同一设备只留最新一条）</mat-card-title></mat-card-header>
          <mat-card-content>
            <div class="receipt-list">
              <div class="receipt" *ngFor="let item of (receipts$ | async)?.slice(0, 50)">
                <div><b>{{ item.deviceId }}</b><small>批次 {{ item.batchId }} · {{ item.reportedVersion }} · {{ item.installResult }}</small><small>校验码 {{ item.checksum }} · {{ item.operator }} · {{ item.reportedAt | date:'MM-dd HH:mm:ss' }}</small></div>
                <mat-chip [color]="receiptColor(item.reconciliation)" highlighted>{{ item.reconciliation }}</mat-chip>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>值班员提交回执（模拟现场上报，校验码随实际上报内容对账）</mat-card-title></mat-card-header>
        <mat-card-content class="form-grid">
          <mat-form-field><mat-label>发布批次</mat-label><mat-select [(ngModel)]="receiptDraft.batchId"><mat-option *ngFor="let batch of batches$ | async" [value]="batch.id">{{ batch.name }}</mat-option></mat-select></mat-form-field>
          <mat-form-field><mat-label>设备编号(留空自动分配)</mat-label><input matInput [(ngModel)]="receiptDraft.deviceId" [placeholder]="nextDeviceId()"></mat-form-field>
          <mat-form-field><mat-label>实际安装包校验码(留空用批次登记码)</mat-label><input matInput [(ngModel)]="receiptDraft.checksum" [placeholder]="batchChecksum()"></mat-form-field>
          <mat-form-field><mat-label>安装结果</mat-label><mat-select [(ngModel)]="receiptDraft.installResult"><mat-option value="success">success</mat-option><mat-option value="failed">failed</mat-option></mat-select></mat-form-field>
          <div class="form-actions"><button mat-flat-button color="primary" (click)="submitReceipt()">提交回执</button></div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; align-items:start; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .form-actions { grid-column:1 / -1; display:flex; gap:12px; justify-content:flex-end; align-items:center }
    .viewport { height:640px; } .batch { min-height:200px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:8px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .checksums mat-chip { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; } .tiers { display:flex; gap:6px; flex-wrap:wrap } .tiers mat-chip { font-size:11px; }
    .rollback-progress { display:grid; gap:4px } .warn { color:#c62828; }
    .pending-list,.task-list,.receipt-list { display:grid; gap:8px; max-height:320px; overflow:auto } .pending,.task,.receipt { display:flex; justify-content:space-between; gap:12px; align-items:center; border-bottom:1px solid #e5ecee; padding:8px 4px } .pending b,.task b,.receipt b { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px } .pending div,.task div,.receipt div { display:grid; gap:2px } .task-actions { display:flex; gap:8px; align-items:center } .empty { color:#90a4ae; margin:8px 0 }
    .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; align-items:start }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.two-col{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly batchViews$ = this.store.select(selectBatchViews);
  readonly audits$ = this.store.select(selectAudits);
  readonly mismatch$ = this.store.select(selectMismatchReceipts);
  readonly receipts$ = this.store.select(selectReceipts);
  readonly rollbackTasks$ = this.store.select(selectRollbackTasks);
  readonly installedTotal$ = this.store.select(selectInstalledTotal);
  private timer?: number;
  private latestBatches: ReleaseBatch[] = [];
  private latestReceipts: DeviceReceipt[] = [];
  draft = { name: '', firmware: '3.0.0', packageChecksum: '', rollbackVersion: '2.9.2', rollbackChecksum: '', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };
  receiptDraft = { batchId: '', deviceId: '', checksum: '', installResult: 'success' as 'success' | 'failed' };

  ngOnInit() {
    this.regenerateChecksums();
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectRelease).subscribe((state) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)));
    this.store.select(selectBatches).subscribe((batches) => { this.latestBatches = batches; if (!this.receiptDraft.batchId && batches.length) this.receiptDraft.batchId = batches[0].id; });
    this.store.select(selectReceipts).subscribe((receipts) => this.latestReceipts = receipts);
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  nextDeviceId(): string {
    const batch = this.latestBatches.find((b) => b.id === this.receiptDraft.batchId);
    if (!batch) return '';
    return `${batch.id}-d${this.latestReceipts.filter((r) => r.batchId === batch.id).length}`;
  }
  batchChecksum(): string {
    return this.latestBatches.find((b) => b.id === this.receiptDraft.batchId)?.packageChecksum ?? '';
  }

  regenerateChecksums() {
    this.draft = { ...this.draft, packageChecksum: generateChecksum(), rollbackChecksum: generateChecksum() };
  }
  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const input: ReleaseBatchInput = {
      name: this.draft.name,
      firmware: this.draft.firmware,
      packageChecksum: this.draft.packageChecksum || generateChecksum(),
      rollbackVersion: this.draft.rollbackVersion,
      rollbackChecksum: this.draft.rollbackChecksum || generateChecksum(),
      groupId: this.draft.groupId,
      rolloutPercent: Number(this.draft.rolloutPercent) || 10,
      failureThreshold: Number(this.draft.failureThreshold) || 3
    };
    this.store.dispatch(createBatch({ batch: input }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  reverify(batchId: string, deviceId: string) { this.store.dispatch(reverifyDevice({ batchId, deviceId, actor: '值班人员' })); }
  retryRollback(batchId: string, deviceId: string) { this.store.dispatch(retryRollback({ batchId, deviceId, actor: '值班人员' })); }
  changeChecksum(batchId: string) { this.store.dispatch(changePackageChecksum({ batchId, checksum: generateChecksum(), actor: '发布负责人' })); }

  submitReceipt() {
    const batch = this.latestBatches.find((b) => b.id === this.receiptDraft.batchId);
    if (!batch) return;
    const checksum = this.receiptDraft.checksum.trim() || batch.packageChecksum;
    const deviceId = this.receiptDraft.deviceId.trim() || `${batch.id}-d${this.latestReceipts.filter((r) => r.batchId === batch.id).length}`;
    const deviceIndex = Number(deviceId.split('-d')[1]) || 0;
    const receipt: DeviceReceipt = {
      id: crypto.randomUUID(),
      deviceId,
      batchId: batch.id,
      deviceIndex,
      checksum,
      reportedVersion: batch.firmware,
      installResult: this.receiptDraft.installResult,
      reconciliation: 'mismatch',
      reportedAt: new Date().toISOString(),
      operator: '值班员'
    };
    this.store.dispatch(reportReceipt({ receipt }));
    this.receiptDraft = { ...this.receiptDraft, deviceId: '', checksum: '' };
  }

  batchColor(status: string): string {
    if (status === 'paused' || status === 'rolled_back') return 'warn';
    if (status === 'completed') return 'accent';
    if (status === 'running' || status === 'approved') return 'primary';
    return '';
  }
  tierColor(status: string): string {
    if (status === 'done') return 'primary';
    if (status === 'active') return 'accent';
    return '';
  }
  receiptColor(status: string): string {
    if (status === 'verified') return 'primary';
    if (status === 'mismatch') return 'warn';
    return '';
  }
  taskColor(status: string): string {
    if (status === 'succeeded') return 'primary';
    if (status === 'failed') return 'warn';
    return '';
  }
}
