import '@angular/compiler';
/**
 * 校验码对账规则的离线验证（纯逻辑，不启动 Angular）。
 * 运行：npx tsc --target ES2022 --module commonjs --moduleResolution node --experimentalDecorators --skipLibCheck --outDir .verify-build scripts/verify-reconciliation.ts && node .verify-build/scripts/verify-reconciliation.js
 */
import {
  approveBatch, resumeBatch, reportReceipt,
  rollbackBatch, reportRollbackResult, retryRollback,
  changeChecksum, pauseBatch
} from '../src/app/state/release.actions';
import { releaseReducer } from '../src/app/state/release.reducer';
import { buildStages, makeChecksum } from '../src/app/state/release.helpers';
import type { ReleaseState } from '../src/app/state/release.models';

const t = new Date('2026-10-07T10:00:00.000Z').toISOString();
let passed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { console.error(`✗ ${name} ${detail}`); process.exitCode = 1; }
  else { passed++; console.log(`✓ ${name}`); }
}

function newBatch(): ReleaseState {
  const ck = makeChecksum('3.0.0');
  const rbCk = makeChecksum('2.9.2');
  const batch = {
    id: 'b1', name: '测试批', firmware: '3.0.0', packageChecksum: ck,
    rollbackVersion: '2.9.2', rollbackChecksum: rbCk, groupId: 'g-clinic',
    rolloutPercent: 30, failureThreshold: 50, status: 'draft' as const,
    stages: buildStages(30), failed: 0, seq: 0, rollbackReport: [], updatedAt: t
  };
  let s = releaseReducer(undefined as never, { type: '__init__' } as never);
  s = { ...s, batches: [batch], receipts: [], audits: [] };
  s = releaseReducer(s, approveBatch({ id: 'b1', actor: '负责人' }));
  s = releaseReducer(s, resumeBatch({ id: 'b1', actor: '运维' }));
  return s;
}

function batchOf(s: ReleaseState) { return s.batches[0]; }
function activeChecksum(s: ReleaseState) { return s.batches[0].stages.find((x) => x.status === 'active')?.checksum ?? ''; }

// 1. 校验码对不上 → 待核实，不进档、不计数
{
  let s = newBatch();
  const ck = activeChecksum(s);
  // g-clinic count=310，第一档 10% → 31 台
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'dev-x', packageVersion: '手刷', checksum: 'deadbeef', reporter: '甲', receivedAt: t }));
  const r = s.receipts.find((x) => x.deviceId === 'dev-x')!;
  check('对不上的回执列为待核实', r.state === 'pending_verification');
  check('待核实不激活下一档', batchOf(s).stages.filter((x) => x.status === 'active').length === 1 && batchOf(s).stages[0].status === 'active');
  check('待核实不计入已装台数', !s.receipts.some((x) => x.state === 'verified'));
}

// 2. 校验码对得上 → verified，达标才推进下一档
{
  let s = newBatch();
  const ck = activeChecksum(s);
  for (let i = 1; i <= 31; i++) {
    s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: `d-${i}`, packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  }
  check('第一档达标后推进第二档', batchOf(s).stages[0].status === 'done' && batchOf(s).stages[1].status === 'active');
  check('第二档锁定同一登记校验码', batchOf(s).stages[1].checksum === ck);
}

// 3. 不达标绝不推进
{
  let s = newBatch();
  const ck = activeChecksum(s);
  for (let i = 1; i <= 30; i++) {
    s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: `d-${i}`, packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  }
  check('差一台也不推进下一档', batchOf(s).stages[0].status === 'active');
}

// 4. 同一设备重复上报只留最新一条
{
  let s = newBatch();
  const ck = activeChecksum(s);
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'd-1', packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'd-1', packageVersion: '手刷', checksum: 'ffff', reporter: '乙', receivedAt: t }));
  const current = s.receipts.filter((x) => x.deviceId === 'd-1' && x.state !== 'invalidated');
  check('同设备当前回执只有一条', current.length === 1);
  check('最新一条是后报的乙的待核实', current[0].reporter === '乙' && current[0].state === 'pending_verification');
  check('旧条目标注作废保留', s.receipts.some((x) => x.deviceId === 'd-1' && x.state === 'invalidated'));
}

// 5. 两名值班员同刻提交 → 按后到（序号大）那条算
{
  let s = newBatch();
  const ck = activeChecksum(s);
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'd-9', packageVersion: '甲版', checksum: 'aaaa', reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'd-9', packageVersion: '乙版', checksum: ck, reporter: '乙', receivedAt: t }));
  const current = s.receipts.filter((x) => x.deviceId === 'd-9' && x.state !== 'invalidated');
  check('同刻提交以乙（后到）为准', current[0].reporter === '乙' && current[0].state === 'verified');
}

// 6. 改包：旧回执作废，未下发档位按新包重算，已装结果保留，下一档用新校验码
{
  let s = newBatch();
  const ck = activeChecksum(s);
  for (let i = 1; i <= 31; i++) {
    s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: `d-${i}`, packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  }
  const active2Before = batchOf(s).stages[1];
  check('改包前第二档尚未下发（校验码为登记值，已激活）', active2Before.status === 'active');
  const newCk = makeChecksum('3.1.0');
  s = releaseReducer(s, changeChecksum({ id: 'b1', firmware: '3.1.0', packageChecksum: newCk, actor: '负责人' }));
  const b = batchOf(s);
  check('旧回执全部当场作废', s.receipts.every((x) => x.batchId !== 'b1' || x.state === 'invalidated'));
  const active = b.stages.find((x) => x.status === 'active')!;
  check('激活档位按新包校验码下发', active.checksum === newCk);
  check('未下发档位校验码清空等待重算', b.stages.filter((x) => x.status === 'pending').every((x) => x.checksum === null));
  check('第一档封档保留（done，锁旧码）', b.stages[0].status === 'done' && b.stages[0].checksum === ck);
  // 已装结果保留：回滚候选仍覆盖第一档 31 台
  s = releaseReducer(s, rollbackBatch({ id: 'b1', actor: '负责人' }));
  check('改包后已装设备仍按旧码被回滚覆盖', batchOf(s).rollbackReport.length === 31);
}

// 7. 回滚只覆盖校验码对得上的设备
{
  let s = newBatch();
  const ck = activeChecksum(s);
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'ok-1', packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'ok-2', packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'bad-1', packageVersion: '手刷', checksum: 'beefbeef', reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, rollbackBatch({ id: 'b1', actor: '负责人' }));
  const ids = batchOf(s).rollbackReport.map((x) => x.deviceId).sort();
  check('回滚只含两台校验码匹配设备', ids.length === 2 && ids.includes('ok-1') && ids.includes('ok-2'));
  check('待核实设备不被回滚覆盖', !ids.includes('bad-1'));
  check('批次进入回滚状态', batchOf(s).status === 'rolled_back');
}

// 8. 回滚失败后按设备重试，成功设备不重复
{
  let s = newBatch();
  const ck = activeChecksum(s);
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'ok-1', packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: 'ok-2', packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  s = releaseReducer(s, rollbackBatch({ id: 'b1', actor: '负责人' }));
  s = releaseReducer(s, reportRollbackResult({ batchId: 'b1', deviceId: 'ok-1', success: true }));
  s = releaseReducer(s, reportRollbackResult({ batchId: 'b1', deviceId: 'ok-2', success: false, error: '网关超时' }));
  check('单台回滚结果分别记账', batchOf(s).rollbackReport.find((x) => x.deviceId === 'ok-1')!.state === 'reported'
    && batchOf(s).rollbackReport.find((x) => x.deviceId === 'ok-2')!.state === 'failed');
  s = releaseReducer(s, retryRollback({ batchId: 'b1', actor: '值班员' }));
  const ok1 = batchOf(s).rollbackReport.find((x) => x.deviceId === 'ok-1')!;
  const ok2 = batchOf(s).rollbackReport.find((x) => x.deviceId === 'ok-2')!;
  check('重试只重置失败设备，成功设备不动', ok1.state === 'reported' && ok2.state === 'queued' && ok2.attempts === 0);
}

// 9. 暂停期间对账不推进
{
  let s = newBatch();
  const ck = activeChecksum(s);
  s = releaseReducer(s, pauseBatch({ id: 'b1', actor: '甲' }));
  for (let i = 1; i <= 40; i++) {
    s = releaseReducer(s, reportReceipt({ batchId: 'b1', deviceId: `d-${i}`, packageVersion: '3.0.0', checksum: ck, reporter: '甲', receivedAt: t }));
  }
  check('暂停时回执被拒收，档位冻结不动', s.receipts.length === 0 && batchOf(s).stages[0].status === 'active' && batchOf(s).status === 'paused');
}

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
