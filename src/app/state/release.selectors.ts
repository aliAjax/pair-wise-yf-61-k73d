import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';
import { viewOf, type BatchView } from './release.helpers';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);

export const selectBatchViews = createSelector(selectRelease, (state): BatchView[] =>
  state.batches.map((batch) => viewOf(batch, state.groups, state.receipts))
);

export const selectPendingTotal = createSelector(selectRelease, (state) =>
  state.receipts.filter((receipt) => receipt.state === 'pending_verification').length
);

export function selectReceiptsForBatch(batchId: string) {
  return createSelector(selectRelease, (state) =>
    state.receipts
      .filter((receipt) => receipt.batchId === batchId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, 60)
  );
}
