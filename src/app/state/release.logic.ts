import type { DeviceReceipt, ReleaseBatch, RollbackTask, RolloutTier } from './release.models';

/** 按灰度比例生成累计档位，例如 20% -> [20,40,60,80,100] */
export function buildTiers(rolloutPercent: number, groupCount: number): RolloutTier[] {
  const tiers: RolloutTier[] = [];
  let cum = 0;
  let i = 0;
  const step = Math.max(1, Math.min(100, rolloutPercent));
  while (cum < 100) {
    cum = Math.min(100, cum + step);
    tiers.push({ index: i, percent: cum, target: Math.round(groupCount * cum / 100), status: i === 0 ? 'active' : 'pending' });
    i++;
  }
  return tiers;
}

export function tierIndexOf(tiers: RolloutTier[], deviceIndex: number): number {
  const idx = tiers.findIndex((tier) => deviceIndex < tier.target);
  return idx === -1 ? tiers.length - 1 : idx;
}

/**
 * 依据回执重新结算批次：
 * - 只有校验码与批次登记包校验码一致的成功回执才计入已装台数、推进档位；
 * - 校验不一致的回执列入待核实，不计数、不推进。
 */
export function reconcile(batch: ReleaseBatch, receipts: DeviceReceipt[]): ReleaseBatch {
  const batchReceipts = receipts.filter((r) => r.batchId === batch.id);
  const verified = batchReceipts.filter((r) => r.reconciliation === 'verified');
  const verifiedSuccess = verified.filter((r) => r.installResult === 'success');
  const downloaded = verifiedSuccess.length;
  const failed = verified.filter((r) => r.installResult === 'failed').length;

  const verifiedByTier = batch.tiers.map((tier) =>
    verifiedSuccess.filter((r) => tierIndexOf(batch.tiers, r.deviceIndex) === tier.index).length
  );

  let firstNonDone = -1;
  const tiers: RolloutTier[] = batch.tiers.map((tier, i) => {
    const done = (batch.preservedByTier[i] ?? 0) + (verifiedByTier[i] ?? 0) >= tier.target;
    if (!done && firstNonDone === -1) firstNonDone = i;
    return { ...tier, status: done ? 'done' : 'pending' };
  });
  const currentTier = firstNonDone === -1 ? batch.tiers.length : firstNonDone;
  const delivering = batch.status === 'running' || batch.status === 'paused';
  const nextTiers = tiers.map((tier) =>
    tier.status === 'done' ? tier : { ...tier, status: (delivering && tier.index === currentTier ? 'active' : 'pending') as RolloutTier['status'] }
  );

  const totalTarget = batch.tiers[batch.tiers.length - 1]?.target ?? 0;
  const installedTotal = batch.preservedInstalled + downloaded;
  const progress = totalTarget ? Math.min(100, Math.round(installedTotal / totalTarget * 100)) : 0;
  const failureRate = downloaded + failed ? failed / (downloaded + failed) * 100 : 0;

  let status = batch.status;
  if (status === 'running' || status === 'paused') {
    if (firstNonDone === -1) status = 'completed';
    else if (status === 'running' && failureRate > batch.failureThreshold) status = 'paused';
  }

  return { ...batch, downloaded, failed, tiers: nextTiers, currentTier, progress, status };
}

/** 按批次登记的包校验码判定回执对账状态 */
export function normalizeReceipt(batch: ReleaseBatch, receipt: DeviceReceipt): DeviceReceipt {
  return { ...receipt, reconciliation: receipt.checksum === batch.packageChecksum ? 'verified' : 'mismatch' };
}

/** 同一台设备重复上报只留最新一条：按上报到达顺序，后到的覆盖先到的 */
export function dedupeReceipts(receipts: DeviceReceipt[], normalized: DeviceReceipt): DeviceReceipt[] {
  return [
    ...receipts.filter((r) => !(r.deviceId === normalized.deviceId && r.batchId === normalized.batchId)),
    normalized
  ];
}

export function hasReceipt(receipts: DeviceReceipt[], deviceId: string, batchId: string): boolean {
  return receipts.some((r) => r.deviceId === deviceId && r.batchId === batchId);
}

/** 回滚只覆盖校验码与批次登记包对得上的设备；待核实设备状态不明，不纳入回滚 */
export function buildRollbackTasks(batch: ReleaseBatch, receipts: DeviceReceipt[], now: string): RollbackTask[] {
  return receipts
    .filter((r) => r.batchId === batch.id && r.reconciliation === 'verified' && r.installResult === 'success')
    .map((r) => ({ deviceId: r.deviceId, batchId: batch.id, status: 'pending' as const, attempts: 0, updatedAt: now }));
}

export function countMismatch(receipts: DeviceReceipt[], batchId: string): number {
  return receipts.filter((r) => r.batchId === batchId && r.reconciliation === 'mismatch').length;
}

export interface ChecksumChangeResult {
  batch: ReleaseBatch;
  receipts: DeviceReceipt[];
  /** 已装好结果保留数 */
  preservedInstalled: number;
  /** 按档位保留的已装好结果数 */
  preservedByTier: number[];
  /** 当场作废的旧回执数 */
  voidedCount: number;
}

/**
 * 固件包校验码改动：
 * - 旧回执当场作废；
 * - 还没下发的档位按新包校验码重算；
 * - 已经装好的结果保留。
 */
export function applyChecksumChange(batch: ReleaseBatch, receipts: DeviceReceipt[], checksum: string, now: string): ChecksumChangeResult {
  const batchReceipts = receipts.filter((r) => r.batchId === batch.id);
  const verifiedReceipts = batchReceipts.filter((r) => r.reconciliation === 'verified' && r.installResult === 'success');
  const preservedByTier = batch.tiers.map((tier) => {
    const inTier = verifiedReceipts.filter((r) => tierIndexOf(batch.tiers, r.deviceIndex) === tier.index).length;
    return (batch.preservedByTier[tier.index] ?? 0) + inTier;
  });
  const preservedInstalled = batch.preservedInstalled + verifiedReceipts.length;
  const voided = receipts.map((r) => (r.batchId === batch.id ? { ...r, reconciliation: 'void' as DeviceReceipt['reconciliation'] } : r));
  const updated: ReleaseBatch = {
    ...batch,
    packageChecksum: checksum,
    preservedInstalled,
    preservedByTier,
    downloaded: 0,
    failed: 0,
    checksumChangedAt: now,
    updatedAt: now
  };
  return { batch: reconcile(updated, voided), receipts: voided, preservedInstalled, preservedByTier, voidedCount: verifiedReceipts.length };
}
