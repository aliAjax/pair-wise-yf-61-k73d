import type { DeviceGroup, DeviceReceipt, ReleaseBatch, RolloutStage } from './release.models';

/** 三档灰度：1/3 比例、2/3 比例、目标比例 */
const STAGE_FRACTIONS = [1 / 3, 2 / 3, 1];

export function buildStages(rolloutPercent: number): RolloutStage[] {
  const percents: number[] = [];
  for (const fraction of STAGE_FRACTIONS) {
    const percent = Math.max(1, Math.min(100, Math.round(rolloutPercent * fraction)));
    if (percents.indexOf(percent) === -1) percents.push(percent);
  }
  return percents.map((percent) => ({ percent, checksum: null, status: 'pending' as const }));
}

export function stageTarget(groupCount: number, percent: number): number {
  return Math.round(groupCount * percent / 100);
}

export function activeStage(batch: ReleaseBatch): RolloutStage | undefined {
  return batch.stages.find((stage) => stage.status === 'active');
}

/** 当前对账通过（已装）的回执：同一设备只算最新一条，待核实/已作废不计 */
export function verifiedReceipts(batch: ReleaseBatch, receipts: DeviceReceipt[]): DeviceReceipt[] {
  const latest = new Map<string, DeviceReceipt>();
  for (const receipt of receipts) {
    if (receipt.batchId !== batch.id || receipt.state !== 'verified') continue;
    const prev = latest.get(receipt.deviceId);
    if (!prev || receipt.receivedAt > prev.receivedAt) latest.set(receipt.deviceId, receipt);
  }
  return [...latest.values()];
}

export function pendingReceipts(batch: ReleaseBatch, receipts: DeviceReceipt[]): DeviceReceipt[] {
  return receipts.filter((receipt) => receipt.batchId === batch.id && receipt.state === 'pending_verification');
}

export function batchReceipts(batchId: string, receipts: DeviceReceipt[]): DeviceReceipt[] {
  return receipts.filter((receipt) => receipt.batchId === batchId);
}

export interface BatchView {
  batch: ReleaseBatch;
  group?: DeviceGroup;
  verifiedCount: number;
  pendingCount: number;
  invalidatedCount: number;
  activeTarget: number;
  finalTarget: number;
  progress: number;
  rollbackMatched: number;
  rollbackDone: number;
  rollbackFailed: number;
}

export function viewOf(batch: ReleaseBatch, groups: DeviceGroup[], receipts: DeviceReceipt[]): BatchView {
  const group = groups.find((item) => item.id === batch.groupId);
  const groupCount = group?.count ?? 0;
  const verified = verifiedReceipts(batch, receipts);
  const all = batchReceipts(batch.id, receipts);
  const active = activeStage(batch);
  const lastStage = batch.stages[batch.stages.length - 1];
  const finalTarget = lastStage ? stageTarget(groupCount, lastStage.percent) : 0;
  const activeTarget = active ? stageTarget(groupCount, active.percent) : finalTarget;
  return {
    batch,
    group,
    verifiedCount: verified.length,
    pendingCount: all.filter((receipt) => receipt.state === 'pending_verification').length,
    invalidatedCount: all.filter((receipt) => receipt.state === 'invalidated').length,
    activeTarget,
    finalTarget,
    progress: finalTarget ? Math.min(100, Math.round(verified.length / finalTarget * 100)) : 0,
    rollbackMatched: batch.rollbackReport.length,
    rollbackDone: batch.rollbackReport.filter((item) => item.state === 'reported').length,
    rollbackFailed: batch.rollbackReport.filter((item) => item.state === 'failed').length
  };
}

export function shortChecksum(checksum: string | null | undefined): string {
  return checksum ? checksum.slice(0, 8) : '—';
}

export function makeChecksum(version: string): string {
  const seed = `${version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const noise = Math.random().toString(16).slice(2, 12).padEnd(12, '0');
  return `${hash.toString(16).padStart(8, '0')}${noise}`;
}
