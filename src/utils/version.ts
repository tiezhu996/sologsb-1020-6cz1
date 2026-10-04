import type {
  AuditEntry, BatchKind, BatchNode, BatchOrigin, ConflictEntry, DecisionSnap,
  DecisionStatus, FieldKey, FieldOrigin, MergeSnap, RecordGroup, RecordSnap,
  RevisionEntry, Snapshot, WorkspaceState, LegacyStateShape
} from '../types';
import {
  FIELD_KEYS, buildCandidates, canonicalText, decisionBasis, fieldText,
  matchKey, type RecordLike, SIGNATURE_FIELDS, signatureSlim
} from './matching';

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const nowIso = () => new Date().toISOString();

export const FIELD_LABELS: Record<FieldKey, string> = {
  title: '标题', date: '日期', people: '人物', places: '地点', identifier: '编号',
  medium: '载体', extent: '数量', rights: '权利', notes: '备注'
};

// ───────────────────────────────────────────────────────────── 快照工具 ──

export const emptySnapshot = (): Snapshot => ({ records: {}, decisions: {}, merges: {} });

export function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    records: Object.fromEntries(Object.values(snapshot.records).map((record) => [record.id, structuredClone(record)])),
    decisions: Object.fromEntries(Object.entries(snapshot.decisions).map(([key, decision]) => [key, structuredClone(decision)])),
    merges: Object.fromEntries(Object.entries(snapshot.merges).map(([id, merge]) => [id, structuredClone(merge)]))
  };
}

export const snapRecordList = (snapshot: Snapshot) => Object.values(snapshot.records);

export function recordToLike(record: RecordSnap): RecordLike {
  return {
    id: record.id, group: record.group, title: record.title, date: record.date,
    people: [...record.people], places: [...record.places], identifier: record.identifier,
    medium: record.medium, extent: record.extent, rights: record.rights, notes: record.notes
  };
}

export const recordLabel = (record: RecordSnap | undefined) =>
  record ? `${record.title}（${record.identifier || '无编号'}）` : '未知记录';

/** 泛型字段拷贝，绕开联合字段类型（数组 / 字符串）的互相窄化问题。 */
function copyField<K extends FieldKey>(target: RecordSnap, source: RecordSnap, field: K): void {
  target[field] = source[field];
}

function writeScalarField(record: RecordSnap, field: Exclude<FieldKey, 'people' | 'places'>, value: string): void {
  record[field] = value;
}
function writeListField(record: RecordSnap, field: 'people' | 'places', value: string[]): void {
  record[field] = value;
}
/** 写入记录字段（值类型在调用处已区分）。 */
export function writeRecordField(record: RecordSnap, field: FieldKey, value: string | string[]): void {
  if (field === 'people' || field === 'places') writeListField(record, field, Array.isArray(value) ? value : [value]);
  else writeScalarField(record, field, Array.isArray(value) ? value.join('、') : value);
}

export const conflictEntityLabel = (
  kind: ConflictEntry['kind'], entityId: string, ours: Snapshot, theirs: Snapshot
): string => {
  if (kind === 'record-field') return recordLabel(ours.records[entityId] ?? theirs.records[entityId]);
  if (kind === 'match-decision') {
    const decision = ours.decisions[entityId] ?? theirs.decisions[entityId];
    if (!decision) return entityId;
    const left = ours.records[decision.leftId] ?? theirs.records[decision.leftId];
    const right = ours.records[decision.rightId] ?? theirs.records[decision.rightId];
    return `${left?.title ?? decision.leftId} ↔ ${right?.title ?? decision.rightId}`;
  }
  const merge = ours.merges[entityId] ?? theirs.merges[entityId];
  if (!merge) return entityId;
  const left = ours.records[merge.leftId] ?? theirs.records[merge.leftId];
  const right = ours.records[merge.rightId] ?? theirs.records[merge.rightId];
  return `合并：${left?.title ?? merge.leftId} ↔ ${right?.title ?? merge.rightId}`;
};

// ─────────────────────────────────────────────────────────── 工作区构造 ──

export function createWorkspace(rootLabel: string, records: RecordSnap[]): WorkspaceState {
  const at = nowIso();
  const rootId = uid('batch-root');
  const workId = uid('batch-work');
  const snapshot = emptySnapshot();
  records.forEach((record) => {
    // 归一到本工作区的根批次（保留来源方式 via）
    record.sourceBatchId = rootId;
    FIELD_KEYS.forEach((field) => {
      if (record.origins[field]) record.origins[field] = {
        ...record.origins[field]!, batchId: rootId, batchLabel: rootLabel
      };
    });
    snapshot.records[record.id] = record;
  });
  // 种子批次即按现行规则给出首批候选建议。
  const candidates = buildCandidates(records.map(recordToLike));
  candidates.forEach((basis, key) => {
    const [, leftId, rightId] = key.split(':');
    snapshot.decisions[key] = { key, leftId, rightId, status: 'suggested', basis };
  });
  return {
    formatVersion: 2,
    workspaceId: uid('workspace'),
    batches: [
      { id: rootId, kind: 'root', origin: 'seed', parents: [], label: rootLabel, createdAt: at },
      { id: workId, kind: 'work', origin: 'local', parents: [rootId], label: '馆内工作批次', createdAt: at }
    ],
    snapshots: { [rootId]: cloneSnapshot(snapshot) },
    openBatchId: workId,
    workSnapshot: snapshot,
    conflicts: [],
    revisions: [{
      id: uid('rev'), at, batchId: workId, action: '初始化工作区',
      detail: `建立根批次「${rootLabel}」与开放工作批次，按现行规则生成 ${candidates.size} 条候选`,
      targetType: 'batch', targetId: workId
    }],
    audit: [{
      id: uid('audit'), at, batchId: workId, action: '初始化工作区',
      detail: `根批次 ${rootId}，${records.length} 条记录、${candidates.size} 条候选`, recordIds: records.map((record) => record.id)
    }],
    hydrated: false
  };
}

/** 归档员把未归属批次的原始行转成带字段来源的记录。 */
export function makeRecordSnap(input: {
  id?: string; group: RecordGroup; title: string; date: string;
  people: string[]; places: string[]; identifier: string;
  medium: string; extent: string; rights: string; notes: string;
}, batchId: string, batchLabel: string, via: FieldOrigin['via'] = 'import'): RecordSnap {
  const at = nowIso();
  const origin: FieldOrigin = { batchId, batchLabel, via, at };
  const record: RecordSnap = {
    id: input.id ?? uid('record'),
    group: input.group, title: input.title, date: input.date,
    people: input.people, places: input.places, identifier: input.identifier,
    medium: input.medium, extent: input.extent, rights: input.rights, notes: input.notes,
    origins: {}, updatedAt: at, sourceBatchId: batchId
  };
  FIELD_KEYS.forEach((field) => { if (fieldText(record, field)) record.origins[field] = { ...origin }; });
  return record;
}

// ─────────────────────────────────────────────────────── 批次链工具 ──

export const getBatch = (state: WorkspaceState, id: string) => state.batches.find((batch) => batch.id === id);
export const batchLabel = (state: WorkspaceState, id: string) => getBatch(state, id)?.label ?? id;
export const rootBatch = (state: WorkspaceState) => state.batches.find((batch) => batch.kind === 'root' || batch.parents.length === 0);

/** DAG 深度：汇入节点取较深父链 +1，用于版本链排序。 */
export function batchDepth(state: WorkspaceState, id: string, cache = new Map<string, number>()): number {
  if (cache.has(id)) return cache.get(id)!;
  const batch = getBatch(state, id);
  if (!batch || !batch.parents.length) { cache.set(id, 0); return 0; }
  const depth = 1 + Math.max(...batch.parents.map((parent) => batchDepth(state, parent, cache)));
  cache.set(id, depth);
  return depth;
}

/**
 * 取共同祖先：在祖先闭包中选择深度最大的批次。
 * 汇入节点的快照即其合并结论面，可直接作为后续再次接续的共同祖先。
 */
export function findCommonAncestor(state: WorkspaceState, aId: string, bId: string): string | undefined {
  const closure = (start: string) => {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      getBatch(state, id)?.parents.forEach(walk);
    };
    walk(start);
    return seen;
  };
  const setA = closure(aId);
  const common = [...closure(bId)].filter((id) => setA.has(id));
  if (!common.length) return undefined;
  const cache = new Map<string, number>();
  return common.sort((x, y) => batchDepth(state, y, cache) - batchDepth(state, x, cache))[0];
}

// ─────────────────────────────────────────────────────── 封存与重开 ──

/**
 * 封存当前开放工作批次：生成 work-checkpoint（持有现快照），
 * 再开一个继承它的新开放批次。返回检查点 id。撤销栈不受此调用管理（由 UI 清空）。
 */
export function sealOpenBatch(state: WorkspaceState, label: string, at = nowIso()): string {
  const open = getBatch(state, state.openBatchId)!;
  const checkpointId = uid('batch-checkpoint');
  const nextWorkId = uid('batch-work');
  state.snapshots[checkpointId] = cloneSnapshot(state.workSnapshot);
  state.batches.push({
    id: checkpointId, kind: 'work-checkpoint', origin: 'local',
    parents: [open.id], label, createdAt: at
  });
  state.batches.push({
    id: nextWorkId, kind: 'work', origin: 'local',
    parents: [checkpointId], label: '馆内工作批次', createdAt: at
  });
  state.openBatchId = nextWorkId;
  return checkpointId;
}

function addAudit(state: WorkspaceState, entry: Omit<AuditEntry, 'id' | 'at'>) {
  state.audit.unshift({ id: uid('audit'), at: nowIso(), ...entry });
  state.audit = state.audit.slice(0, 400);
}
function addRevision(state: WorkspaceState, entry: Omit<RevisionEntry, 'id' | 'at'>) {
  state.revisions.unshift({ id: uid('rev'), at: nowIso(), ...entry });
  state.revisions = state.revisions.slice(0, 600);
}

// ───────────────────────────────────────────────── 三方接续合并核心 ──

const sideTextFor = (
  snapshot: Snapshot | undefined, kind: ConflictEntry['kind'],
  entityId: string, field: ConflictEntry['field']
): string => {
  if (!snapshot) return '';
  if (kind === 'record-field') {
    const record = snapshot.records[entityId];
    return record && field !== 'decision' && field !== 'identity' ? fieldText(record, field) : '';
  }
  if (kind === 'match-decision') {
    const decision = snapshot.decisions[entityId];
    return decision ? statusText(decision.status) : '';
  }
  const merge = snapshot.merges[entityId];
  if (!merge || field === 'decision' || field === 'identity') return '';
  return merge.values[field as FieldKey] ?? '';
};

export const statusText = (status: DecisionStatus) =>
  status === 'suggested' ? '待复核' : status === 'confirmed' ? '已确认'
    : status === 'rejected' ? '已忽略' : '已合并';

interface SideInfo { batchId: string; snapshot: Snapshot | undefined; node: BatchNode }

function makeConflict(
  kind: ConflictEntry['kind'], entityId: string, field: ConflictEntry['field'],
  baseText: string, oursInfo: SideInfo, theirsInfo: SideInfo, baseNode: BatchNode | undefined
): ConflictEntry {
  return {
    id: uid('conflict'), kind, entityId, field,
    fieldLabel: field === 'decision' ? '候选裁决' : field === 'identity' ? '记录身份' : FIELD_LABELS[field as FieldKey],
    entityLabel: '',
    baseText,
    oursText: sideTextFor(oursInfo.snapshot, kind, entityId, field),
    theirsText: sideTextFor(theirsInfo.snapshot, kind, entityId, field),
    ours: { batchId: oursInfo.batchId, batchLabel: oursInfo.node.label },
    theirs: { batchId: theirsInfo.batchId, batchLabel: theirsInfo.node.label, at: theirsInfo.node.createdAt, author: theirsInfo.node.author },
    base: baseNode ? { batchId: baseNode.id, batchLabel: baseNode.label } : undefined,
    resolved: false
  };
}

export interface ReconcileResult {
  merged: Snapshot;
  conflicts: ConflictEntry[];
  autoAccepted: { records: number; decisions: number; merges: number };
}

/**
 * 按共同祖先做三方接续：
 * - 只一边改过的内容自动生效；两边一致的改动直接生效；
 * - 同一记录字段 / 候选裁决 / 合并字段两边改法不同 → 冲突，留待人工裁决。
 * 无共同祖先时（ancestorSnap 为 undefined）按独立根处理：身份冲突全部列出。
 */
export function reconcileSnapshots(
  baseSnap: Snapshot | undefined,
  oursSnap: Snapshot,
  theirsSnap: Snapshot,
  oursInfo: { batchId: string; node: BatchNode },
  theirsInfo: { batchId: string; node: BatchNode },
  baseNode?: BatchNode
): ReconcileResult {
  const merged: Snapshot = emptySnapshot();
  const conflicts: ConflictEntry[] = [];
  const autoAccepted = { records: 0, decisions: 0, merges: 0 };
  const oursSide: SideInfo = { batchId: oursInfo.batchId, snapshot: oursSnap, node: oursInfo.node };
  const theirsSide: SideInfo = { batchId: theirsInfo.batchId, snapshot: theirsSnap, node: theirsInfo.node };

  const base = (snap: Snapshot | undefined) => (id: string) => (snap ? snap.records[id] : undefined);
  const baseRecord = base(baseSnap);

  // 记录：身份并集 + 逐字段接续（记录从不硬删除，接替靠 supersededBy）
  const recordIds = new Set([
    ...Object.keys(oursSnap.records), ...Object.keys(theirsSnap.records),
    ...(baseSnap ? Object.keys(baseSnap.records) : [])
  ]);
  recordIds.forEach((id) => {
    const ours = oursSnap.records[id];
    const theirs = theirsSnap.records[id];
    const ancestor = baseRecord(id);
    if (ours && theirs) {
      const mergedRecord: RecordSnap = structuredClone(ours);
      FIELD_KEYS.forEach((field) => {
        const o = canonicalText(ours, field);
        const t = canonicalText(theirs, field);
        const b = ancestor ? canonicalText(ancestor, field) : '';
        if (o === t) return;
        if (ancestor) {
          if (t === b) return;                 // 只有本馆改 → 保留本馆
          if (o === b) {                       // 只有离线改 → 自动生效
            copyField(mergedRecord, theirs, field);
            mergedRecord.origins[field] = structuredClone(theirs.origins[field]);
            autoAccepted.records += 1;
            return;
          }
        }
        // 两边都改且不同（或无共同祖先）→ 冲突待裁决
        conflicts.push(makeConflict('record-field', id, field,
          ancestor ? fieldText(ancestor, field) : '', oursSide, theirsSide, ancestor ? baseNode : undefined));
      });
      mergedRecord.supersededBy = theirs.supersededBy ?? ours.supersededBy;
      mergedRecord.updatedAt = ours.updatedAt > theirs.updatedAt ? ours.updatedAt : theirs.updatedAt;
      merged.records[id] = mergedRecord;
    } else {
      // 只一边存在 → 一边改过，自动生效
      merged.records[id] = structuredClone((ours ?? theirs)!);
      if (theirs && !ours) autoAccepted.records += 1;
    }
  });

  // 候选裁决：同 key 三方比对状态
  const decisionIds = new Set([
    ...Object.keys(oursSnap.decisions), ...Object.keys(theirsSnap.decisions),
    ...(baseSnap ? Object.keys(baseSnap.decisions) : [])
  ]);
  decisionIds.forEach((key) => {
    const ours = oursSnap.decisions[key];
    const theirs = theirsSnap.decisions[key];
    const ancestor = baseSnap?.decisions[key];
    if (ours && theirs) {
      if (ours.status === theirs.status) {
        merged.decisions[key] = structuredClone(ours);
        return;
      }
      const baseStatus: DecisionStatus | undefined = ancestor?.status;
      if (baseStatus && theirs.status === baseStatus) {
        merged.decisions[key] = structuredClone(ours);
        if (ours.status !== 'suggested') autoAccepted.decisions += 1;
        return;
      }
      if (baseStatus && ours.status === baseStatus) {
        merged.decisions[key] = structuredClone(theirs);
        if (theirs.status !== 'suggested') autoAccepted.decisions += 1;
        return;
      }
      conflicts.push(makeConflict(
        'match-decision', key, 'decision',
        ancestor ? statusText(ancestor.status) : '（共同祖先处无此候选）',
        oursSide, theirsSide, ancestor ? baseNode : undefined
      ));
      // 冲突期间该候选回到待复核面，依据沿用本馆侧（导入后的重算阶段会刷新）
      merged.decisions[key] = structuredClone(ours);
      merged.decisions[key].status = 'suggested';
    } else if (theirs) {
      // 仅离线侧产生的候选裁决：一边改过，自动生效
      merged.decisions[key] = structuredClone(theirs);
      if (theirs.status !== 'suggested') autoAccepted.decisions += 1;
    } else if (ours) {
      merged.decisions[key] = structuredClone(ours);
    }
  });

  // 合并结论：逐条 + 逐字段接续
  const mergeIds = new Set([
    ...Object.keys(oursSnap.merges), ...Object.keys(theirsSnap.merges),
    ...(baseSnap ? Object.keys(baseSnap.merges) : [])
  ]);
  mergeIds.forEach((id) => {
    const ours = oursSnap.merges[id];
    const theirs = theirsSnap.merges[id];
    const ancestor = baseSnap?.merges[id];
    if (ours && theirs) {
      const mergedMerge: MergeSnap = structuredClone(ours);
      FIELD_KEYS.forEach((field) => {
        const o = (ours.values[field] ?? '').trim();
        const t = (theirs.values[field] ?? '').trim();
        const b = ancestor?.values[field]?.trim() ?? '';
        if (o === t) return;
        if (ancestor) {
          if (t === b) return;
          if (o === b) {
            mergedMerge.values[field] = theirs.values[field];
            mergedMerge.origins[field] = structuredClone(theirs.origins[field]);
            mergedMerge.choices[field] = theirs.choices[field];
            autoAccepted.merges += 1;
            return;
          }
        }
        conflicts.push(makeConflict(
          'merge-field', id, field,
          ancestor ? ancestor.values[field] ?? '' : '',
          oursSide, theirsSide, ancestor ? baseNode : undefined
        ));
      });
      merged.merges[id] = mergedMerge;
    } else if (theirs) {
      merged.merges[id] = structuredClone(theirs);
      autoAccepted.merges += 1;
    } else if (ours) {
      merged.merges[id] = structuredClone(ours);
    }
  });

  // 填入实体中文标签（此时三方快照均可取到名称）
  conflicts.forEach((conflict) => {
    conflict.entityLabel = conflictEntityLabel(conflict.kind, conflict.entityId, oursSnap, theirsSnap);
  });

  return { merged, conflicts, autoAccepted };
}

// ───────────────────────────────────────────── 现行规则重算与退回复核 ──

export interface RecomputeReport {
  reopened: { key: string; oldStatus: DecisionStatus; reason: string }[];
  newCandidates: number;
}

const aliveRecordLike = (snapshot: Snapshot) =>
  Object.values(snapshot.records).filter((record) => !record.supersededBy).map(recordToLike);

/**
 * 按现行规则重算候选：
 * - 标题/日期/人物/地点变化后，相关候选重新评分；
 * - 已确认、忽略、合并的结论若旧依据与现字段不符，带旧依据退回待复核；
 * - 不再满足阈值或记录被接替的已裁决结论同样退回；仍为建议的候选静默更新分值。
 */
export function recomputePass(snapshot: Snapshot): RecomputeReport {
  const reopened: RecomputeReport['reopened'] = [];
  const candidateMap = buildCandidates(aliveRecordLike(snapshot));
  const recordMap = snapshot.records;

  Object.values(snapshot.decisions).forEach((decision) => {
    const left = recordMap[decision.leftId];
    const right = recordMap[decision.rightId];
    const superseded = left?.supersededBy || right?.supersededBy;
    const fresh = candidateMap.get(decision.key);

    // 合并结论：原记录被接替是合并的预期结果，不因接替本身退回；
    // 但若原记录关键字段后来又被改动，仍要带旧依据回到待复核。
    if (decision.status === 'merged') {
      if (left && right) {
        const nowLeft = signatureSlim(recordToLike(left));
        const nowRight = signatureSlim(recordToLike(right));
        const changed = SIGNATURE_FIELDS.some((field) =>
          decision.basis.left[field] !== nowLeft[field] || decision.basis.right[field] !== nowRight[field]);
        if (changed) {
          reopenDecision(decision, '合并后原记录关键字段发生变化，合并结论回到待复核');
          reopened.push({ key: decision.key, oldStatus: 'merged', reason: decision.reopened!.reason });
        }
      }
      return;
    }
    const judged = decision.status !== 'suggested';

    if (superseded || !left || !right) {
      if (judged) {
        reopenDecision(decision, superseded ? '记录已合并，原结论回到待复核' : '原记录缺失，结论回到待复核');
        reopened.push({ key: decision.key, oldStatus: decision.status, reason: decision.reopened!.reason });
      }
      return;
    }

    if (fresh) {
      if (judged) {
        // 旧依据记录的关键字段（规范值）与现行规则算得的不一致 → 带旧依据退回待复核
        const changedFields = SIGNATURE_FIELDS.filter((field) =>
          decision.basis.left[field] !== fresh.left[field] || decision.basis.right[field] !== fresh.right[field]);
        if (changedFields.length) {
          const reason = `记录${changedFields.map((field) => FIELD_LABELS[field]).join('、')}变化，旧依据失效`;
          reopenDecision(decision, reason);
          reopened.push({ key: decision.key, oldStatus: decision.status, reason });
        }
      }
      // 分数与依据始终按现行规则刷新（建议态静默更新，裁决态在未退回时保留裁决但更新依据）
      decision.basis = fresh;
    } else if (judged) {
      reopenDecision(decision, '现行规则下候选已不成立，结论回到待复核');
      reopened.push({ key: decision.key, oldStatus: decision.status, reason: decision.reopened!.reason });
    }
  });

  // 新产生的候选以建议态加入
  let newCandidates = 0;
  candidateMap.forEach((basis, key) => {
    if (!snapshot.decisions[key]) {
      const [, leftId, rightId] = key.split(':');
      snapshot.decisions[key] = { key, leftId, rightId, status: 'suggested', basis };
      newCandidates += 1;
    }
  });

  // 记录已被接替的纯建议候选只是过期提示，移出队列（已裁决结论上方已退回保留）
  Object.values(snapshot.decisions).forEach((decision) => {
    if (decision.status !== 'suggested' || decision.reopened) return;
    const left = recordMap[decision.leftId];
    const right = recordMap[decision.rightId];
    if (!left || !right || left.supersededBy || right.supersededBy) {
      delete snapshot.decisions[decision.key];
    }
  });
  return { reopened, newCandidates };
}

function reopenDecision(decision: DecisionSnap, reason: string) {
  decision.reopened = {
    oldStatus: decision.status, reason, at: nowIso(),
    oldBasis: structuredClone(decision.basis)
  };
  decision.status = 'suggested';
  decision.decidedAt = undefined;
  decision.decidedByBatchId = undefined;
}

// ─────────────────────────────────────────────────────── 工作区写入 ──

/** 应用当前工作批次的一次写入后，登记修订/审计并跑现行规则重算。 */
function finalizeMutation(state: WorkspaceState, revision: Omit<RevisionEntry, 'id' | 'at' | 'batchId'>,
  audit: Omit<AuditEntry, 'id' | 'at' | 'batchId'>): RecomputeReport {
  addRevision(state, { ...revision, batchId: state.openBatchId });
  addAudit(state, { ...audit, batchId: state.openBatchId });
  return recomputePass(state.workSnapshot);
}

/** 本地编辑记录字段。标题、日期、人物、地点变化会触发候选重算。 */
export function editRecord(
  state: WorkspaceState, recordId: string, field: FieldKey, next: string | string[]
): RecomputeReport {
  const snapshot = state.workSnapshot;
  const record = snapshot.records[recordId];
  if (!record) throw new Error('记录不存在');
  const before = fieldText(record, field);
  const after = Array.isArray(next) ? next.filter(Boolean).join('、') : next;
  writeRecordField(record, field, next);
  record.updatedAt = nowIso();
  record.origins[field] = { batchId: state.openBatchId, batchLabel: '馆内工作批次', via: 'edit' };
  return finalizeMutation(state, {
    sourceBatchId: state.openBatchId, sourceBatchLabel: '馆内工作批次',
    action: '编辑记录', detail: `${FIELD_LABELS[field]}：${before || '空'} → ${after || '空'}`,
    targetType: 'record', targetId: recordId, field, beforeText: before, afterText: after
  }, {
    action: '编辑记录', detail: `修改《${record.title}》的${FIELD_LABELS[field]}`, recordIds: [recordId]
  });
}

/** 一次编辑多个字段：共享一条修订记录并只跑一次现行规则重算。 */
export function editRecordFields(
  state: WorkspaceState, recordId: string,
  updates: Partial<Record<FieldKey, string | string[]>>
): RecomputeReport {
  const snapshot = state.workSnapshot;
  const record = snapshot.records[recordId];
  if (!record) throw new Error('记录不存在');
  const changes: string[] = [];
  (Object.entries(updates) as Array<[FieldKey, string | string[]]>).forEach(([field, value]) => {
    const before = fieldText(record, field);
    writeRecordField(record, field, value);
    const after = fieldText(record, field);
    if (before !== after) {
      changes.push(`${FIELD_LABELS[field]}：${before || '空'} → ${after || '空'}`);
      record.origins[field] = { batchId: state.openBatchId, batchLabel: '馆内工作批次', via: 'edit' };
    }
  });
  if (!changes.length) return { reopened: [], newCandidates: 0 };
  record.updatedAt = nowIso();
  return finalizeMutation(state, {
    sourceBatchId: state.openBatchId, sourceBatchLabel: '馆内工作批次',
    action: '编辑记录', detail: changes.join('；'),
    targetType: 'record', targetId: recordId,
    beforeText: changes.map((change) => change.split(' → ')[0]?.slice(3)).join('；'),
    afterText: changes.map((change) => change.split(' → ')[1]).join('；')
  }, {
    action: '编辑记录', detail: `修改《${record.title}》的 ${changes.length} 个字段`, recordIds: [recordId]
  });
}

/** 向当前开放工作批次导入新记录（馆内补录），随后按现行规则重算候选。 */
export function importNewRecords(state: WorkspaceState, records: RecordSnap[]): RecomputeReport {
  records.forEach((record) => { state.workSnapshot.records[record.id] = record; });
  const report = recomputePass(state.workSnapshot);
  addRevision(state, {
    batchId: state.openBatchId, sourceBatchId: state.openBatchId, sourceBatchLabel: '馆内工作批次',
    action: '补录档案记录', detail: `导入 ${records.length} 条记录，新增候选 ${report.newCandidates} 条`,
    targetType: 'batch', targetId: state.openBatchId
  });
  addAudit(state, {
    batchId: state.openBatchId, action: '补录档案记录',
    detail: `${records.length} 条新记录进入当前工作批次`, recordIds: records.map((record) => record.id)
  });
  return report;
}

export function setDecisionStatus(
  state: WorkspaceState, key: string, status: Exclude<DecisionStatus, 'merged'>
): void {
  const decision = state.workSnapshot.decisions[key];
  if (!decision) return;
  decision.status = status;
  decision.reopened = undefined;
  decision.decidedAt = nowIso();
  decision.decidedByBatchId = state.openBatchId;
  addRevision(state, {
    batchId: state.openBatchId, sourceBatchId: state.openBatchId, sourceBatchLabel: '馆内工作批次',
    action: status === 'confirmed' ? '确认候选' : status === 'rejected' ? '忽略候选' : '退回建议',
    detail: `${statusText(status)}：${decision.key}`, targetType: 'match', targetId: key, field: 'decision',
    afterText: statusText(status)
  });
  addAudit(state, {
    batchId: state.openBatchId, action: status === 'confirmed' ? '确认匹配' : status === 'rejected' ? '忽略匹配' : '退回建议',
    detail: `候选 ${decision.leftId} ↔ ${decision.rightId} 标记为${statusText(status)}`,
    recordIds: [decision.leftId, decision.rightId]
  });
}

/** 执行字段合并：生成接替记录，原记录保留并标记 supersededBy。未决分歧期间禁止合并。 */
export function performMerge(
  state: WorkspaceState, key: string,
  choices: Partial<Record<FieldKey, RecordGroup | 'combine'>>
): string {
  if (hasOpenConflicts(state)) {
    throw new Error('尚有分歧未裁决，裁决前不能合并');
  }
  const snapshot = state.workSnapshot;
  const decision = snapshot.decisions[key];
  if (!decision) throw new Error('候选不存在');
  const left = snapshot.records[decision.leftId];
  const right = snapshot.records[decision.rightId];
  if (!left || !right) throw new Error('候选引用的记录缺失');
  if (left.supersededBy || right.supersededBy) {
    throw new Error('候选记录已被合并接替，不能再次合并');
  }

  const mergedId = uid('record-merged');
  const at = nowIso();
  const values: Partial<Record<FieldKey, string>> = {};
  const origins: Partial<Record<FieldKey, FieldOrigin>> = {};
  const mergedRecord: RecordSnap = {
    id: mergedId, group: left.group,
    title: '', date: '', people: [], places: [], identifier: '',
    medium: '', extent: '', rights: '', notes: '',
    origins: {}, updatedAt: at, sourceBatchId: state.openBatchId
  };

  FIELD_KEYS.forEach((field) => {
    const choice = choices[field] ?? 'A';
    let value: string;
    let sourceRecord: RecordSnap;
    if (choice === 'combine') {
      value = [fieldText(left, field), fieldText(right, field)].filter(Boolean)
        .join(field === 'people' || field === 'places' ? '、' : '；');
      sourceRecord = left;
    } else {
      sourceRecord = choice === 'A' ? left : right;
      value = fieldText(sourceRecord, field);
    }
    values[field] = value;
    origins[field] = sourceRecord.origins[field]
      ?? { batchId: state.openBatchId, batchLabel: '馆内工作批次', via: 'merge', at };
    if (field === 'people' || field === 'places') {
      writeRecordField(mergedRecord, field, choice === 'combine'
        ? [...new Set([...left[field], ...right[field]])]
        : [...sourceRecord[field]]);
    } else {
      writeRecordField(mergedRecord, field, value);
    }
    mergedRecord.origins[field] = structuredClone(origins[field]!);
  });

  left.supersededBy = mergedId;
  right.supersededBy = mergedId;
  snapshot.records[mergedId] = mergedRecord;

  const merge: MergeSnap = {
    id: uid('merge'), key, leftId: left.id, rightId: right.id, mergedId,
    choices: { ...choices }, values, origins, basis: structuredClone(decision.basis),
    batchId: state.openBatchId, createdAt: at
  };
  snapshot.merges[merge.id] = merge;
  decision.status = 'merged';
  decision.reopened = undefined;
  decision.decidedAt = at;
  decision.decidedByBatchId = state.openBatchId;

  const recompute = recomputePass(snapshot);
  addRevision(state, {
    batchId: state.openBatchId, sourceBatchId: state.openBatchId, sourceBatchLabel: '馆内工作批次',
    action: '合并记录', detail: `《${left.title}》与《${right.title}》合并为 ${mergedId}`,
    targetType: 'merge', targetId: merge.id
  });
  addAudit(state, {
    batchId: state.openBatchId, action: '合并记录',
    detail: `合并 ${left.id} + ${right.id} → ${mergedId}；相关候选 ${recompute.reopened.length} 条退回复核`,
    recordIds: [left.id, right.id, mergedId]
  });
  return merge.id;
}

// ───────────────────────────────────────────────── 分歧裁决 ──

export function resolveConflict(
  state: WorkspaceState, conflictId: string, chosen: 'ours' | 'theirs'
): RecomputeReport {
  const conflict = state.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolved) throw new Error('冲突不存在或已裁决');
  const sourceSide = chosen === 'ours' ? conflict.ours : conflict.theirs;
  const sourceSnapshot = chosen === 'ours'
    ? (sourceSide.batchId === state.openBatchId ? state.workSnapshot : state.snapshots[sourceSide.batchId])
    : state.snapshots[sourceSide.batchId];
  const target = state.workSnapshot;
  const at = nowIso();

  if (conflict.kind === 'record-field' && conflict.field !== 'decision' && conflict.field !== 'identity') {
    const field = conflict.field as FieldKey;
    const source = sourceSnapshot!.records[conflict.entityId];
    const dest = target.records[conflict.entityId];
    if (source && dest) {
      copyField(dest, source, field);
      dest.origins[field] = {
        batchId: sourceSide.batchId, batchLabel: sourceSide.batchLabel, via: 'adjudication', at
      };
      dest.updatedAt = at;
    }
  } else if (conflict.kind === 'match-decision') {
    const source = sourceSnapshot!.decisions[conflict.entityId];
    if (source) {
      target.decisions[conflict.entityId] = structuredClone(source);
    }
  } else if (conflict.kind === 'merge-field') {
    const field = conflict.field as FieldKey;
    const source = sourceSnapshot!.merges[conflict.entityId];
    const dest = target.merges[conflict.entityId];
    if (source && dest) {
      dest.values[field] = source.values[field];
      dest.choices[field] = source.choices[field];
      dest.origins[field] = {
        batchId: sourceSide.batchId, batchLabel: sourceSide.batchLabel, via: 'adjudication', at
      };
    }
  }

  conflict.resolved = true;
  conflict.chosen = chosen;
  conflict.resolvedAt = at;

  const chosenText = chosen === 'ours' ? conflict.oursText : conflict.theirsText;
  addRevision(state, {
    batchId: state.openBatchId, sourceBatchId: sourceSide.batchId, sourceBatchLabel: sourceSide.batchLabel,
    action: '裁决分歧', detail: `${conflict.entityLabel} · ${conflict.fieldLabel} 采用「${sourceSide.batchLabel}」：${chosenText}`,
    targetType: 'conflict', targetId: conflict.id,
    field: conflict.field === 'decision' ? 'decision' : conflict.field as FieldKey,
    beforeText: chosen === 'ours' ? conflict.theirsText : conflict.oursText, afterText: chosenText
  });
  addAudit(state, {
    batchId: state.openBatchId, sourceBatchId: sourceSide.batchId, sourceBatchLabel: sourceSide.batchLabel,
    action: '裁决导入分歧',
    detail: `${conflict.kind} ${conflict.entityId} 的${conflict.fieldLabel}采用批次「${sourceSide.batchLabel}」`,
    recordIds: conflict.kind === 'record-field' ? [conflict.entityId] : []
  });
  return recomputePass(target);
}

export const openConflicts = (state: WorkspaceState) => state.conflicts.filter((conflict) => !conflict.resolved);
export const hasOpenConflicts = (state: WorkspaceState) => state.conflicts.some((conflict) => !conflict.resolved);

// ─────────────────────────────────────────────── 离线核对包（离馆 / 回馆）──

export interface OfflinePackage {
  packageFormat: 'archive-check-offline/2';
  workspaceId: string;
  /** 共同祖先：导出时封存的检查点。 */
  ancestorId: string;
  ancestorLabel: string;
  exportedAt: string;
  exportedBy?: string;
  records: RecordSnap[];
  decisions: DecisionSnap[];
  merges: MergeSnap[];
}

/**
 * 离馆：封存当前工作批次作为共同祖先检查点，导出离线核对包。
 * 未裁决分歧未解决前禁止出包。
 */
export function createOfflinePackage(state: WorkspaceState, author?: string): OfflinePackage {
  if (hasOpenConflicts(state)) throw new Error('尚有未裁决分歧，不能生成离线核对包');
  const checkpointId = sealOpenBatch(state, `离馆检查点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  const snapshot = state.snapshots[checkpointId];
  const at = nowIso();
  addRevision(state, {
    batchId: state.openBatchId, action: '生成离线核对包',
    detail: `封存检查点 ${checkpointId}，离线包携带共同祖先快照`,
    targetType: 'batch', targetId: checkpointId, sourceBatchId: checkpointId,
    sourceBatchLabel: getBatch(state, checkpointId)!.label
  });
  addAudit(state, {
    batchId: state.openBatchId, action: '生成离线核对包',
    detail: `共同祖先检查点 ${checkpointId}，${Object.keys(snapshot.records).length} 条记录`,
    recordIds: Object.keys(snapshot.records)
  });
  return {
    packageFormat: 'archive-check-offline/2',
    workspaceId: state.workspaceId,
    ancestorId: checkpointId,
    ancestorLabel: getBatch(state, checkpointId)!.label,
    exportedAt: at,
    exportedBy: author,
    records: Object.values(snapshot.records),
    decisions: Object.values(snapshot.decisions),
    merges: Object.values(snapshot.merges)
  };
}

export interface ImportReport {
  offlineNode: BatchNode;
  mergeNode: BatchNode;
  commonAncestorId?: string;
  autoAccepted: ReconcileResult['autoAccepted'];
  conflictsAdded: number;
  reopened: RecomputeReport['reopened'];
  newCandidates: number;
  /** true 表示包与当前工作区无共同祖先，按独立根接续，身份分歧全部列出。 */
  unrelated: boolean;
}

/**
 * 回馆汇入离线核对包：
 * 1. 封存本馆当前工作批次为检查点，建 offline-edit 批次（祖先＝包内检查点），
 *    再建 import-merge 汇入节点（本馆检查点 + 离线末梢两个父）；
 * 2. 按共同祖先三方接续，一边改过自动生效，两边改法不同入冲突清单；
 * 3. 接续后按现行规则重算，被退回的已裁决结论带旧依据回到待复核。
 * 整个过程先在草稿状态上完成，任何阶段失败都不触碰当前工作区（可安全重试）。
 */
export function importOfflinePackage(state: WorkspaceState, parsed: unknown, author?: string): ImportReport {
  // ── 草稿构建，任何阶段失败（含包损坏）原工作区都不变，可安全重试 ──
  let draft: WorkspaceState;
  try {
    const pkg = validateOfflinePackage(parsed);
    if (pkg.workspaceId !== state.workspaceId) {
      throw new Error('核对包属于其他工作区（workspaceId 不一致），拒绝汇入');
    }
    draft = structuredClone(state);
    const at = nowIso();
    const offlineId = uid('batch-offline');
    const mergeNodeId = uid('batch-merge');

    // 先封存本馆侧，拿到“汇入前本馆检查点”
    const oursCheckpointId = sealOpenBatch(
      draft, `回馆前本馆检查点 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`, at
    );
    const oursSnapshot = draft.snapshots[oursCheckpointId];

    const ancestor = draft.snapshots[pkg.ancestorId];
    const unrelated = !ancestor;

    const offlineSnapshot: Snapshot = {
      records: Object.fromEntries(pkg.records.map((record) => [record.id, record])),
      decisions: Object.fromEntries(pkg.decisions.map((decision) => [decision.key, decision])),
      merges: Object.fromEntries(pkg.merges.map((merge) => [merge.id, merge]))
    };
    const offlineNode: BatchNode = {
      id: offlineId, kind: 'offline-edit', origin: 'offline',
      parents: ancestor ? [pkg.ancestorId] : [],
      label: `离线核对 · ${author || pkg.exportedBy || '档案员'} · ${new Date(pkg.exportedAt).toLocaleDateString('zh-CN')}`,
      author: author ?? pkg.exportedBy, createdAt: pkg.exportedAt
    };
    const mergeNode: BatchNode = {
      id: mergeNodeId, kind: 'import-merge', origin: 'offline',
      parents: ancestor ? [oursCheckpointId, offlineId] : [oursCheckpointId, offlineId],
      label: `回馆汇入 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`,
      author, createdAt: at
    };
    draft.batches.push(offlineNode, mergeNode);
    draft.snapshots[offlineId] = offlineSnapshot;

    const result = reconcileSnapshots(
      ancestor,
      oursSnapshot,
      offlineSnapshot,
      { batchId: oursCheckpointId, node: getBatch(draft, oursCheckpointId)! },
      { batchId: offlineId, node: offlineNode },
      ancestor ? getBatch(draft, pkg.ancestorId) : undefined
    );

    // 给自动接续进来的离线改动补上来源修订（挂到汇入后的新开放批次）
    result.autoAccepted.records > 0 && annotateAutoRecordChanges(draft, ancestor, oursSnapshot, offlineSnapshot, offlineNode);
    result.autoAccepted.decisions > 0 && annotateAutoDecisionChanges(draft, ancestor, oursSnapshot, offlineSnapshot, offlineNode);
    result.autoAccepted.merges > 0 && annotateAutoMergeChanges(draft, ancestor, oursSnapshot, result.merged, offlineSnapshot, offlineNode);

    draft.snapshots[mergeNodeId] = cloneSnapshot(result.merged);
    draft.workSnapshot = result.merged;

    // sealOpenBatch 已经开了一个新 work（其父为本馆检查点）；将它改挂到汇入节点下
    const strayWork = getBatch(draft, draft.openBatchId);
    if (strayWork && strayWork.kind === 'work' && strayWork.parents[0] === oursCheckpointId) {
      strayWork.parents = [mergeNodeId];
    }

    const recompute = recomputePass(draft.workSnapshot);

    // 冲突清单并入既有清单（保留历史已裁决冲突）
    result.conflicts.forEach((conflict) => draft.conflicts.unshift(conflict));

    addRevision(draft, {
      batchId: draft.openBatchId, sourceBatchId: offlineId, sourceBatchLabel: offlineNode.label,
      action: '回馆汇入核对包',
      detail: unrelated
        ? `未找到共同祖先，按独立根接续：自动接续字段 ${result.autoAccepted.records} 处；待裁决分歧 ${result.conflicts.length} 条`
        : `按共同祖先「${getBatch(draft, pkg.ancestorId)!.label}」接续：自动接续字段 ${result.autoAccepted.records} 处、候选 ${result.autoAccepted.decisions} 条、合并 ${result.autoAccepted.merges} 项；待裁决分歧 ${result.conflicts.length} 条`,
      targetType: 'batch', targetId: mergeNodeId
    });
    addAudit(draft, {
      batchId: draft.openBatchId, sourceBatchId: offlineId, sourceBatchLabel: offlineNode.label,
      action: '回馆汇入核对包',
      detail: `汇入节点 ${mergeNodeId}，共同祖先 ${ancestor ? pkg.ancestorId : '无（独立根接续）'}；自动生效 ${result.autoAccepted.records + result.autoAccepted.decisions + result.autoAccepted.merges} 处，分歧 ${result.conflicts.length} 条待裁决，重算退回 ${recompute.reopened.length} 条`,
      recordIds: []
    });

    // 全部成功后才提交草稿
    Object.assign(state, draft);
    return {
      offlineNode, mergeNode, commonAncestorId: unrelated ? undefined : pkg.ancestorId,
      autoAccepted: result.autoAccepted, conflictsAdded: result.conflicts.length,
      reopened: recompute.reopened, newCandidates: recompute.newCandidates, unrelated
    };
  } catch (error) {
    throw new Error(`核对包损坏或结构不完整，已保留原工作区，可重试：${(error as Error).message}`);
  }
}

function annotateAutoRecordChanges(
  draft: WorkspaceState, ancestor: Snapshot | undefined, before: Snapshot, offline: Snapshot, offlineNode: BatchNode
) {
  Object.values(offline.records).forEach((theirs) => {
    const ours = before.records[theirs.id];
    const base = ancestor?.records[theirs.id];
    if (!ours) {
      addRevision(draft, {
        batchId: draft.openBatchId, sourceBatchId: offlineNode.id, sourceBatchLabel: offlineNode.label,
        action: '离线新增记录（自动接续）', detail: `《${theirs.title}》`,
        targetType: 'record', targetId: theirs.id
      });
      return;
    }
    if (!base) return;
    FIELD_KEYS.forEach((field) => {
      if (canonicalText(ours, field) === canonicalText(base, field)
        && canonicalText(theirs, field) !== canonicalText(base, field)) {
        addRevision(draft, {
          batchId: draft.openBatchId, sourceBatchId: offlineNode.id, sourceBatchLabel: offlineNode.label,
          action: '离线修订自动接续', detail: `${FIELD_LABELS[field]}：${fieldText(base, field) || '空'} → ${fieldText(theirs, field) || '空'}`,
          targetType: 'record', targetId: theirs.id, field,
          beforeText: fieldText(base, field), afterText: fieldText(theirs, field)
        });
      }
    });
  });
}

function annotateAutoDecisionChanges(
  draft: WorkspaceState, ancestor: Snapshot | undefined, before: Snapshot, offline: Snapshot, offlineNode: BatchNode
) {
  Object.values(offline.decisions).forEach((theirs) => {
    const ours = before.decisions[theirs.key];
    const base = ancestor?.decisions[theirs.key];
    if ((!ours || (base && ours.status === base.status)) && theirs.status !== (base?.status ?? 'suggested')) {
      addRevision(draft, {
        batchId: draft.openBatchId, sourceBatchId: offlineNode.id, sourceBatchLabel: offlineNode.label,
        action: '离线裁决自动接续', detail: `候选 ${theirs.key} → ${statusText(theirs.status)}`,
        targetType: 'match', targetId: theirs.key, field: 'decision', afterText: statusText(theirs.status)
      });
    }
  });
}

function annotateAutoMergeChanges(
  draft: WorkspaceState, ancestor: Snapshot | undefined, before: Snapshot, merged: Snapshot,
  offline: Snapshot, offlineNode: BatchNode
) {
  Object.values(offline.merges).forEach((theirs) => {
    if (!before.merges[theirs.id] && !ancestor?.merges[theirs.id] && merged.merges[theirs.id]) {
      addRevision(draft, {
        batchId: draft.openBatchId, sourceBatchId: offlineNode.id, sourceBatchLabel: offlineNode.label,
        action: '离线合并自动接续', detail: `合并 ${theirs.id}`,
        targetType: 'merge', targetId: theirs.id
      });
    }
  });
}

// ─────────────────────────────────────────────── 校验 · 导出 · 迁移 ──

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const isFieldKey = (value: unknown): value is FieldKey =>
  typeof value === 'string' && FIELD_KEYS.includes(value as FieldKey);

/** 结构校验离线核对包：任何字段缺失 / 类型错误都抛出（保证中断后重试安全）。 */
export function validateOfflinePackage(parsed: unknown): OfflinePackage {
  assert(isObject(parsed), '包不是有效 JSON 对象');
  assert(parsed.packageFormat === 'archive-check-offline/2', '缺少或错误的 packageFormat');
  assert(typeof parsed.workspaceId === 'string', '缺少 workspaceId');
  assert(typeof parsed.ancestorId === 'string', '缺少 ancestorId（共同祖先）');
  assert(typeof parsed.ancestorLabel === 'string', '缺少 ancestorLabel');
  assert(typeof parsed.exportedAt === 'string' && !Number.isNaN(Date.parse(parsed.exportedAt)), 'exportedAt 非法');
  assert(Array.isArray(parsed.records), 'records 不是数组');
  assert(Array.isArray(parsed.decisions), 'decisions 不是数组');
  assert(Array.isArray(parsed.merges), 'merges 不是数组');

  const recordIds = new Set<string>();
  parsed.records.forEach((raw, index) => {
    assert(isObject(raw), `records[${index}] 不是对象`);
    ['id', 'group', 'title', 'date', 'identifier', 'medium', 'extent', 'rights', 'notes', 'updatedAt', 'sourceBatchId']
      .forEach((key) => assert(typeof (raw as Record<string, unknown>)[key] === 'string', `records[${index}].${key} 缺失或非字符串`));
    assert(raw.group === 'A' || raw.group === 'B', `records[${index}].group 必须为 A/B`);
    assert(Array.isArray(raw.people) && Array.isArray(raw.places), `records[${index}] people/places 必须为数组`);
    assert(isObject(raw.origins), `records[${index}].origins 缺失`);
    recordIds.add(raw.id as string);
  });
  parsed.decisions.forEach((raw, index) => {
    assert(isObject(raw), `decisions[${index}] 不是对象`);
    assert(typeof raw.key === 'string', `decisions[${index}].key 缺失`);
    assert(recordIds.has(raw.leftId as string), `decisions[${index}] 引用了不存在的 leftId`);
    assert(recordIds.has(raw.rightId as string), `decisions[${index}] 引用了不存在的 rightId`);
    assert(['suggested', 'confirmed', 'rejected', 'merged'].includes(raw.status as string), `decisions[${index}].status 非法`);
    assert(isObject(raw.basis) && isObject((raw.basis as Record<string, unknown>).left)
      && isObject((raw.basis as Record<string, unknown>).right), `decisions[${index}].basis 不完整`);
  });
  parsed.merges.forEach((raw, index) => {
    assert(isObject(raw), `merges[${index}] 不是对象`);
    assert(typeof raw.id === 'string' && typeof raw.key === 'string', `merges[${index}] id/key 缺失`);
    assert(recordIds.has(raw.leftId as string) && recordIds.has(raw.rightId as string), `merges[${index}] 引用记录不存在`);
    assert(isObject(raw.values) && isObject(raw.origins) && isObject(raw.choices), `merges[${index}] 内容不完整`);
  });
  return parsed as unknown as OfflinePackage;
}

/** 工作区完整性检查：供载入与导入前后调用；返回问题清单（空数组＝完好）。 */
export function integrityProblems(state: WorkspaceState): string[] {
  const problems: string[] = [];
  const batchIds = new Set(state.batches.map((batch) => batch.id));
  const open = state.batches.find((batch) => batch.id === state.openBatchId);
  if (!open) problems.push('开放工作批次不在批次链中');
  if (open && open.kind !== 'work') problems.push('openBatchId 指向了非 work 批次');

  // 无父的外区离线批次（独立根接续）只有被某个汇入节点引用时才合法
  const referencedByMerge = (id: string) => state.batches.some(
    (batch) => batch.kind === 'import-merge' && batch.parents.includes(id)
  );
  state.batches.forEach((batch) => {
    batch.parents.forEach((parent) => {
      if (!batchIds.has(parent)) problems.push(`批次 ${batch.id} 的祖先 ${parent} 缺失（链断裂）`);
    });
    const rootLike = batch.kind === 'root' || batch.kind === 'legacy-import'
      || (batch.kind === 'offline-edit' && referencedByMerge(batch.id));
    if (!rootLike && !batch.parents.length) {
      problems.push(`批次 ${batch.id} 缺少祖先`);
    }
  });
  Object.keys(state.snapshots).forEach((id) => {
    if (!batchIds.has(id)) problems.push(`存在孤儿快照 ${id}`);
  });

  const checkSnapshot = (snapshot: Snapshot, label: string) => {
    Object.values(snapshot.decisions).forEach((decision) => {
      if (!snapshot.records[decision.leftId] || !snapshot.records[decision.rightId]) {
        problems.push(`${label}: 候选 ${decision.key} 引用的记录缺失`);
      }
    });
    Object.values(snapshot.merges).forEach((merge) => {
      if (!snapshot.records[merge.mergedId]) problems.push(`${label}: 合并 ${merge.id} 的结果记录缺失`);
    });
  };
  checkSnapshot(state.workSnapshot, '工作快照');
  Object.entries(state.snapshots).forEach(([id, snapshot]) => checkSnapshot(snapshot, `批次 ${id}`));
  return problems;
}

// ─────────────────────────────────────────────────────── 导出核对结果 ──

export interface ExportBundle {
  bundleFormat: 'archive-check-export/2';
  workspaceId: string;
  exportedAt: string;
  /** 版本链祖先说明（每个结论可追溯到哪个批次）。 */
  ancestry: {
    openBatchId: string;
    chain: { id: string; kind: BatchKind; label: string; parents: string[]; createdAt: string }[];
  };
  records: RecordSnap[];
  decisions: DecisionSnap[];
  merges: MergeSnap[];
  /** 字段级修订来源清单。 */
  revisions: RevisionEntry[];
  conflictsResolved: ConflictEntry[];
  audit: AuditEntry[];
}

/** 导出当前核对结果；有未裁决分歧时拒绝导出。导出写明祖先链与修订来源。 */
export function buildExportBundle(state: WorkspaceState): ExportBundle {
  const openConflictsList = openConflicts(state);
  if (openConflictsList.length) {
    throw new Error(`仍有 ${openConflictsList.length} 条分歧未裁决，裁决前不能导出`);
  }
  return {
    bundleFormat: 'archive-check-export/2',
    workspaceId: state.workspaceId,
    exportedAt: nowIso(),
    ancestry: {
      openBatchId: state.openBatchId,
      chain: state.batches.map((batch) => ({
        id: batch.id, kind: batch.kind, label: batch.label,
        parents: [...batch.parents], createdAt: batch.createdAt
      }))
    },
    records: Object.values(state.workSnapshot.records),
    decisions: Object.values(state.workSnapshot.decisions),
    merges: Object.values(state.workSnapshot.merges),
    revisions: state.revisions,
    conflictsResolved: state.conflicts,
    audit: state.audit
  };
}

// ─────────────────────────────────────────────────────── v1 旧数据迁移 ──

interface V1Record {
  id: string; group: RecordGroup; title: string; date: string;
  people: string[]; places: string[]; identifier: string; medium: string;
  extent: string; rights: string; notes: string; updatedAt?: string;
}
interface V1Match {
  id: string; leftId: string; rightId: string; score: number;
  fieldScores: Partial<Record<FieldKey, number>>; reasons: string[];
  status: DecisionStatus; reviewedAt?: string;
}
interface V1Merge {
  id: string; matchId: string; leftId: string; rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>; mergedAt: string;
}

/**
 * 旧数据升级：v1 工作区补建祖先链（legacy-import 根），
 * 旧结论按当时评分依据重建后统一过一遍现行规则重算（关键字段已变的会退回待复核）。
 */
export function migrateLegacy(raw: unknown): WorkspaceState {
  assert(isObject(raw), '旧工作区不是对象');
  assert(Array.isArray(raw.records), '旧工作区 records 缺失');
  const v1Records = raw.records as V1Record[];
  const v1Matches = (Array.isArray(raw.matches) ? raw.matches : []) as V1Match[];
  const v1Merges = (Array.isArray(raw.merges) ? raw.merges : []) as V1Merge[];
  const v1Audit = Array.isArray(raw.audit) ? raw.audit as Array<Record<string, unknown>> : [];

  const at = nowIso();
  const legacyId = uid('batch-legacy');
  const rootId = uid('batch-root');
  const workId = uid('batch-work');

  const legacyOrigin: FieldOrigin = { batchId: legacyId, batchLabel: '旧版数据迁移根', via: 'import' };
  const snapshot = emptySnapshot();

  v1Records.forEach((row) => {
    const record: RecordSnap = {
      id: row.id, group: row.group === 'B' ? 'B' : 'A',
      title: row.title ?? '', date: row.date ?? '',
      people: Array.isArray(row.people) ? row.people : [],
      places: Array.isArray(row.places) ? row.places : [],
      identifier: row.identifier ?? '', medium: row.medium ?? '', extent: row.extent ?? '',
      rights: row.rights ?? '', notes: row.notes ?? '',
      origins: {}, updatedAt: row.updatedAt ?? at, sourceBatchId: legacyId
    };
    FIELD_KEYS.forEach((field) => { if (fieldText(record, field)) record.origins[field] = { ...legacyOrigin }; });
    snapshot.records[record.id] = record;
  });

  const likeMap = new Map(Object.values(snapshot.records).map((record) => [record.id, recordToLike(record)]));
  v1Matches.forEach((match) => {
    const left = likeMap.get(match.leftId);
    const right = likeMap.get(match.rightId);
    if (!left || !right) return;
    const basis = decisionBasis(left, right);
    // 保留旧评分痕迹，依据以现行规则重建
    basis.score = typeof match.score === 'number' ? match.score : basis.score;
    if (isObject(match.fieldScores)) basis.fieldScores = { ...basis.fieldScores, ...match.fieldScores };
    if (Array.isArray(match.reasons) && match.reasons.length) basis.reasons = match.reasons as string[];
    snapshot.decisions[matchKey(match.leftId, match.rightId)] = {
      key: matchKey(match.leftId, match.rightId), leftId: match.leftId, rightId: match.rightId,
      status: match.status === 'merged' ? 'suggested' : match.status,
      basis, decidedAt: match.reviewedAt, decidedByBatchId: legacyId
    };
  });

  v1Merges.forEach((merge) => {
    const left = snapshot.records[merge.leftId];
    const right = snapshot.records[merge.rightId];
    if (!left || !right) return;
    const mergedId = uid('record-merged');
    const mergedRecord: RecordSnap = {
      id: mergedId, group: left.group,
      title: merge.values.title ?? left.title, date: merge.values.date ?? left.date,
      people: merge.values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: merge.values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      identifier: merge.values.identifier ?? left.identifier,
      medium: merge.values.medium ?? left.medium, extent: merge.values.extent ?? left.extent,
      rights: merge.values.rights ?? left.rights, notes: merge.values.notes ?? left.notes,
      origins: {}, updatedAt: merge.mergedAt ?? at, sourceBatchId: legacyId
    };
    const origins: MergeSnap['origins'] = {};
    FIELD_KEYS.forEach((field) => {
      const choice = merge.chosen[field] ?? 'A';
      const source = choice === 'B' ? right : left;
      mergedRecord.origins[field] = source.origins[field] ? structuredClone(source.origins[field]!) : { ...legacyOrigin };
      origins[field] = structuredClone(mergedRecord.origins[field]!);
    });
    left.supersededBy = mergedId;
    right.supersededBy = mergedId;
    snapshot.records[mergedId] = mergedRecord;
    const decision = snapshot.decisions[merge.matchId]
      ?? snapshot.decisions[matchKey(merge.leftId, merge.rightId)];
    const mergeSnap: MergeSnap = {
      id: uid('merge'), key: decision?.key ?? matchKey(merge.leftId, merge.rightId),
      leftId: merge.leftId, rightId: merge.rightId, mergedId,
      choices: { ...merge.chosen }, values: { ...merge.values }, origins,
      basis: decision ? structuredClone(decision.basis) : decisionBasis(recordToLike(left), recordToLike(right)),
      batchId: legacyId, createdAt: merge.mergedAt ?? at
    };
    snapshot.merges[mergeSnap.id] = mergeSnap;
    if (decision) {
      decision.status = 'merged';
      decision.decidedAt = merge.mergedAt;
      decision.decidedByBatchId = legacyId;
    }
  });

  // 升级后按现行规则统一重算：依据过期的旧结论退回待复核
  const report = recomputePass(snapshot);

  const state: WorkspaceState = {
    formatVersion: 2,
    workspaceId: uid('workspace'),
    batches: [
      { id: legacyId, kind: 'legacy-import', origin: 'migration', parents: [], label: '旧版数据迁移根', createdAt: at },
      { id: rootId, kind: 'root', origin: 'migration', parents: [legacyId], label: '升级后始祖批次', createdAt: at },
      { id: workId, kind: 'work', origin: 'local', parents: [rootId], label: '馆内工作批次', createdAt: at }
    ],
    snapshots: {
      [legacyId]: cloneSnapshot(snapshot),
      [rootId]: cloneSnapshot(snapshot)
    },
    openBatchId: workId,
    workSnapshot: cloneSnapshot(snapshot),
    conflicts: [],
    revisions: [{
      id: uid('rev'), at, batchId: workId, sourceBatchId: legacyId, sourceBatchLabel: '旧版数据迁移根',
      action: '旧数据升级',
      detail: `v1 工作区升级为版本链结构，补建祖先批次；现行规则重算退回 ${report.reopened.length} 条结论`,
      targetType: 'batch', targetId: legacyId
    }],
    audit: [
      {
        id: uid('audit'), at, batchId: workId, sourceBatchId: legacyId, sourceBatchLabel: '旧版数据迁移根',
        action: '旧数据升级',
        detail: `${v1Records.length} 条记录、${v1Matches.length} 条候选、${v1Merges.length} 项合并迁入版本链`,
        recordIds: v1Records.map((record) => record.id)
      },
      ...v1Audit.slice(0, 100).map((entry) => ({
        id: uid('audit-legacy'), at: typeof entry.at === 'string' ? entry.at : at,
        batchId: legacyId, action: String(entry.action ?? '旧版操作'),
        detail: String(entry.detail ?? ''), recordIds: Array.isArray(entry.recordIds) ? entry.recordIds as string[] : []
      }))
    ],
    hydrated: false
  };
  return state;
}

export const isLegacyState = (raw: unknown): raw is LegacyStateShape =>
  isObject(raw) && raw.formatVersion !== 2 && Array.isArray(raw.records);
