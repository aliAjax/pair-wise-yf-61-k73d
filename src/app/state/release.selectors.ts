import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectRollbackTasks = createSelector(selectRelease, (state) => state.rollbackTasks);

/** 待核实回执：校验码与批次登记包对不上，不计入已装台数 */
export const selectMismatchReceipts = createSelector(selectReceipts, (receipts) =>
  receipts.filter((r) => r.reconciliation === 'mismatch')
);

export const selectReceiptsForBatch = (batchId: string) =>
  createSelector(selectReceipts, (receipts) => receipts.filter((r) => r.batchId === batchId));

export const selectRollbackTasksForBatch = (batchId: string) =>
  createSelector(selectRollbackTasks, (tasks) => tasks.filter((t) => t.batchId === batchId));

export interface BatchView {
  batchId: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  packageChecksum: string;
  rollbackChecksum: string;
  status: string;
  progress: number;
  /** 已装台数（含校验码改动后保留的历史结果） */
  installedTotal: number;
  downloaded: number;
  preservedInstalled: number;
  failed: number;
  mismatch: number;
  tierCount: number;
  currentTier: number;
  tiers: { index: number; percent: number; target: number; status: string }[];
  rollbackTotal: number;
  rollbackSucceeded: number;
  rollbackFailed: number;
  checksumChangedAt?: string;
}

/** 批次对账视图：把回执、回滚任务按批次汇总成已装/待核实/回滚进度 */
export const selectBatchViews = createSelector(selectBatches, selectReceipts, selectRollbackTasks, (batches, receipts, tasks): BatchView[] =>
  batches.map((batch) => {
    const batchReceipts = receipts.filter((r) => r.batchId === batch.id);
    const mismatch = batchReceipts.filter((r) => r.reconciliation === 'mismatch').length;
    const batchTasks = tasks.filter((t) => t.batchId === batch.id);
    return {
      batchId: batch.id,
      name: batch.name,
      firmware: batch.firmware,
      rollbackVersion: batch.rollbackVersion,
      packageChecksum: batch.packageChecksum,
      rollbackChecksum: batch.rollbackChecksum,
      status: batch.status,
      progress: batch.progress,
      installedTotal: batch.preservedInstalled + batch.downloaded,
      downloaded: batch.downloaded,
      preservedInstalled: batch.preservedInstalled,
      failed: batch.failed,
      mismatch,
      tierCount: batch.tiers.length,
      currentTier: batch.currentTier,
      tiers: batch.tiers.map((tier) => ({ index: tier.index, percent: tier.percent, target: tier.target, status: tier.status })),
      rollbackTotal: batchTasks.length,
      rollbackSucceeded: batchTasks.filter((t) => t.status === 'succeeded').length,
      rollbackFailed: batchTasks.filter((t) => t.status === 'failed').length,
      checksumChangedAt: batch.checksumChangedAt
    };
  })
);

/** 全批次已装台数合计（含校验码改动后保留的历史结果） */
export const selectInstalledTotal = createSelector(selectBatchViews, (views) =>
  views.reduce((sum, view) => sum + view.installedTotal, 0)
);
