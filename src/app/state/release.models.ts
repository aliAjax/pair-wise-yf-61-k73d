export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 单个灰度档位：只有上一档已装台数达标才会进入下一档 */
export type StageStatus = 'pending' | 'active' | 'done';

/** 回执与本批登记校验码对账后的状态 */
export type ReceiptState = 'verified' | 'pending_verification' | 'invalidated';

/** 回滚指令对单台设备的执行结果 */
export type RollbackDeviceState = 'queued' | 'reported' | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface RolloutStage {
  /** 占分组总量的累计比例，如 10/30/100 */
  percent: number;
  /** 该档实际下发时下发包的校验码；未下发的档位为空，改包后按新包重算 */
  checksum: string | null;
  status: StageStatus;
}

export interface DeviceReceipt {
  id: string;
  batchId: string;
  deviceId: string;
  /** 设备实际装上的那份包的版本与校验码（可能是绕过控制台手刷的包） */
  packageVersion: string;
  checksum: string;
  state: ReceiptState;
  reporter: string;
  receivedAt: string;
  /** 同一设备后到的回执覆盖旧回执时，旧条目标记作废原因 */
  note?: string;
}

export interface RollbackTarget {
  deviceId: string;
  checksum: string;
  state: RollbackDeviceState;
  attempts: number;
  lastError?: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  /** 本批发布包的校验码，发布（进入发布中）时登记；改动后旧回执当场作废 */
  packageChecksum: string;
  rollbackVersion: string;
  rollbackChecksum: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  stages: RolloutStage[];
  failed: number;
  /** 回执全局先后序号，两名值班员同刻提交时按后到（序号更大）为准 */
  seq: number;
  rollbackStartedAt?: string;
  rollbackReport: RollbackTarget[];
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
  audits: AuditEntry[];
}
