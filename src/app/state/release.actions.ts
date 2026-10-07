import { createAction, props } from '@ngrx/store';
import type { DeviceReceipt, ReleaseBatch, ReleaseBatchInput } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatchInput }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const telemetryTick = createAction('[Release] Telemetry tick');

/** 设备上报回执（携带实际安装包校验码）；对账状态由 reducer 按批次登记校验码判定 */
export const reportReceipt = createAction('[Release] Report receipt', props<{ receipt: DeviceReceipt }>());

/** 对待核实设备重新下发正确的包，回执按新包校验码重新对账 */
export const reverifyDevice = createAction('[Release] Reverity device', props<{ batchId: string; deviceId: string; actor: string }>());

/** 回滚上报失败后，按单台设备重试 */
export const retryRollback = createAction('[Release] Retry rollback', props<{ batchId: string; deviceId: string; actor: string }>());

/** 固件包校验码改动：旧回执作废，未下发档位按新包重算，已装好结果保留 */
export const changePackageChecksum = createAction('[Release] Change package checksum', props<{ batchId: string; checksum: string; actor: string }>());
