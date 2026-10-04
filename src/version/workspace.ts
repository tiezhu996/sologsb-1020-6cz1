import type {
  ArchiveRecord, AuditEntry, Batch, FieldKey, FieldSource, MatchCandidate,
  MergeResult, PersistedWorkspace, ReconciliationPackage, RecordGroup, StateContent, WorkspaceState
} from '../types';
import { FIELD_KEYS } from '../types';
import {
  canonicalStringify, checksumOf, contentOf, deepClone, fieldSource, makeBatch, makeRevision,
  nowIso, uid, WORKSPACE_FORMAT
} from './core';
import { computeMatches, matchPairId, scoreCandidate, scorePair } from '../utils/matching';
import { recompute } from './recompute';
import { seedState, SEED_BATCH_ID, SEED_REVISION_ID } from '../data/seed';
import { completeRecord } from './merge';

export const STORAGE_KEY = 'sologsb-1020-workspace-v2';
const STAGING_KEY = `${STORAGE_KEY}.staging`;
const LEGACY_KEY = 'sologsb-1020-archive-state-v1';

// ---- 持久化：先写 staging 再提交，损坏/中断后原工作区可重试 ----

export function saveWorkspace(persisted: PersistedWorkspace): void {
  try {
    const payload = JSON.stringify(persisted);
    localStorage.setItem(STAGING_KEY, payload);
    localStorage.setItem(STORAGE_KEY, payload);
    localStorage.removeItem(STAGING_KEY);
  } catch (error) {
    // 配额等错误不破坏既有工作区
    console.error('工作区保存失败', error);
  }
}

export function loadWorkspace(): { state: PersistedWorkspace; recovered: boolean } | null {
  const committed = localStorage.getItem(STORAGE_KEY);
  const staged = localStorage.getItem(STAGING_KEY);
  try {
    if (committed) {
      const parsed = JSON.parse(committed) as PersistedWorkspace;
      if (parsed.format === 2 && Array.isArray(parsed.revisions) && parsed.headId) {
        if (staged) localStorage.removeItem(STAGING_KEY);
        return { state: parsed, recovered: false };
      }
    }
    // 正式写缺失/损坏，但 staging 完整：恢复 staging（中断的那次写入）
    if (staged) {
      const parsed = JSON.parse(staged) as PersistedWorkspace;
      if (parsed.format === 2 && parsed.headId) {
        localStorage.setItem(STORAGE_KEY, staged);
        localStorage.removeItem(STAGING_KEY);
        return { state: parsed, recovered: true };
      }
    }
  } catch {
    // 两份都损坏：保留坏副本以便排查，回落到全新工作区
    if (committed) localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, committed);
    if (staged) localStorage.removeItem(STAGING_KEY);
    localStorage.removeItem(STORAGE_KEY);
  }
  return null;
}

// ---- 旧数据升级：补祖先（单一根修订 + 建账批次，全部字段溯源回填） ----

export function migrateLegacyState(raw: unknown): PersistedWorkspace {
  const old = raw as {
    records?: ArchiveRecord[]; matches?: MatchCandidate[]; merges?: MergeResult[];
    audit?: AuditEntry[];
  };
  const at = nowIso();
  const rootRevisionId = 'rev-migrated-root';
  const batchId = 'batch-migrated-v1';
  const batch: Batch = {
    id: batchId, kind: 'migration', label: '旧数据升级（补祖先）', at, source: 'local',
    note: 'v1 扁平工作区升级为版本链；全部内容挂在此根修订之下，之后可与他人核对包按共同祖先接续'
  };
  const revision0 = makeRevision([], batchId, '旧数据升级：补祖先根');
  const revisionFixed = { ...revision0, id: rootRevisionId };
  const records: ArchiveRecord[] = (old.records ?? []).map((record) => {
    const provenance = (record.provenance ?? {}) as ArchiveRecord['provenance'];
    FIELD_KEYS.forEach((field) => {
      if (!provenance[field]) provenance[field] = fieldSource(batchId, rootRevisionId, '旧数据升级补来源');
    });
    return {
      ...record,
      status: (record.status as string) === 'rejected' ? 'unreviewed' : record.status,
      people: Array.isArray(record.people) ? record.people : [],
      places: Array.isArray(record.places) ? record.places : [],
      batchId: record.batchId ?? batchId,
      provenance
    };
  });
  const oldMatches = old.matches ?? [];
  const matches: MatchCandidate[] = oldMatches.map((match) => ({
    ...match,
    id: match.leftId && match.rightId ? matchPairId(match.leftId, match.rightId) : match.id,
    ruleVersion: match.ruleVersion ?? 'legacy-1',
    decidedBy: match.status === 'suggested' ? undefined : batchId,
    decidedIn: match.status === 'suggested' ? undefined : rootRevisionId
  }));
  const merges: MergeResult[] = (old.merges ?? []).map((merge) => ({
    ...merge,
    id: merge.leftId && merge.rightId ? `merge::${merge.leftId}::${merge.rightId}` : merge.id,
    matchId: merge.matchId ?? (merge.leftId && merge.rightId ? matchPairId(merge.leftId, merge.rightId) : merge.id),
    mergedRecordId: merge.mergedRecordId ?? uid('rec'),
    choiceSource: merge.choiceSource ?? Object.fromEntries(
      Object.keys(merge.chosen ?? {}).map((field) => [field, fieldSource(batchId, rootRevisionId, '旧合并结论升级')])
    ) as Partial<Record<FieldKey, FieldSource>>,
    batchId: batchId,
    revisionId: rootRevisionId
  }));
  const audit: AuditEntry[] = [{
    id: uid('audit'), at, action: '旧数据升级',
    detail: `升级 v1 工作区：${records.length} 条记录、${matches.length} 条候选、${merges.length} 条合并结论已补祖先与来源批次`,
    recordIds: [], batchId, revisionId: rootRevisionId
  }, ...(old.audit ?? []).slice(0, 200).map((entry) => ({ ...entry, batchId: entry.batchId ?? batchId, revisionId: entry.revisionId ?? rootRevisionId }))];

  const content: StateContent = { records, matches, merges };
  const state: PersistedWorkspace = {
    format: WORKSPACE_FORMAT,
    workspaceId: uid('workspace'),
    revisionCounter: 1,
    headId: rootRevisionId,
    ...content,
    batches: [batch],
    revisions: [revisionFixed],
    audit,
    activeMatchId: '',
    hydrated: true,
    snapshots: { [rootRevisionId]: contentOf(content) },
    importBases: []
  };
  return state;
}

export function migrateOrSeed(): { persisted: PersistedWorkspace; recovered: boolean; legacy: boolean } {
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (legacyRaw) {
    try {
      const persisted = migrateLegacyState(JSON.parse(legacyRaw));
      saveWorkspace(persisted);
      localStorage.removeItem(LEGACY_KEY);
      return { persisted, recovered: false, legacy: true };
    } catch {
      localStorage.removeItem(LEGACY_KEY);
    }
  }
  const loaded = loadWorkspace();
  if (loaded) return { persisted: loaded.state, recovered: loaded.recovered, legacy: false };
  const seeded = seedState();
  const persisted: PersistedWorkspace = {
    format: seeded.format,
    workspaceId: seeded.workspaceId,
    revisionCounter: seeded.revisionCounter,
    headId: seeded.headId,
    records: seeded.records, matches: seeded.matches, merges: seeded.merges,
    batches: seeded.batches, revisions: seeded.revisions, audit: seeded.audit,
    activeMatchId: '', hydrated: true,
    snapshots: seeded.snapshots as Record<string, StateContent>,
    importBases: []
  };
  saveWorkspace(persisted);
  return { persisted, recovered: false, legacy: false };
}

// ---- 本地修订提交（撤销重做只影响当前工作区内容，修订链本身保留） ----

export interface LocalCommit {
  content: StateContent;
  batches: Batch[];
  revisions: ReturnType<typeof makeRevision>[];
  audit: AuditEntry[];
  batch: Batch;
  revision: ReturnType<typeof makeRevision>;
}

export function makeLocalCommit(
  kind: Batch['kind'],
  label: string,
  message: string,
  parentId: string | null,
  content: StateContent,
  detail: string,
  recordIds: string[],
  note?: string
): LocalCommit {
  const batch = makeBatch(kind, label, 'local', note ? { note } : {});
  const revision = makeRevision(parentId ? [parentId] : [], batch.id, message);
  const audit: AuditEntry = {
    id: uid('audit'), at: nowIso(), action: label, detail,
    recordIds, batchId: batch.id, revisionId: revision.id
  };
  return { content, batches: [batch], revisions: [revision], audit: [audit], batch, revision };
}

// ---- 候选复核 / 批量复核 ----

export function decideMatch(
  state: WorkspaceState,
  matchId: string,
  status: Extract<MatchCandidate['status'], 'confirmed' | 'rejected'>,
  bulk = false
): LocalCommit | null {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match || match.status === status) return null;
  const content: StateContent = {
    records: state.records.map((record) => ({ ...record })),
    matches: state.matches.map((item) => ({ ...item, fieldScores: { ...item.fieldScores } })),
    merges: state.merges.map((item) => ({ ...item }))
  };
  const target = content.matches.find((item) => item.id === matchId)!;
  const previous = target.status;
  target.status = status;
  target.reviewedAt = nowIso();
  if (status === 'confirmed') {
    content.records.forEach((record) => {
      if (record.id === target.leftId || record.id === target.rightId) record.status = 'confirmed';
    });
  }
  const left = content.records.find((record) => record.id === target.leftId);
  const right = content.records.find((record) => record.id === target.rightId);
  const label = status === 'confirmed' ? (bulk ? '批量确认匹配' : '确认匹配') : (bulk ? '批量忽略匹配' : '忽略可疑匹配');
  const commit = makeLocalCommit(
    bulk ? 'bulk' : 'review',
    label,
    `${label}：${left?.title ?? target.leftId} ↔ ${right?.title ?? target.rightId}`,
    state.headId,
    content,
    `候选结论由「${previous === 'suggested' ? '待复核' : previous === 'confirmed' ? '确认' : previous === 'rejected' ? '忽略' : '已合并'}」改为「${status === 'confirmed' ? '确认' : '忽略'}」，来源批次随结论保存`,
    [target.leftId, target.rightId]
  );
  target.decidedBy = commit.batch.id;
  target.decidedIn = commit.revision.id;
  return commit;
}

export function bulkDecide(
  state: WorkspaceState,
  matchIds: string[],
  status: Extract<MatchCandidate['status'], 'confirmed' | 'rejected'>
): LocalCommit | null {
  const targets = state.matches.filter((match) => matchIds.includes(match.id) && match.status !== status);
  if (!targets.length) return null;
  const content: StateContent = {
    records: state.records.map((record) => ({ ...record })),
    matches: state.matches.map((item) => ({ ...item, fieldScores: { ...item.fieldScores } })),
    merges: state.merges.map((item) => ({ ...item }))
  };
  targets.forEach((target0) => {
    const target = content.matches.find((item) => item.id === target0.id)!;
    target.status = status;
    target.reviewedAt = nowIso();
    if (status === 'confirmed') {
      content.records.forEach((record) => {
        if (record.id === target.leftId || record.id === target.rightId) record.status = 'confirmed';
      });
    }
  });
  const commit = makeLocalCommit(
    'bulk',
    status === 'confirmed' ? '批量确认匹配' : '批量忽略匹配',
    `批量${status === 'confirmed' ? '确认' : '忽略'} ${targets.length} 条候选`,
    state.headId,
    content,
    `${targets.length} 条候选统一标记为「${status === 'confirmed' ? '确认' : '忽略'}」，每条结论记录来源批次`,
    targets.flatMap((match) => [match.leftId, match.rightId])
  );
  targets.forEach((target0) => {
    const target = content.matches.find((item) => item.id === target0.id)!;
    target.decidedBy = commit.batch.id;
    target.decidedIn = commit.revision.id;
  });
  return commit;
}

// ---- 执行合并：生成合并记录（保留原记录），写合并结论与字段来源 ----

export interface MergeChoices {
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
}

export function mergePair(
  state: WorkspaceState,
  matchId: string,
  choice: MergeChoices
): LocalCommit | null {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match) return null;
  const left = state.records.find((record) => record.id === match.leftId);
  const right = state.records.find((record) => record.id === match.rightId);
  if (!left || !right) return null;

  const values: Partial<Record<FieldKey, string>> = {};
  FIELD_KEYS.forEach((field) => {
    const source = choice.chosen[field] ?? 'A';
    values[field] = source === 'combine'
      ? [display(left, field), display(right, field)].filter(Boolean).join('；')
      : display(source === 'A' ? left : right, field);
  });

  const batch = makeBatch('merge-record', '逐字段合并记录', 'local');
  const revision = makeRevision(state.headId ? [state.headId] : [], batch.id, `合并：${left.title} ↔ ${right.title}`);

  const records = state.records.map((record) => ({ ...record, provenance: { ...record.provenance } }));
  const lRec = records.find((record) => record.id === left.id)!;
  const rRec = records.find((record) => record.id === right.id)!;
  // 重新合并时：旧合并记录与旧结论标记被取代
  const existingMerges = state.merges.filter((merge) => merge.matchId === matchId && !merge.supersededBy);
  const mergedId = uid('rec-merged');
  const merged: ArchiveRecord = {
    ...deepClone(lRec),
    id: mergedId,
    status: 'merged',
    updatedAt: nowIso(),
    stale: false,
    staleReason: undefined,
    batchId: batch.id
  };
  const choiceSource: MergeResult['choiceSource'] = {};
  FIELD_KEYS.forEach((field) => {
    const source = choice.chosen[field] ?? 'A';
    const picked = source === 'A' ? lRec : source === 'B' ? rRec : null;
    if (source === 'combine') {
      const combined = [display(lRec, field), display(rRec, field)].filter(Boolean).join('；');
      if (field === 'people' || field === 'places') {
        (merged[field] as string[]) = combined.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean);
      } else {
        (merged[field] as string) = combined;
      }
    } else if (picked) {
      (merged[field] as string | string[]) = deepClone(picked[field]);
    }
    const originBatch = picked?.provenance[field]?.batchId;
    merged.provenance[field] = fieldSource(batch.id, revision.id, source === 'combine'
      ? '双来源拼接'
      : `取自 ${source} 侧（原批次 ${originBatch ? originBatch.slice(0, 10) : '未知'}）`);
    choiceSource[field] = fieldSource(batch.id, revision.id, chosenAction(source));
  });
  lRec.status = 'merged';
  rRec.status = 'merged';

  let matches = state.matches.map((item) => ({ ...item, fieldScores: { ...item.fieldScores } }));

  const merges = state.merges.map((item) => ({ ...item, chosen: { ...item.chosen }, values: { ...item.values }, choiceSource: { ...item.choiceSource } }));
  existingMerges.forEach((old) => {
    const target0 = merges.find((item) => item.id === old.id);
    if (target0) target0.supersededBy = `merge::${left.id}::${right.id}`;
    const oldMergedRecord = records.find((record) => record.id === old.mergedRecordId);
    if (oldMergedRecord) {
      oldMergedRecord.stale = true;
      oldMergedRecord.staleReason = '该合并结论被重新合并取代';
    }
  });
  const mergeResult: MergeResult = {
    id: `merge::${left.id}::${right.id}`,
    matchId,
    leftId: left.id,
    rightId: right.id,
    mergedRecordId: mergedId,
    chosen: { ...choice.chosen },
    values,
    choiceSource,
    mergedAt: nowIso(),
    batchId: batch.id,
    revisionId: revision.id
  };
  merges.push(mergeResult);
  records.push(merged);

  // 原记录转为合并记录后，触及它们的其余候选按现行规则重算：
  // 未决候选移除；已确认/忽略的其他结论带旧依据回到待复核。
  const projected: StateContent = { records, matches, merges };
  const recomputed = recompute(projected, [left.id, right.id], batch.id, '执行记录合并');
  matches = recomputed.content.matches.filter((item) => item.id !== matchId);

  // 目标候选落「已合并」人工结论（按合并前记录评分重建，避免被自身重算移除）
  const lBefore = state.records.find((record) => record.id === left.id)!;
  const rBefore = state.records.find((record) => record.id === right.id)!;
  matches.push({
    ...scoreCandidate(lBefore, rBefore),
    status: 'merged',
    reviewedAt: nowIso(),
    decidedBy: batch.id,
    decidedIn: revision.id
  });
  matches.sort((a, b) => b.score - a.score);

  const otherResets = recomputed.resets.filter((item) => item.matchId !== matchId).length;
  const choiceValues = Object.values(choice.chosen);
  const audit: AuditEntry = {
    id: uid('audit'), at: nowIso(), action: '逐字段合并记录',
    detail: `生成合并记录 ${mergedId}：${choiceValues.filter((value) => value === 'A').length} 个字段取 A、${choiceValues.filter((value) => value === 'B').length} 个取 B、${choiceValues.filter((value) => value === 'combine').length} 个拼接；每个字段与原记录编号均保留来源批次；${otherResets} 条触及候选的旧结论带依据回到待复核`,
    recordIds: [left.id, right.id, mergedId], batchId: batch.id, revisionId: revision.id
  };
  return {
    content: { records: recomputed.content.records, matches, merges: recomputed.content.merges },
    batches: [batch],
    revisions: [revision],
    audit: [audit],
    batch,
    revision
  };
}

const display = (record: ArchiveRecord, field: FieldKey): string => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value ?? '');
};
const chosenAction = (source: RecordGroup | 'combine') =>
  source === 'combine' ? '裁决：双来源拼接' : `裁决：保留 ${source} 侧`;

// ---- 记录字段编辑：标题/日期/人物/地点变化后按现行规则重算 ----

export function editRecord(
  state: WorkspaceState,
  recordId: string,
  updates: Partial<Pick<ArchiveRecord, 'title' | 'date' | 'people' | 'places'>>
): LocalCommit | null {
  const original = state.records.find((record) => record.id === recordId);
  if (!original) return null;
  const next: ArchiveRecord = {
    ...deepClone(original),
    ...deepClone(updates),
    updatedAt: nowIso()
  };
  const records = state.records.map((record) => (record.id === recordId ? next : deepClone(record)));
  const batch = makeBatch('review', '修订记录字段', 'local');
  const revision = makeRevision(state.headId ? [state.headId] : [], batch.id, `修订记录：${original.title}`);
  next.provenance = { ...next.provenance };

  const changed: FieldKey[] = [];
  (['title', 'date', 'people', 'places'] as FieldKey[]).forEach((field) => {
    const a = Array.isArray(original[field]) ? [...(original[field] as string[])].sort().join('|') : original[field];
    const b = Array.isArray(next[field]) ? [...(next[field] as string[])].sort().join('|') : next[field];
    if (a !== b) {
      changed.push(field);
      next.provenance[field] = fieldSource(batch.id, revision.id, '人工字段修订');
    }
  });
  if (!changed.length) return null;

  const content0: StateContent = {
    records,
    matches: state.matches.map((match) => ({ ...match })),
    merges: state.merges.map((merge) => ({ ...merge }))
  };
  const recomputed = recompute(content0, [recordId], batch.id, '记录标题/日期/人物/地点修订');
  const fieldNames = changed.map((field) => ({ title: '标题', date: '日期', people: '人物', places: '地点' })[field as 'title']).join('、');
  const audit: AuditEntry = {
    id: uid('audit'), at: nowIso(), action: '修订记录字段',
    detail: `${original.title} 的${fieldNames}变化，相关候选按现行规则重算：${recomputed.resets.length} 条已确认/忽略/合并结论带旧依据回到待复核，新增候选 ${recomputed.added.length} 条`,
    recordIds: [recordId], batchId: batch.id, revisionId: revision.id
  };
  return { content: recomputed.content, batches: [batch], revisions: [revision], audit: [audit], batch, revision };
}

// ---- 原始文本导入（本地批次，按现行规则重算新候选） ----

export function importRawRows(
  state: WorkspaceState,
  rows: Array<Partial<ArchiveRecord>>,
  group: RecordGroup
): LocalCommit {
  const batch = makeBatch('import', `${group} 组原始数据导入`, 'local');
  const revision = makeRevision(state.headId ? [state.headId] : [], batch.id, `本地导入 ${rows.length} 条 ${group} 组记录`);
  const records = state.records.map((record) => ({ ...record }));
  rows.forEach((row) => {
    const id = uid('rec');
    records.push(completeRecord(row, id, group, batch.id, revision.id));
  });
  const freshCandidates = computeMatches(records);
  const known = new Set(state.matches.map((match) => match.id));
  const matches = [...state.matches.map((match) => ({ ...match })), ...freshCandidates.filter((match) => !known.has(match.id))];
  const content: StateContent = { records, matches, merges: state.merges.map((merge) => ({ ...merge })) };
  const affected = records.slice(state.records.length).map((record) => record.id);
  const recomputed = recompute(content, affected, batch.id, '本地原始导入');
  const audit: AuditEntry = {
    id: uid('audit'), at: nowIso(), action: '本地导入记录',
    detail: `${group} 组导入 ${rows.length} 条，来源批次 ${batch.id.slice(0, 10)}；按现行规则新增候选 ${recomputed.added.length} 条，不覆盖任何既有结论`,
    recordIds: affected, batchId: batch.id, revisionId: revision.id
  };
  return {
    content: recomputed.content,
    batches: [batch],
    revisions: [revision],
    audit: [audit],
    batch,
    revision
  };
}

// ---- 导出核对包：写明祖先、修订来源、校验和 ----

export async function buildPackage(persisted: PersistedWorkspace, importBases: string[]): Promise<ReconciliationPackage> {
  const headId = persisted.headId!;
  const headRevision = persisted.revisions.find((revision) => revision.id === headId)!;
  // base ancestor：最近吸收的来件头；没有则为根
  const baseAncestorId = importBases.length
    ? importBases[importBases.length - 1]
    : (persisted.revisions.find((revision) => revision.parents.length === 0)?.id ?? null);
  const baseState = baseAncestorId && persisted.snapshots[baseAncestorId]
    ? contentOf(persisted.snapshots[baseAncestorId])
    : null;

  const draft: Omit<ReconciliationPackage, 'checksum'> = {
    format: 2,
    packageType: 'sologsb-reconciliation',
    schemaVersion: 1,
    workspaceId: persisted.workspaceId,
    exportedAt: nowIso(),
    ruleVersion: 'rules-2026-10',
    head: { revisionId: headId, batchId: headRevision.batchId },
    baseAncestorId,
    records: persisted.records,
    matches: persisted.matches,
    merges: persisted.merges,
    audit: persisted.audit.slice(0, 500),
    batches: persisted.batches,
    revisions: persisted.revisions,
    baseState
  };
  const checkFields = ['records', 'matches', 'merges', 'audit', 'batches', 'revisions', 'baseState', 'head', 'baseAncestorId'];
  const checkPart: Record<string, unknown> = {};
  checkFields.forEach((key) => { checkPart[key] = (draft as unknown as Record<string, unknown>)[key]; });
  ['format', 'packageType', 'schemaVersion', 'workspaceId', 'exportedAt', 'ruleVersion'].forEach((key) => {
    checkPart[key] = (draft as unknown as Record<string, unknown>)[key];
  });
  const checksum = await checksumOf(checkPart);
  return { ...draft, checksum };
}

export function packageDownloadName(persisted: PersistedWorkspace): string {
  const short = persisted.headId?.slice(6, 12) ?? 'root';
  return `核对包-r${persisted.revisionCounter}-${short}-${new Date().toISOString().slice(0, 10)}.json`;
}

export { scorePair, SEED_BATCH_ID, SEED_REVISION_ID, canonicalStringify };
