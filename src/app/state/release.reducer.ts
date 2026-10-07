import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, DeviceReceipt, ReleaseBatch, ReleaseState, RolloutStage } from './release.models';
import {
  approveBatch,
  changeChecksum,
  createBatch,
  pauseBatch,
  reportReceipt,
  reportRollbackResult,
  resumeBatch,
  retryRollback,
  rollbackBatch,
  telemetryTick
} from './release.actions';
import { activeStage, buildStages, makeChecksum, stageTarget, verifiedReceipts } from './release.helpers';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];

const nowIso = () => new Date().toISOString();
const demoChecksum = makeChecksum('2.8.1');
const rollbackChecksum = makeChecksum('2.7.9');
const initialBatches: ReleaseBatch[] = [
  {
    id: 'batch-demo',
    name: '边缘网关安全补丁 2.8.1',
    firmware: '2.8.1',
    packageChecksum: demoChecksum,
    rollbackVersion: '2.7.9',
    rollbackChecksum,
    groupId: 'g-edge',
    rolloutPercent: 20,
    failureThreshold: 5,
    status: 'approved',
    stages: buildStages(20),
    failed: 0,
    seq: 0,
    rollbackReport: [],
    updatedAt: nowIso()
  }
];
const initialAudits: AuditEntry[] = [
  { id: 'audit-1', at: nowIso(), actor: '运维值班', message: `批次 batch-demo 完成兼容性检查并进入已审批，发布包校验码 ${demoChecksum.slice(0, 8)} 已登记` }
];

const STORAGE_KEY = 'firmware-release-v2';
const fallback: ReleaseState = { groups: initialGroups, batches: initialBatches, receipts: [], audits: initialAudits };
const stored = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
const initialState: ReleaseState = stored && Array.isArray(stored.receipts) ? stored : fallback;

interface IngestInput {
  batch: ReleaseBatch;
  receipts: DeviceReceipt[];
  deviceId: string;
  packageVersion: string;
  checksum: string;
  reporter: string;
  receivedAt: string;
  quiet?: boolean;
}

interface IngestResult {
  batch: ReleaseBatch;
  receipts: DeviceReceipt[];
  messages: string[];
}

/** 回执入账：同一设备只留最新一条；与下发档位校验码对账；达标后才推进下一档 */
function ingestReceipt(input: IngestInput, groupCount: number): IngestResult {
  const { batch } = input;
  const active = activeStage(batch);
  const seq = batch.seq + 1;
  const messages: string[] = [];

  // 同一台设备重复上报：旧条目标注作废后保留，最新一条作为当前回执
  let superseded = false;
  const receipts = input.receipts.map((receipt) => {
    if (receipt.batchId !== batch.id || receipt.deviceId !== input.deviceId || receipt.state === 'invalidated') return receipt;
    superseded = true;
    return { ...receipt, state: 'invalidated' as const, note: '同一设备后到回执覆盖，旧条作废' };
  });

  const matched = active !== undefined && active.checksum !== null && input.checksum === active.checksum;
  const receipt: DeviceReceipt = {
    id: crypto.randomUUID(),
    batchId: batch.id,
    deviceId: input.deviceId,
    packageVersion: input.packageVersion,
    checksum: input.checksum,
    state: matched ? 'verified' : 'pending_verification',
    reporter: input.reporter,
    receivedAt: `${input.receivedAt}#${seq}`
  };
  receipts.push(receipt);

  if (!matched && !input.quiet) {
    messages.push(
      `设备 ${input.deviceId} 上报校验码 ${input.checksum.slice(0, 8)} 与本批登记的 ${(active?.checksum ?? '未下发') .slice(0, 8)} 不符，列为待核实：不推进档位、不计入已装台数`
    );
  } else if (!matched && input.quiet && superseded === false) {
    // 模拟遥测发现手刷包：每个待核实设备只提示一次
    const already = input.receipts.some((item) => item.batchId === batch.id && item.state === 'pending_verification' && item.checksum === input.checksum);
    if (!already) messages.push(`巡检发现设备 ${input.deviceId} 安装的包校验码 ${input.checksum.slice(0, 8)} 不在发布登记内，已列为待核实`);
  }

  // 档位闸门：仅统计对账通过的最新回执；达标一档才放行下一档
  let stages = batch.stages;
  let status = batch.status;
  let guard = 0;
  while (status === 'running' && guard < stages.length + 1) {
    guard += 1;
    const current = stages.find((stage) => stage.status === 'active');
    if (!current) break;
    const installed = verifiedReceipts({ ...batch, stages }, receipts).length;
    const target = stageTarget(groupCount, current.percent);
    if (installed < target) break;
    stages = stages.map((stage) => (stage === current ? { ...stage, status: 'done' as const } : stage));
    const next = stages.find((stage) => stage.status === 'pending');
    if (next) {
      stages = stages.map((stage) => (stage === next ? { ...stage, status: 'active' as const, checksum: batch.packageChecksum } : stage));
      messages.push(`档位 ${current.percent}% 已装 ${installed}/${target} 达标，推进下一档 ${next.percent}%（校验码 ${batch.packageChecksum.slice(0, 8)}）`);
    } else {
      status = 'completed';
      messages.push(`末档 ${current.percent}% 达标（${installed}/${target}），批次发布完成`);
    }
  }

  return {
    batch: { ...batch, stages, status, seq, updatedAt: input.receivedAt.split('#')[0] ?? nowIso() },
    receipts,
    messages
  };
}

/** 改包：关闭当前已下发档位（已装结果保留），未下发档位清空校验码等待按新包重算，旧回执全部作废 */
function applyChecksumChange(batch: ReleaseBatch, packageChecksum: string, firmware: string): { batch: ReleaseBatch; messages: string[] } {
  const messages: string[] = [`发布包校验码改为 ${packageChecksum.slice(0, 8)}（版本 ${firmware}）：旧回执当场作废，未下发档位按新包重算，已装好的结果保留`];
  let stages: RolloutStage[] = batch.stages.map((stage) => {
    if (stage.status === 'pending') return { ...stage, checksum: null };
    return stage;
  });
  // 当前档已经下发过旧包，立即封档：旧包装了多少都作为保留结果，不再用旧回执卡新包
  const active = stages.find((stage) => stage.status === 'active');
  if (active) {
    stages = stages.map((stage) => (stage === active ? { ...stage, status: 'done' as const } : stage));
    messages.push(`当前档 ${active.percent}% 已下发旧包，按已装结果封档保留（锁定校验码 ${active.checksum?.slice(0, 8) ?? '—'}）`);
  }
  let status = batch.status;
  if (status === 'running') {
    const next = stages.find((stage) => stage.status === 'pending');
    if (next) {
      stages = stages.map((stage) => (stage === next ? { ...stage, status: 'active' as const, checksum: packageChecksum } : stage));
      messages.push(`下一档 ${next.percent}% 按新包 ${packageChecksum.slice(0, 8)} 下发`);
    } else {
      status = 'completed';
      messages.push('已无待下发档位，批次按保留结果完成');
    }
  }
  return { batch: { ...batch, firmware, packageChecksum, stages, status, updatedAt: nowIso() }, messages };
}

/** 回滚候选：设备最新安装事实的校验码必须命中本批实际下发过（含已封档）的包 */
function rollbackTargetsOf(batch: ReleaseBatch, receipts: DeviceReceipt[]) {
  const dispatched = new Set(batch.stages.filter((stage) => stage.checksum).map((stage) => stage.checksum as string));
  const latest = new Map<string, DeviceReceipt>();
  for (const receipt of receipts) {
    if (receipt.batchId !== batch.id) continue;
    const prev = latest.get(receipt.deviceId);
    if (!prev || receipt.receivedAt > prev.receivedAt) latest.set(receipt.deviceId, receipt);
  }
  // 旧回执虽已作废，但设备实际装上的那份包是本批登记下发过的，安装结果保留，回滚仍要覆盖；
  // 只有待核实（校验码对不上/来源不明）的设备不在回滚范围内
  return [...latest.values()]
    .filter((receipt) => receipt.state !== 'pending_verification' && dispatched.has(receipt.checksum))
    .map((receipt) => ({ deviceId: receipt.deviceId, checksum: receipt.checksum, state: 'queued' as const, attempts: 0 }));
}

function withAudits(state: ReleaseState, actor: string, messages: string[]): AuditEntry[] {
  if (messages.length === 0) return state.audits;
  const added = messages.map((message) => ({ id: crypto.randomUUID(), at: nowIso(), actor, message }));
  return [...added, ...state.audits];
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => ({
    ...state,
    batches: [batch, ...state.batches],
    audits: withAudits(state, '发布负责人', [`创建批次 ${batch.name}，发布包校验码 ${batch.packageChecksum.slice(0, 8)}、回滚包校验码 ${batch.rollbackChecksum.slice(0, 8)} 已登记`])
  })),
  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id && batch.status === 'draft' ? { ...batch, status: 'approved', updatedAt: nowIso() } : batch)),
    audits: withAudits(state, actor, [`批次 ${id} 审批通过，发布包校验码维持登记值 ${state.batches.find((b) => b.id === id)?.packageChecksum.slice(0, 8) ?? '—'}`])
  })),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) =>
      batch.id === id && (batch.status === 'running') ? { ...batch, status: 'paused', updatedAt: nowIso() } : batch
    ),
    audits: withAudits(state, actor, [`批次 ${id} 已暂停，档位与待核实清单冻结`])
  })),
  on(resumeBatch, (state, { id, actor }) => {
    const target = state.batches.find((batch) => batch.id === id);
    if (!target || (target.status !== 'approved' && target.status !== 'paused')) return state;
    const messages: string[] = [];
    let stages = target.stages;
    if (!stages.some((stage) => stage.status === 'active')) {
      const next = stages.find((stage) => stage.status === 'pending');
      if (next) {
        stages = stages.map((stage) => (stage === next ? { ...stage, status: 'active', checksum: target.packageChecksum } : stage));
        messages.push(`档位 ${next.percent}% 开始下发，校验码 ${target.packageChecksum.slice(0, 8)} 已登记到该档`);
      }
    }
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'running', stages, updatedAt: nowIso() } : batch)),
      audits: withAudits(state, actor, [`批次 ${id} ${target.status === 'approved' ? '开始发布' : '恢复发布'}`, ...messages])
    };
  }),
  on(changeChecksum, (state, { id, packageChecksum, firmware, actor }) => {
    const target = state.batches.find((batch) => batch.id === id);
    if (!target || target.status === 'rolled_back' || !packageChecksum.trim()) return state;
    if (packageChecksum === target.packageChecksum && firmware === target.firmware) return state;
    const { batch, messages } = applyChecksumChange(target, packageChecksum.trim(), firmware.trim() || target.firmware);
    // 旧回执当场作废：记录保留（已装结果保留，供回滚按校验码定位）
    const receipts = state.receipts.map((receipt) =>
      receipt.batchId === id && receipt.state !== 'invalidated'
        ? { ...receipt, state: 'invalidated' as const, note: '发布包校验码改动，旧回执当场作废' }
        : receipt
    );
    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? batch : item)),
      receipts,
      audits: withAudits(state, actor, messages)
    };
  }),
  on(reportReceipt, (state, { batchId, deviceId, packageVersion, checksum, reporter, receivedAt }) => {
    const target = state.batches.find((batch) => batch.id === batchId);
    // 批次冻结（暂停）或不在发布中：不接收回执，档位与待核实清单保持不动
    if (!target || target.status !== 'running') return state;
    const group = state.groups.find((item) => item.id === target.groupId);
    const result = ingestReceipt(
      { batch: target, receipts: [...state.receipts], deviceId: deviceId.trim(), packageVersion, checksum: checksum.trim(), reporter, receivedAt: receivedAt ?? nowIso() },
      group?.count ?? 0
    );
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === batchId ? result.batch : batch)),
      receipts: result.receipts,
      audits: withAudits(state, reporter, [`收到设备 ${deviceId} 回执（实际安装 ${packageVersion} / ${checksum.slice(0, 8)}）`, ...result.messages])
    };
  }),
  on(rollbackBatch, (state, { id, actor }) => {
    const target = state.batches.find((batch) => batch.id === id);
    if (!target || target.status === 'rolled_back') return state;
    const targets = rollbackTargetsOf(target, state.receipts);
    const excluded = new Set(targets.map((item) => item.deviceId));
    const latestByDevice = new Map<string, DeviceReceipt>();
    for (const receipt of state.receipts) {
      if (receipt.batchId !== id) continue;
      const prev = latestByDevice.get(receipt.deviceId);
      if (!prev || receipt.receivedAt > prev.receivedAt) latestByDevice.set(receipt.deviceId, receipt);
    }
    const mismatched = [...latestByDevice.values()].filter((receipt) => !excluded.has(receipt.deviceId)).length;
    const messages = [
      `批次 ${id} 紧急回滚：${targets.length} 台校验码对得上，下发回滚包 ${target.rollbackVersion}（${target.rollbackChecksum.slice(0, 8)}）`,
      ...(mismatched > 0 ? [`${mismatched} 台校验码对不上（待核实/非本批包），本次回滚不覆盖，继续挂待核实`] : [])
    ];
    return {
      ...state,
      batches: state.batches.map((batch) =>
        batch.id === id ? { ...batch, status: 'rolled_back', rollbackStartedAt: nowIso(), rollbackReport: targets, updatedAt: nowIso() } : batch
      ),
      audits: withAudits(state, actor, messages)
    };
  }),
  on(reportRollbackResult, (state, { batchId, deviceId, success, error }) => {
    const target = state.batches.find((batch) => batch.id === batchId);
    if (!target) return state;
    let touched = false;
    const rollbackReport = target.rollbackReport.map((item) => {
      if (item.deviceId !== deviceId || item.state === 'reported') return item;
      touched = true;
      if (success) return { ...item, state: 'reported' as const, attempts: item.attempts + 1, lastError: undefined };
      return { ...item, state: 'failed' as const, attempts: item.attempts + 1, lastError: error ?? '回滚上报失败' };
    });
    if (!touched) return state;
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === batchId ? { ...batch, rollbackReport, updatedAt: nowIso() } : batch)),
      audits: state.audits
    };
  }),
  on(retryRollback, (state, { batchId, actor }) => {
    const target = state.batches.find((batch) => batch.id === batchId);
    if (!target) return state;
    const failed = target.rollbackReport.filter((item) => item.state === 'failed');
    if (failed.length === 0) return state;
    const rollbackReport = target.rollbackReport.map((item) =>
      item.state === 'failed' ? { ...item, state: 'queued' as const, attempts: 0, lastError: undefined } : item
    );
    return {
      ...state,
      batches: state.batches.map((batch) => (batch.id === batchId ? { ...batch, rollbackReport, updatedAt: nowIso() } : batch)),
      audits: withAudits(state, actor, [`回滚重试：${failed.length} 台失败设备按设备重新下发回滚指令`])
    };
  }),
  on(telemetryTick, (state) => {
    let batches = state.batches;
    let receipts = state.receipts;
    let audits = state.audits;
    let thresholdPaused = false;
    let rollbackFinished = false;

    batches = batches.map((batch0) => {
      let batch = batch0;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const groupCount = group?.count ?? 0;

      if (batch.status === 'running') {
        // 安装失败计数沿用失败阈值闸门
        const installed = verifiedReceipts(batch, receipts).length;
        const failed = batch.failed + (Math.random() < 0.05 ? 1 : 0);
        const failureRate = installed + failed > 0 ? failed / (installed + failed) * 100 : 0;
        batch = { ...batch, failed };
        if (failureRate > batch.failureThreshold) {
          batch = { ...batch, status: 'paused', updatedAt: nowIso() };
          thresholdPaused = true;
        } else {
          // 模拟设备回执：每轮 2~3 台，小概率为绕过控制台手刷的包（校验码不符）
          const active = activeStage(batch);
          if (active && active.checksum && installed < stageTarget(groupCount, active.percent)) {
            const used = new Set(receipts.filter((r) => r.batchId === batch.id).map((r) => r.deviceId));
            let cursor = 1;
            const poolIds = [...used];
            for (const id of poolIds) {
              const n = Number(id.replace('dev-', ''));
              if (Number.isFinite(n)) cursor = Math.max(cursor, n);
            }
            const wave = 2 + Math.floor(Math.random() * 2);
            for (let i = 0; i < wave; i++) {
              const deviceId = `dev-${cursor + i + 1}`;
              if (used.has(deviceId)) continue;
              used.add(deviceId);
              const handFlashed = Math.random() < 0.08;
              const result = ingestReceipt(
                {
                  batch,
                  receipts,
                  deviceId,
                  packageVersion: handFlashed ? '手工刷机包' : batch.firmware,
                  checksum: handFlashed ? makeChecksum(`bypass-${deviceId}`) : active.checksum,
                  reporter: '设备遥测',
                  receivedAt: nowIso(),
                  quiet: true
                },
                groupCount
              );
              batch = result.batch;
              receipts = result.receipts;
              if (result.messages.length > 0) {
                audits = withAudits({ ...state, audits }, '巡检', result.messages);
              }
              if (batch.status !== 'running') break;
            }
          }
        }
      }

      // 回滚按设备执行：失败的留在队列里，稍后按设备重试
      if (batch.status === 'rolled_back' && batch.rollbackReport.some((item) => item.state === 'queued')) {
        let changed = false;
        const rollbackReport = batch.rollbackReport.map((item) => {
          if (item.state !== 'queued' || item.attempts >= 3) return item;
          changed = true;
          if (Math.random() < 0.78) return { ...item, state: 'reported' as const, attempts: item.attempts + 1 };
          const next = { ...item, attempts: item.attempts + 1 };
          return next.attempts >= 3 ? { ...next, state: 'failed' as const, lastError: '连续 3 次回滚上报失败，等待按设备重试' } : next;
        });
        if (changed) {
          batch = { ...batch, rollbackReport, updatedAt: nowIso() };
          if (rollbackReport.every((item) => item.state === 'reported' || item.state === 'failed')) rollbackFinished = true;
        }
      }

      return batch;
    });

    if (thresholdPaused) audits = withAudits({ ...state, audits }, '系统', ['失败率超过阈值，已自动暂停发布（待核实回执不计入已装台数）']);
    if (rollbackFinished) {
      const info = batches.find((b) => b.status === 'rolled_back');
      if (info) {
        const failedCount = info.rollbackReport.filter((item) => item.state === 'failed').length;
        audits = withAudits(
          { ...state, audits },
          '系统',
          failedCount > 0 ? [`回滚执行结束：${failedCount} 台失败，等待值班员按设备重试`] : ['回滚执行结束：全部匹配设备回滚成功']
        );
      }
    }
    return { ...state, batches, receipts, audits };
  })
);
