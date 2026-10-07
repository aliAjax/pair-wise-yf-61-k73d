import { createAction, props } from '@ngrx/store';
import type { ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());

/** 改动发布包：新校验码登记，未下发档位按新包重算，旧回执当场作废，已装结果保留 */
export const changeChecksum = createAction(
  '[Release] Change package checksum',
  props<{ id: string; packageChecksum: string; firmware: string; actor: string }>()
);

/** 设备（或值班员手工）上报回执，带设备实际安装那份包的校验码 */
export const reportReceipt = createAction(
  '[Release] Report device receipt',
  props<{ batchId: string; deviceId: string; packageVersion: string; checksum: string; reporter: string; receivedAt?: string }>()
);

/** 紧急回滚：只覆盖校验码对得上的设备 */
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());

/** 回滚执行结果按设备上报；失败后只重试未成功的设备 */
export const reportRollbackResult = createAction(
  '[Release] Report rollback result',
  props<{ batchId: string; deviceId: string; success: boolean; error?: string }>()
);
export const retryRollback = createAction('[Release] Retry failed rollback devices', props<{ batchId: string; actor: string }>());

export const telemetryTick = createAction('[Release] Telemetry tick');
