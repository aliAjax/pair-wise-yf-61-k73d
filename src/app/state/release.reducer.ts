import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, DeviceReceipt, ReleaseBatch, ReleaseState, RollbackTask, RollbackTaskStatus, RolloutTier } from './release.models';
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
} from './release.actions';
import { generateChecksum } from './checksum';
import {
  applyChecksumChange,
  buildRollbackTasks,
  buildTiers,
  countMismatch,
  dedupeReceipts,
  hasReceipt,
  normalizeReceipt,
  reconcile,
  tierIndexOf
} from './release.logic';

export const STORAGE_KEY = 'firmware-release-v2';

function audit(audits: AuditEntry[], actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...audits];
}

function buildInitialState(): ReleaseState {
  const now = new Date().toISOString();
  const groups: DeviceGroup[] = [
    { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
    { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
    { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
  ];
  const demoTiers = buildTiers(20, 680);
  const batches: ReleaseBatch[] = [
    {
      id: 'batch-demo',
      name: '边缘网关安全补丁 2.8.1',
      firmware: '2.8.1',
      packageChecksum: 'sha256:9f2c1a7e3b4d5e6f708192a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192',
      rollbackVersion: '2.7.9',
      rollbackChecksum: 'sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80',
      groupId: 'g-edge',
      rolloutPercent: 20,
      failureThreshold: 5,
      status: 'approved',
      progress: 0,
      downloaded: 0,
      failed: 0,
      preservedInstalled: 0,
      preservedByTier: demoTiers.map(() => 0),
      tiers: demoTiers,
      currentTier: 0,
      updatedAt: now
    }
  ];
  const audits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批，包校验码已登记' }];
  return { groups, batches, receipts: [], rollbackTasks: [], audits };
}

function loadState(): ReleaseState {
  const fallback = buildInitialState();
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReleaseState>;
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.batches)) return fallback;
    return {
      groups: parsed.groups,
      batches: parsed.batches,
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
      rollbackTasks: Array.isArray(parsed.rollbackTasks) ? parsed.rollbackTasks : [],
      audits: Array.isArray(parsed.audits) ? parsed.audits : []
    };
  } catch {
    return fallback;
  }
}

const initialState = loadState();

/** 遥测模拟：现场偶尔有人绕过控制台手工刷包（校验码对不上，仍上报成功） */
function simulateReceipt(batch: ReleaseBatch, deviceIndex: number, now: string): DeviceReceipt {
  const manualFlash = Math.random() < 0.12;
  const installFailed = !manualFlash && Math.random() < 0.08;
  const checksum = manualFlash ? generateChecksum() : batch.packageChecksum;
  return {
    id: crypto.randomUUID(),
    deviceId: `${batch.id}-d${deviceIndex}`,
    batchId: batch.id,
    deviceIndex,
    checksum,
    reportedVersion: batch.firmware,
    installResult: installFailed ? 'failed' : 'success',
    reconciliation: 'mismatch', // 由 logic 按登记校验码重新判定
    reportedAt: now,
    operator: manualFlash ? '现场手工刷包' : '遥测设备'
  };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch: input }) => {
    const group = state.groups.find((item) => item.id === input.groupId);
    const groupCount = group?.count ?? 0;
    const tiers = buildTiers(input.rolloutPercent, groupCount);
    const now = new Date().toISOString();
    const batch: ReleaseBatch = {
      ...input,
      id: crypto.randomUUID(),
      status: 'draft',
      progress: 0,
      downloaded: 0,
      failed: 0,
      preservedInstalled: 0,
      preservedByTier: tiers.map(() => 0),
      tiers,
      currentTier: 0,
      updatedAt: now
    };
    return {
      ...state,
      batches: [batch, ...state.batches],
      audits: audit(state.audits, '发布负责人', `创建批次 ${batch.name}，已登记包校验码 ${input.packageChecksum}`)
    };
  }),
  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state.audits, actor, `批次 ${id} 审批通过`)
  })),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state.audits, actor, `批次 ${id} 已暂停`)
  })),
  on(resumeBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state.audits, actor, `批次 ${id} 恢复发布`)
  })),
  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const now = new Date().toISOString();
    const tasks = buildRollbackTasks(batch, state.receipts, now);
    const mismatchCount = countMismatch(state.receipts, id);
    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? { ...item, status: 'rolled_back', updatedAt: now } : item)),
      rollbackTasks: [...state.rollbackTasks.filter((task) => task.batchId !== id), ...tasks],
      audits: audit(
        state.audits,
        actor,
        `批次 ${id} 已紧急回滚：仅覆盖 ${tasks.length} 台校验一致设备（回滚包校验码 ${batch.rollbackChecksum}），${mismatchCount} 台待核实设备未纳入回滚`
      )
    };
  }),
  on(reportReceipt, (state, { receipt }) => {
    const batch = state.batches.find((item) => item.id === receipt.batchId);
    if (!batch) return state;
    const normalized = normalizeReceipt(batch, receipt);
    const existed = hasReceipt(state.receipts, normalized.deviceId, normalized.batchId);
    const receipts = dedupeReceipts(state.receipts, normalized);
    const batches = state.batches.map((item) => (item.id === batch.id ? reconcile({ ...item, updatedAt: new Date().toISOString() }, receipts) : item));
    let audits = state.audits;
    if (existed) audits = audit(audits, normalized.operator, `设备 ${normalized.deviceId} 重复上报，已覆盖为最新一条（后到优先）`);
    if (normalized.reconciliation === 'mismatch') {
      audits = audit(
        audits,
        normalized.operator,
        `设备 ${normalized.deviceId} 回执校验码 ${normalized.checksum} 与批次登记 ${batch.packageChecksum} 不一致，列入待核实，不计入已装台数、不推进档位`
      );
    }
    return { ...state, batches, receipts, audits };
  }),
  on(reverifyDevice, (state, { batchId, deviceId, actor }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    const existing = state.receipts.find((r) => r.batchId === batchId && r.deviceId === deviceId);
    if (!batch || !existing) return state;
    const now = new Date().toISOString();
    const receipt: DeviceReceipt = {
      ...existing,
      checksum: batch.packageChecksum,
      reportedVersion: batch.firmware,
      installResult: 'success',
      reconciliation: 'verified',
      reportedAt: now,
      operator: actor
    };
    const receipts = state.receipts.map((r) => (r.batchId === batchId && r.deviceId === deviceId ? receipt : r));
    const batches = state.batches.map((item) => (item.id === batchId ? reconcile({ ...item, updatedAt: now }, receipts) : item));
    return {
      ...state,
      batches,
      receipts,
      audits: audit(state.audits, actor, `设备 ${deviceId} 已按正确包重新下发，回执校验码 ${batch.packageChecksum} 对账一致，计入已装台数`)
    };
  }),
  on(retryRollback, (state, { batchId, deviceId, actor }) => {
    const now = new Date().toISOString();
    const rollbackTasks = state.rollbackTasks.map((task) =>
      task.batchId === batchId && task.deviceId === deviceId && task.status === 'failed'
        ? { ...task, status: 'pending' as RollbackTaskStatus, attempts: task.attempts + 1, updatedAt: now }
        : task
    );
    const attempts = rollbackTasks.find((t) => t.batchId === batchId && t.deviceId === deviceId)?.attempts ?? 1;
    return {
      ...state,
      rollbackTasks,
      audits: audit(state.audits, actor, `设备 ${deviceId} 回滚上报失败，已按设备重试（第 ${attempts} 次）`)
    };
  }),
  on(changePackageChecksum, (state, { batchId, checksum, actor }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) return state;
    const now = new Date().toISOString();
    const result = applyChecksumChange(batch, state.receipts, checksum, now);
    const batches = state.batches.map((item) => (item.id === batchId ? result.batch : item));
    return {
      ...state,
      batches,
      receipts: result.receipts,
      audits: audit(
        state.audits,
        actor,
        `批次 ${batchId} 包校验码变更为 ${checksum}：旧回执当场作废，${result.voidedCount} 台已装好结果保留，未下发档位按新包校验码重算`
      )
    };
  }),
  on(telemetryTick, (state) => {
    const now = new Date().toISOString();
    let receipts = [...state.receipts];
    let audits = state.audits;
    let rollbackTasks = [...state.rollbackTasks];

    // 1) 运行中的批次：按档位下发设备并产生回执（校验码随实际上报内容对账）
    for (const batch of state.batches) {
      if (batch.status !== 'running') continue;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const groupCount = group?.count ?? 0;
      const delivered = receipts.filter((r) => r.batchId === batch.id).length;
      const activeTier = batch.tiers.find((tier) => tier.status === 'active');
      if (!activeTier) continue;
      const verifiedInTier =
        receipts.filter((r) => r.batchId === batch.id && r.reconciliation === 'verified' && r.installResult === 'success' && tierIndexOf(batch.tiers, r.deviceIndex) === activeTier.index).length +
        (batch.preservedByTier[activeTier.index] ?? 0);
      // 已达本档目标则不再下发；每 tick 最多下发 4 台
      if (verifiedInTier >= activeTier.target) continue;
      const toDeliver = Math.min(4, groupCount - delivered);
      for (let k = 0; k < toDeliver; k++) {
        const deviceIndex = delivered + k;
        if (deviceIndex >= groupCount) break;
        const receipt = simulateReceipt(batch, deviceIndex, now);
        const normalized = normalizeReceipt(batch, receipt);
        receipts.push(normalized);
        if (normalized.reconciliation === 'mismatch') {
          audits = audit(audits, normalized.operator, `设备 ${normalized.deviceId} 回执校验码不一致，列入待核实，不计入已装台数`);
        }
      }
    }

    let batches = state.batches.map((batch) => {
      const next = reconcile(batch, receipts);
      // 失败率超阈值自动暂停
      if (next.status === 'running' && batch.status === 'running') {
        const downloaded = next.downloaded;
        const failed = next.failed;
        const failureRate = downloaded + failed ? failed / (downloaded + failed) * 100 : 0;
        if (failureRate > batch.failureThreshold) return { ...next, status: 'paused' as const };
      }
      return next;
    });
    const autoPaused = batches.some((next, i) => next.status === 'paused' && state.batches[i]?.status === 'running');
    if (autoPaused) audits = audit(audits, '系统', '失败率超过阈值，已自动暂停发布');

    // 2) 回滚中的批次：逐台处理回滚任务，失败的等待按设备重试
    for (const batch of batches) {
      if (batch.status !== 'rolled_back') continue;
      const tasks = rollbackTasks.filter((task) => task.batchId === batch.id && task.status === 'pending');
      for (const task of tasks.slice(0, 3)) {
        const failed = Math.random() < 0.18;
        rollbackTasks = rollbackTasks.map((item) =>
          item.batchId === task.batchId && item.deviceId === task.deviceId
            ? { ...item, status: failed ? 'failed' : 'succeeded', attempts: item.attempts + 1, lastError: failed ? '回滚上报超时' : undefined, updatedAt: now }
            : item
        );
      }
    }

    return { ...state, batches, receipts, rollbackTasks, audits };
  })
);
