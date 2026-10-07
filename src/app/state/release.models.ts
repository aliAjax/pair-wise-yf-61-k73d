export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 回执对账状态：verified 校验一致 / mismatch 待核实 / void 已作废 */
export type ReceiptReconciliation = 'verified' | 'mismatch' | 'void';

/** 单台设备回滚任务状态 */
export type RollbackTaskStatus = 'pending' | 'succeeded' | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

/** 发布档位：按灰度比例累计的一个下发批次 */
export interface RolloutTier {
  index: number;
  /** 累计下发比例 % */
  percent: number;
  /** 累计目标台数 */
  target: number;
  status: 'pending' | 'active' | 'done';
}

/** 设备回执：携带设备实际安装包的校验码，用于和批次登记的包校验码对账 */
export interface DeviceReceipt {
  id: string;
  deviceId: string;
  batchId: string;
  /** 设备在批次中的顺序号，用于归属档位 */
  deviceIndex: number;
  /** 设备实际安装的那份包的校验码 */
  checksum: string;
  reportedVersion: string;
  installResult: 'success' | 'failed';
  reconciliation: ReceiptReconciliation;
  reportedAt: string;
  operator: string;
}

/** 单台设备的回滚任务：回滚只覆盖校验码对得上的设备 */
export interface RollbackTask {
  deviceId: string;
  batchId: string;
  status: RollbackTaskStatus;
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  /** 发布时登记的这一批包的校验码 */
  packageChecksum: string;
  rollbackVersion: string;
  /** 回滚包登记的校验码 */
  rollbackChecksum: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  /** 已装台数：仅统计校验码对得上的成功回执 */
  downloaded: number;
  failed: number;
  /** 校验码改动后保留的历史已装结果数 */
  preservedInstalled: number;
  /** 校验码改动后各档位保留的已装结果数 */
  preservedByTier: number[];
  tiers: RolloutTier[];
  currentTier: number;
  checksumChangedAt?: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  receipts: DeviceReceipt[];
  rollbackTasks: RollbackTask[];
  audits: AuditEntry[];
}

/** 新建批次时表单提交的内容（id、档位等由 reducer 补全） */
export type ReleaseBatchInput = Pick<
  ReleaseBatch,
  'name' | 'firmware' | 'packageChecksum' | 'rollbackVersion' | 'rollbackChecksum' | 'groupId' | 'rolloutPercent' | 'failureThreshold'
>;
