import type {
  ArchiveRecord, AuditEntry, AutoChange, Batch, Conflict, FieldKey, FieldSource,
  MatchCandidate, MergeResult, ReconciliationPackage, RecordStatus, Revision,
  SideConclusion, StagedImport, StateContent, WorkspaceState
} from '../types';
import { ARRAY_FIELDS, FIELD_KEYS } from '../types';
import {
  canonicalStringify, checksumOf, contentOf, deepClone, fieldSource, fieldSignature, fieldText,
  findMergeBase, makeBatch, nowIso, uid
} from './core';
import { recompute, affectedRecordIds } from './recompute';

export type ParsedPackage =
  | { ok: true; pkg: ReconciliationPackage; legacy?: false }
  | { ok: true; pkg: ReconciliationPackage; legacy: true; legacyLabel: string }
  | { ok: false; error: string };

const PK_FIELDS = ['records', 'matches', 'merges', 'audit', 'batches', 'revisions', 'baseState', 'head', 'baseAncestorId'];

/** 解析并校验核对包；校验失败时返回原因，工作区保持原样。 */
export async function parsePackage(rawText: string, fileName: string): Promise<ParsedPackage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，包未被读取，工作区未改动。' };
  }
  const obj = parsed as Partial<ReconciliationPackage> | undefined;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.records)) {
    return { ok: false, error: '包结构不完整（缺少 records），已中止导入。' };
  }
  // 旧版导出（扁平、无修订链）：迁移补祖先后按"外来包"处理
  if (obj.format !== 2 || obj.packageType !== 'sologsb-reconciliation' || !obj.head || !obj.revisions) {
    if (Array.isArray(obj.records) && !obj.revisions) {
      return migrateLegacyPackage(obj, fileName);
    }
    return { ok: false, error: '包格式版本不受支持（需 format=2 的核对包），已中止导入。' };
  }
  if (typeof obj.checksum !== 'string' || !obj.checksum) {
    return { ok: false, error: '包缺少校验和，可能已损坏，已中止导入。' };
  }
  const checkPart: Record<string, unknown> = {};
  PK_FIELDS.forEach((key) => { checkPart[key] = (obj as Record<string, unknown>)[key]; });
  ['format', 'packageType', 'schemaVersion', 'workspaceId', 'exportedAt', 'ruleVersion'].forEach((key) => {
    checkPart[key] = (obj as Record<string, unknown>)[key];
  });
  const actual = await checksumOf(checkPart);
  if (actual !== obj.checksum) {
    return { ok: false, error: '校验和不一致：包可能损坏或被截断，已中止导入（原工作区可重试导入）。' };
  }
  if (!obj.revisions.some((revision) => revision.id === obj.head!.revisionId)) {
    return { ok: false, error: '包头修订不在版本链中，包结构损坏，已中止导入。' };
  }
  return { ok: true, pkg: obj as ReconciliationPackage };
}

// ---- 三方接续预演 ----

interface MergeContext {
  conflicts: Conflict[];
  auto: AutoChange[];
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  affected: string[];
}

const statusText = (status?: RecordStatus) =>
  status === 'confirmed' ? '已确认' : status === 'merged' ? '已合并' : '未核对';

export const fieldLabel = (field: FieldKey): string => {
  const labels: Record<FieldKey, string> = {
    title: '标题', date: '日期', people: '人物', places: '地点', identifier: '编号',
    medium: '载体', extent: '数量', rights: '权利', notes: '备注'
  };
  return labels[field];
};

export const matchDecisionLabel = (status: MatchCandidate['status']) =>
  status === 'confirmed' ? '确认' : status === 'rejected' ? '忽略' : status === 'merged' ? '已合并' : '待复核';

export const chosenLabel = (choice: 'A' | 'B' | 'combine') =>
  choice === 'A' ? '保留 A 来源' : choice === 'B' ? '保留 B 来源' : '双来源拼接';

const RULE_FIELD_SET = new Set<FieldKey>(['title', 'date', 'people', 'places']);

function fieldSide(record: ArchiveRecord | undefined, field: FieldKey, baseRecord: ArchiveRecord | undefined): SideConclusion {
  const changed = record
    ? (baseRecord ? fieldSignature(baseRecord, field) !== fieldSignature(record, field) : fieldSignature(record, field) !== '')
    : false;
  return {
    changed,
    present: Boolean(record),
    batchId: record?.provenance[field]?.batchId,
    revisionId: record?.provenance[field]?.revisionId,
    at: record?.provenance[field]?.at,
    raw: record ? (record[field] as string | string[]) : undefined,
    text: record ? fieldText(record[field] as string | string[]) : ''
  };
}

function projectRecordFields(
  ctx: MergeContext,
  localRecord: ArchiveRecord,
  incomingRecord: ArchiveRecord,
  baseRecord: ArchiveRecord | undefined,
  bothAdded: boolean
) {
  const projected: ArchiveRecord = deepClone(localRecord);
  const autoFields: FieldKey[] = [];

  FIELD_KEYS.forEach((field) => {
    const baseSig = baseRecord ? fieldSignature(baseRecord, field) : null;
    const localSig = fieldSignature(localRecord, field);
    const incomingSig = fieldSignature(incomingRecord, field);
    const localChanged = baseSig === null ? localSig !== '' : localSig !== baseSig;
    const incomingChanged = baseSig === null ? incomingSig !== '' : incomingSig !== baseSig;

    if (localChanged && incomingChanged && localSig !== incomingSig) {
      ctx.conflicts.push({
        id: uid('conflict'),
        subject: 'record-field',
        recordId: localRecord.id,
        field,
        baseText: baseRecord ? fieldText(baseRecord[field] as string | string[]) : null,
        local: fieldSide(localRecord, field, baseRecord),
        incoming: fieldSide(incomingRecord, field, baseRecord)
      });
      return; // 暂留本账值占位，裁决提交时覆盖
    }
    if (incomingChanged && (!localChanged || localSig === incomingSig)) {
      (projected[field] as string | string[]) = deepClone(incomingRecord[field]);
      if (incomingRecord.provenance[field]) projected.provenance[field] = deepClone(incomingRecord.provenance[field]!);
      autoFields.push(field);
      return;
    }
    // 仅本账改过 / 两侧改成相同值：保留本账（相同值时补齐缺失来源）
    if (!projected.provenance[field] && incomingRecord.provenance[field]) {
      projected.provenance[field] = deepClone(incomingRecord.provenance[field]!);
    }
  });

  // 记录状态三方处理
  const baseStatus = baseRecord?.status ?? 'unreviewed';
  const lChanged = localRecord.status !== baseStatus;
  const iChanged = incomingRecord.status !== baseStatus;
  if (lChanged && iChanged && localRecord.status !== incomingRecord.status) {
    ctx.conflicts.push({
      id: uid('conflict'),
      subject: 'record-status',
      recordId: localRecord.id,
      baseText: statusText(baseStatus),
      local: { changed: true, present: true, text: statusText(localRecord.status), raw: localRecord.status },
      incoming: { changed: true, present: true, text: statusText(incomingRecord.status), raw: incomingRecord.status }
    });
  } else if (iChanged && (!lChanged || localRecord.status === incomingRecord.status)) {
    projected.status = incomingRecord.status;
  }
  projected.stale = localRecord.stale || incomingRecord.stale || undefined;
  projected.staleReason = localRecord.staleReason ?? incomingRecord.staleReason;
  projected.updatedAt = localRecord.updatedAt > incomingRecord.updatedAt ? localRecord.updatedAt : incomingRecord.updatedAt;

  ctx.records.push(projected);
  if (autoFields.length) {
    ctx.auto.push({
      kind: 'record-changed',
      entityId: localRecord.id,
      side: 'incoming',
      summary: `${localRecord.title}：对方修改自动接续（${autoFields.map(fieldLabel).join('、')}）`,
      fields: autoFields
    });
    if (autoFields.some((field) => RULE_FIELD_SET.has(field))) ctx.affected.push(localRecord.id);
  }
  if (bothAdded) ctx.auto.push({ kind: 'record-added', entityId: localRecord.id, side: 'both', summary: `双方各自新增同一记录：${localRecord.title}` });
}

function mergeRecords(ctx: MergeContext, local: StateContent, base: StateContent | null, incoming: StateContent) {
  const baseById = new Map(base?.records.map((record) => [record.id, record]) ?? []);
  const localById = new Map(local.records.map((record) => [record.id, record]));
  const incomingById = new Map(incoming.records.map((record) => [record.id, record]));

  new Set<string>([...localById.keys(), ...incomingById.keys()]).forEach((id) => {
    const baseRecord = baseById.get(id);
    const localRecord = localById.get(id);
    const incomingRecord = incomingById.get(id);

    if (!baseRecord) {
      if (localRecord && !incomingRecord) { ctx.records.push(deepClone(localRecord)); return; }
      if (incomingRecord && !localRecord) {
        ctx.records.push(deepClone(incomingRecord));
        ctx.auto.push({
          kind: 'record-added', entityId: id, side: 'incoming',
          summary: `对方新增记录：${incomingRecord.title}`,
          fields: FIELD_KEYS.filter((field) => incomingRecord.provenance[field])
        });
        ctx.affected.push(id);
        return;
      }
      if (localRecord && incomingRecord) {
        projectRecordFields(ctx, localRecord, incomingRecord, undefined, true);
        return;
      }
    }
    if (!localRecord) { ctx.records.push(deepClone(incomingRecord!)); return; }
    if (!incomingRecord) { ctx.records.push(deepClone(localRecord)); return; }
    projectRecordFields(ctx, localRecord, incomingRecord, baseRecord, false);
  });
}

function decisionSide(match: MatchCandidate): SideConclusion {
  return {
    changed: match.status !== 'suggested',
    present: true,
    text: matchDecisionLabel(match.status),
    status: match.status,
    raw: match.status,
    batchId: match.decidedBy,
    revisionId: match.decidedIn,
    at: match.reviewedAt
  };
}

function mergeMatches(ctx: MergeContext, local: StateContent, base: StateContent | null, incoming: StateContent) {
  const baseById = new Map(base?.matches.map((match) => [match.id, match]) ?? []);
  const localById = new Map(local.matches.map((match) => [match.id, match]));
  const incomingById = new Map(incoming.matches.map((match) => [match.id, match]));

  new Set<string>([...localById.keys(), ...incomingById.keys()]).forEach((id) => {
    const baseMatch = baseById.get(id);
    const localMatch = localById.get(id);
    const incomingMatch = incomingById.get(id);

    if (!baseMatch) {
      if (localMatch && !incomingMatch) { ctx.matches.push(deepClone(localMatch)); return; }
      if (incomingMatch && !localMatch) {
        ctx.matches.push(deepClone(incomingMatch));
        ctx.auto.push({
          kind: incomingMatch.status === 'suggested' ? 'match-added' : 'match-decision',
          entityId: id, side: 'incoming',
          summary: incomingMatch.status === 'suggested'
            ? `对方计算出新候选（${Math.round(incomingMatch.score * 100)}%）：${incomingMatch.leftId} ↔ ${incomingMatch.rightId}`
            : `对方带来候选结论「${matchDecisionLabel(incomingMatch.status)}」：${incomingMatch.leftId} ↔ ${incomingMatch.rightId}`
        });
        return;
      }
    }
    if (!localMatch) { ctx.matches.push(deepClone(incomingMatch!)); return; }
    if (!incomingMatch) { ctx.matches.push(deepClone(localMatch)); return; }

    const baseStatus = baseMatch?.status ?? 'suggested';
    const lChanged = localMatch.status !== baseStatus;
    const iChanged = incomingMatch.status !== baseStatus;
    if (lChanged && iChanged && localMatch.status !== incomingMatch.status) {
      ctx.conflicts.push({
        id: uid('conflict'),
        subject: 'match-decision',
        matchId: id,
        baseText: matchDecisionLabel(baseStatus),
        local: decisionSide(localMatch),
        incoming: decisionSide(incomingMatch)
      });
      ctx.matches.push(deepClone(localMatch));
      return;
    }
    if (iChanged && (!lChanged || localMatch.status === incomingMatch.status)) {
      const adopted = deepClone(incomingMatch);
      ctx.matches.push(adopted);
      ctx.auto.push({
        kind: 'match-decision', entityId: id, side: 'incoming',
        summary: `候选 ${adopted.leftId} ↔ ${adopted.rightId}：对方结论「${matchDecisionLabel(adopted.status)}」自动生效`
      });
      return;
    }
    // 仅本账改或两侧相同：保留本账结论
    ctx.matches.push(deepClone(localMatch));
  });
}

function mergeFieldSide(merge: MergeResult, field: FieldKey): SideConclusion {
  const choice = merge.chosen[field];
  return {
    changed: choice !== undefined,
    present: true,
    chosen: choice,
    chosenText: choice ? chosenLabel(choice) : '',
    text: merge.values[field] ?? (choice ? chosenLabel(choice) : ''),
    batchId: merge.choiceSource[field]?.batchId ?? merge.batchId,
    revisionId: merge.choiceSource[field]?.revisionId ?? merge.revisionId,
    at: merge.choiceSource[field]?.at ?? merge.mergedAt
  };
}

function mergeMerges(ctx: MergeContext, local: StateContent, base: StateContent | null, incoming: StateContent) {
  const baseById = new Map(base?.merges.map((merge) => [merge.id, merge]) ?? []);
  const localById = new Map(local.merges.map((merge) => [merge.id, merge]));
  const incomingById = new Map(incoming.merges.map((merge) => [merge.id, merge]));

  new Set<string>([...localById.keys(), ...incomingById.keys()]).forEach((id) => {
    const baseMerge = baseById.get(id);
    const localMerge = localById.get(id);
    const incomingMerge = incomingById.get(id);

    if (!baseMerge) {
      if (localMerge && !incomingMerge) { ctx.merges.push(deepClone(localMerge)); return; }
      if (incomingMerge && !localMerge) {
        ctx.merges.push(deepClone(incomingMerge));
        ctx.auto.push({ kind: 'merge-added', entityId: id, side: 'incoming', summary: `对方带来合并结论：${incomingMerge.leftId} ↔ ${incomingMerge.rightId}` });
        return;
      }
    }
    if (!localMerge) { ctx.merges.push(deepClone(incomingMerge!)); return; }
    if (!incomingMerge) { ctx.merges.push(deepClone(localMerge)); return; }

    const projected: MergeResult = deepClone(localMerge);
    FIELD_KEYS.forEach((field) => {
      const baseChoice = baseMerge?.chosen[field];
      const lChoice = localMerge.chosen[field];
      const iChoice = incomingMerge.chosen[field];
      const lChanged = lChoice !== baseChoice;
      const iChanged = iChoice !== baseChoice;
      if (lChanged && iChanged && lChoice !== iChoice) {
        ctx.conflicts.push({
          id: uid('conflict'),
          subject: 'merge-field',
          mergeId: id,
          matchId: localMerge.matchId,
          field,
          baseText: baseChoice ? chosenLabel(baseChoice) : null,
          local: mergeFieldSide(localMerge, field),
          incoming: mergeFieldSide(incomingMerge, field)
        });
        return;
      }
      if (iChanged && (!lChanged || lChoice === iChoice)) {
        projected.chosen[field] = iChoice;
        projected.values[field] = incomingMerge.values[field];
        if (incomingMerge.choiceSource[field]) projected.choiceSource[field] = deepClone(incomingMerge.choiceSource[field]!);
      }
    });
    if (incomingMerge.supersededBy && !projected.supersededBy) projected.supersededBy = incomingMerge.supersededBy;
    ctx.merges.push(projected);
  });
}

export function mergeRevisionLists(localRevisions: Revision[], incomingRevisions: Revision[]): Revision[] {
  const seen = new Set<string>();
  const merged: Revision[] = [];
  [...localRevisions, ...incomingRevisions].forEach((revision) => {
    if (!seen.has(revision.id)) { seen.add(revision.id); merged.push(revision); }
  });
  return merged;
}

/**
 * 预演接续导入：计算共同祖先、快进判定、自动生效项与冲突。不改动工作区。
 * @param baseContent 共同祖先处内容：App 层优先从本地快照表精确取得；否则回退包内 baseState
 */
export function stageImport(
  state: WorkspaceState,
  pkg: ReconciliationPackage,
  fileName: string,
  baseContentOverride: StateContent | null,
  legacyNote?: string
): StagedImport {
  const local: StateContent = { records: state.records, matches: state.matches, merges: state.merges };
  const incoming: StateContent = { records: pkg.records, matches: pkg.matches, merges: pkg.merges };

  const combinedRevisions = mergeRevisionLists(state.revisions, pkg.revisions);
  const graphBase = findMergeBase(combinedRevisions, state.headId, pkg.head.revisionId);
  const baseRevisionId = graphBase;
  const baseContent = baseContentOverride
    ?? (graphBase && pkg.baseState && pkg.baseAncestorId === graphBase ? pkg.baseState : null)
    ?? (graphBase ? pkg.baseState : null)
    ?? pkg.baseState;

  const isFastForward = Boolean(state.headId && graphBase === state.headId && graphBase !== pkg.head.revisionId);

  const ctx: MergeContext = { conflicts: [], auto: [], records: [], matches: [], merges: [], affected: [] };
  if (isFastForward) {
    ctx.records = incoming.records.map((record) => deepClone(record));
    ctx.matches = incoming.matches.map((match) => deepClone(match));
    ctx.merges = incoming.merges.map((merge) => deepClone(merge));
    ctx.auto.push({ kind: 'record-changed', entityId: '*', side: 'incoming', summary: '本账自共同祖先以来无独立修订，快进到对方头版本，全部内容直接生效' });
  } else {
    mergeRecords(ctx, local, baseContent, incoming);
    mergeMatches(ctx, local, baseContent, incoming);
    mergeMerges(ctx, local, baseContent, incoming);
    if (baseContent) {
      affectedRecordIds(baseContent, incoming).forEach((id) => ctx.affected.push(id));
    } else {
      incoming.records.forEach((record) => ctx.affected.push(record.id));
    }
  }

  const allBatches = new Map<string, Batch>();
  state.batches.forEach((batch) => allBatches.set(batch.id, batch));
  pkg.batches.forEach((batch) => allBatches.set(batch.id, batch));
  ctx.conflicts.forEach((conflict) => {
    if (conflict.local.batchId) conflict.local.label = allBatches.get(conflict.local.batchId)?.label ?? conflict.local.batchId.slice(0, 10);
    if (conflict.incoming.batchId) conflict.incoming.label = allBatches.get(conflict.incoming.batchId)?.label ?? conflict.incoming.batchId.slice(0, 10);
  });

  return {
    mode: legacyNote ? 'legacy-package' : 'package',
    fileName,
    localHead: state.headId ?? '',
    incomingHead: pkg.head.revisionId,
    baseRevisionId,
    baseAncestryLabel: baseRevisionId
      ? `修订 ${baseRevisionId.slice(6, 12)}`
      : baseContent
        ? '包内祖先快照（版本图外）'
        : '无共同祖先（按外来新账处理）',
    isFastForward,
    conflicts: ctx.conflicts,
    autoChanges: ctx.auto,
    records: ctx.records,
    matches: ctx.matches,
    merges: ctx.merges,
    incomingBatches: pkg.batches.filter((batch) => !state.batches.some((existing) => existing.id === batch.id)).map((item) => deepClone(item)),
    incomingRevisions: pkg.revisions.filter((revision) => !state.revisions.some((existing) => existing.id === revision.id)).map((item) => deepClone(item)),
    incomingAudit: pkg.audit.filter((entry) => !state.audit.some((existing) => existing.id === entry.id)).map((item) => deepClone(item)),
    incomingSnapshot: contentOf(incoming),
    affectedIds: [...new Set(ctx.affected)],
    stageBatchId: makeBatch('package', `核对包接续 · ${fileName}`, 'local', { sourcePackage: fileName, note: legacyNote }).id,
    commitRevisionId: uid('rev'),
    legacyNote
  };
}

// ---- 冲突裁决提交 ----

export interface CommitResult {
  content: StateContent;
  batches: Batch[];
  revisions: Revision[];
  audit: AuditEntry[];
  revision: Revision;
  batch: Batch;
  resetSummary: { count: number; added: number };
}

/** 把已全部裁决的暂存接续提交为双父修订；提交后按现行规则重算。 */
export function commitStagedImport(
  state: WorkspaceState,
  stage: StagedImport
): CommitResult {
  const unresolved = stage.conflicts.filter((conflict) => !conflict.resolution);
  if (unresolved.length) {
    throw new Error(`还有 ${unresolved.length} 处冲突未裁决，不能接续合并。`);
  }

  const records = stage.records.map((item) => deepClone(item));
  const matches = stage.matches.map((item) => deepClone(item));
  const merges = stage.merges.map((item) => deepClone(item));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const mergeById = new Map(merges.map((merge) => [merge.id, merge]));
  const source = (): FieldSource => fieldSource(stage.stageBatchId, stage.commitRevisionId);

  stage.conflicts.forEach((conflict) => {
    const resolution = conflict.resolution!;
    if (conflict.subject === 'record-field' && conflict.recordId && conflict.field) {
      const record = recordById.get(conflict.recordId)!;
      const field = conflict.field;
      if (resolution.pick === 'custom') {
        if (ARRAY_FIELDS.includes(field)) {
          (record[field] as string[]) = (resolution.custom ?? '').split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean);
        } else {
          (record[field] as string) = resolution.custom ?? '';
        }
      } else {
        const from = resolution.pick === 'local'
          ? state.records.find((item) => item.id === conflict.recordId)!
          : stage.incomingSnapshot.records.find((item) => item.id === conflict.recordId)!;
        (record[field] as string | string[]) = deepClone(from[field]);
        if (from.provenance[field]) record.provenance[field] = deepClone(from.provenance[field]!);
      }
      record.provenance[field] = {
        ...source(),
        note: `冲突裁决：${resolution.pick === 'custom' ? '自定义取值' : resolution.pick === 'local' ? '保留本账结论' : '采用对方结论'}`
      };
      record.updatedAt = nowIso();
      if (RULE_FIELD_SET.has(field)) stage.affectedIds.push(record.id);
    }

    if (conflict.subject === 'record-status' && conflict.recordId) {
      const record = recordById.get(conflict.recordId)!;
      record.status = (resolution.pick === 'custom' ? resolution.custom : (resolution.pick === 'local' ? conflict.local.raw : conflict.incoming.raw)) as RecordStatus;
    }

    if (conflict.subject === 'match-decision' && conflict.matchId) {
      const match = matchById.get(conflict.matchId);
      if (!match) return;
      if (resolution.pick === 'custom') {
        match.status = resolution.custom as MatchCandidate['status'];
      } else if (resolution.pick === 'local') {
        const from = state.matches.find((item) => item.id === conflict.matchId)!;
        match.status = from.status;
        match.reviewedAt = from.reviewedAt;
        match.decidedBy = from.decidedBy;
        match.decidedIn = from.decidedIn;
        match.oldBasis = from.oldBasis ? deepClone(from.oldBasis) : undefined;
      } else {
        const from = stage.incomingSnapshot.matches.find((item) => item.id === conflict.matchId)!;
        match.status = from.status;
        match.reviewedAt = from.reviewedAt;
        match.decidedBy = from.decidedBy;
        match.decidedIn = from.decidedIn;
        match.oldBasis = from.oldBasis ? deepClone(from.oldBasis) : undefined;
      }
      // 裁决本身也是一个新的人工结论批次
      match.decidedBy = stage.stageBatchId;
      match.decidedIn = stage.commitRevisionId;
      match.reviewedAt = nowIso();
    }

    if (conflict.subject === 'merge-field' && conflict.mergeId && conflict.field) {
      const merge = mergeById.get(conflict.mergeId);
      if (!merge) return;
      const field = conflict.field;
      if (resolution.pick === 'custom') {
        merge.chosen[field] = 'combine';
        merge.values[field] = resolution.custom;
      } else {
        const side = resolution.pick === 'local' ? conflict.local : conflict.incoming;
        const fromMerge = resolution.pick === 'local'
          ? state.merges.find((item) => item.id === conflict.mergeId)!
          : stage.incomingSnapshot.merges.find((item) => item.id === conflict.mergeId)!;
        if (side.chosen) merge.chosen[field] = side.chosen;
        merge.values[field] = fromMerge.values[field];
        if (fromMerge.choiceSource[field]) merge.choiceSource[field] = deepClone(fromMerge.choiceSource[field]!);
      }
      merge.choiceSource[field] = { ...source(), note: '合并字段冲突裁决' };
      const mergedRecord = recordById.get(merge.mergedRecordId);
      if (mergedRecord) {
        if (ARRAY_FIELDS.includes(field)) {
          (mergedRecord[field] as string[]) = (merge.values[field] ?? '').split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean);
        } else {
          (mergedRecord[field] as string) = merge.values[field] ?? '';
        }
        mergedRecord.provenance[field] = { ...source(), note: '合并字段冲突裁决' };
      }
    }
  });

  const before: StateContent = { records: state.records, matches: state.matches, merges: state.merges };
  const projected: StateContent = { records, matches, merges };
  const affected = new Set<string>([...stage.affectedIds, ...affectedRecordIds(before, projected)]);
  const recomputed = recompute(projected, [...affected], stage.stageBatchId, stage.isFastForward ? '快进接续导入' : '三方接续导入');

  const batch: Batch = {
    id: stage.stageBatchId,
    kind: 'package',
    label: `核对包接续 · ${stage.fileName}`,
    at: nowIso(),
    source: 'local',
    sourcePackage: stage.fileName,
    note: [
      stage.isFastForward ? '快进接续' : `共同祖先：${stage.baseAncestryLabel}`,
      `冲突裁决 ${stage.conflicts.length} 处`,
      stage.legacyNote
    ].filter(Boolean).join('；')
  };

  const revision: Revision = {
    id: stage.commitRevisionId,
    parents: stage.isFastForward || !state.headId
      ? [stage.incomingHead]
      : [state.headId, stage.incomingHead],
    batchId: batch.id,
    at: nowIso(),
    message: stage.isFastForward
      ? `快进接续核对包 ${stage.fileName}`
      : `三方接续核对包 ${stage.fileName}（${stage.conflicts.length} 处裁决）`,
    incomingHead: stage.incomingHead,
    mergeBase: stage.baseRevisionId ?? undefined
  };

  const audit: AuditEntry[] = [{
    id: uid('audit'),
    at: nowIso(),
    action: stage.isFastForward ? '快进接续核对包' : '三方接续核对包',
    detail: `共同祖先：${stage.baseAncestryLabel}；自动生效 ${stage.autoChanges.length} 项；冲突裁决 ${stage.conflicts.length} 处；按现行规则重算：${recomputed.resets.length} 条旧结论带旧依据回到待复核，新增候选 ${recomputed.added.length} 条`,
    recordIds: [...affected].slice(0, 50),
    batchId: batch.id,
    revisionId: revision.id
  }];

  return {
    content: recomputed.content,
    batches: [...stage.incomingBatches, batch],
    revisions: [...stage.incomingRevisions, revision],
    audit,
    revision,
    batch,
    resetSummary: { count: recomputed.resets.length, added: recomputed.added.length }
  };
}

// ---- 旧版（无版本链）包迁移为伪核对包 ----

const emptyFieldScores = (): Record<FieldKey, number> => ({
  title: 0, date: 0, people: 0, places: 0, identifier: 0, medium: 0, extent: 0, rights: 0, notes: 0
});

async function migrateLegacyPackage(obj: Partial<ReconciliationPackage>, fileName: string): Promise<ParsedPackage> {
  const rootRevisionId = uid('rev');
  const headRevisionId = uid('rev');
  const batchId = uid('batch');
  const at = nowIso();
  const records = (obj.records ?? []).map((partial: Partial<ArchiveRecord>) => {
    const record = partial as ArchiveRecord;
    const provenance = record.provenance ?? {};
    FIELD_KEYS.forEach((field) => {
      if (!provenance[field]) provenance[field] = fieldSource(batchId, headRevisionId, '旧数据升级');
    });
    return {
      ...record,
      id: record.id ?? uid('rec'),
      group: record.group ?? 'A',
      people: Array.isArray(record.people) ? record.people : [],
      places: Array.isArray(record.places) ? record.places : [],
      status: (record.status as string) === 'rejected' ? 'unreviewed' : (record.status ?? 'unreviewed'),
      batchId: record.batchId ?? batchId,
      provenance
    } satisfies ArchiveRecord;
  });
  const matches = (obj.matches ?? []).map((partial: Partial<MatchCandidate>) => ({
    ...(partial as MatchCandidate),
    id: partial.id ?? uid('match'),
    fieldScores: partial.fieldScores ?? emptyFieldScores(),
    status: partial.status ?? 'suggested',
    reasons: partial.reasons ?? [],
    ruleVersion: 'legacy-1'
  }));
  const merges = (obj.merges ?? []).map((partial: Partial<MergeResult>) => ({
    ...(partial as MergeResult),
    id: partial.id ?? uid('merge'),
    chosen: partial.chosen ?? {},
    values: partial.values ?? {},
    choiceSource: partial.choiceSource ?? {},
    batchId: partial.batchId ?? batchId,
    revisionId: partial.revisionId ?? headRevisionId
  }));
  const audit = (obj.audit ?? []).map((partial: Partial<AuditEntry>) => ({
    id: partial.id ?? uid('audit'),
    at: partial.at ?? at,
    action: partial.action ?? '旧版审计记录',
    detail: partial.detail ?? '',
    recordIds: partial.recordIds ?? [],
    batchId: partial.batchId ?? batchId,
    revisionId: partial.revisionId ?? headRevisionId
  }));
  const pkg: ReconciliationPackage = {
    format: 2,
    packageType: 'sologsb-reconciliation',
    schemaVersion: 1,
    workspaceId: uid('workspace'),
    exportedAt: at,
    ruleVersion: 'legacy-1',
    head: { revisionId: headRevisionId, batchId },
    baseAncestorId: null,
    records, matches, merges, audit,
    batches: [{ id: batchId, kind: 'migration', label: `旧版包 ${fileName}`, at, source: 'incoming', note: '无版本链旧数据，升级时补祖先根' }],
    revisions: [
      { id: rootRevisionId, parents: [], batchId, at, message: '旧数据升级：补祖先根' },
      { id: headRevisionId, parents: [rootRevisionId], batchId, at, message: '旧版核对包内容迁移' }
    ],
    baseState: null,
    checksum: ''
  };
  const checkPart: Record<string, unknown> = {};
  PK_FIELDS.forEach((key) => { checkPart[key] = (pkg as unknown as Record<string, unknown>)[key]; });
  ['format', 'packageType', 'schemaVersion', 'workspaceId', 'exportedAt', 'ruleVersion'].forEach((key) => {
    checkPart[key] = (pkg as unknown as Record<string, unknown>)[key];
  });
  pkg.checksum = await checksumOf(checkPart);
  return { ok: true, pkg, legacy: true, legacyLabel: `${fileName} 是无版本链旧包，已补虚拟祖先，将按外来包接续。` };
}

/** 用给定批次/修订把一条不完整记录补全为 v2 记录（本地原始导入复用）。 */
export function completeRecord(
  partial: Partial<ArchiveRecord>,
  id: string,
  group: ArchiveRecord['group'],
  batchId: string,
  revisionId: string
): ArchiveRecord {
  const at = nowIso();
  const provenance = partial.provenance ?? {};
  FIELD_KEYS.forEach((field) => {
    if (!provenance[field]) provenance[field] = fieldSource(batchId, revisionId, '导入来源');
  });
  return {
    id,
    group: partial.group ?? group,
    title: partial.title ?? '未命名记录',
    date: partial.date ?? '',
    people: Array.isArray(partial.people)
      ? partial.people
      : (partial.people ? String(partial.people).split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean) : []),
    places: Array.isArray(partial.places)
      ? partial.places
      : (partial.places ? String(partial.places).split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean) : []),
    identifier: partial.identifier ?? '',
    medium: partial.medium ?? '',
    extent: partial.extent ?? '',
    rights: partial.rights ?? '',
    notes: partial.notes ?? '',
    updatedAt: partial.updatedAt ?? at,
    status: partial.status === 'merged' || partial.status === 'confirmed' ? partial.status : 'unreviewed',
    batchId,
    provenance
  };
}

export { canonicalStringify };
