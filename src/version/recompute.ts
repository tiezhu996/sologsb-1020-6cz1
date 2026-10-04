import type {
  ArchiveRecord, FieldKey, MatchCandidate, MergeResult, StateContent
} from '../types';
import { RULE_FIELDS } from '../types';
import { fieldSignature, nowIso } from './core';
import { MATCH_THRESHOLD, scoreCandidate } from '../utils/matching';

export interface RecomputeResult {
  content: StateContent;
  resets: Array<{ matchId: string; oldStatus: string; reason: string }>;
  added: string[];
}

export function affectedRecordIds(base: StateContent, next: StateContent): string[] {
  const ids = new Set<string>();
  const baseById = new Map(base.records.map((record) => [record.id, record]));
  next.records.forEach((record) => {
    const old = baseById.get(record.id);
    if (!old) { ids.add(record.id); return; }
    if (RULE_FIELDS.some((field) => fieldSignature(old, field) !== fieldSignature(record, field))) ids.add(record.id);
  });
  return [...ids];
}

/**
 * 按现行匹配规则重算。
 * - 触及受影响记录的 A/B 对全部重新评分；
 * - 未决候选：更新分值，跌破阈值则移除，新对达标则新增；
 * - 已确认 / 已忽略 / 已合并结论：分值或存在性发生实质变化时，带旧依据回到待复核；
 * - 被重置的合并结论，其合并记录带旧依据标为陈旧，原记录回到未核对。
 */
export function recompute(
  prev: StateContent,
  affectedIds: string[],
  batchId: string,
  resetReason: string
): RecomputeResult {
  const resets: RecomputeResult['resets'] = [];
  const added: string[] = [];
  if (!affectedIds.length) return { content: clone(prev), resets, added };

  const affected = new Set(affectedIds);
  const records = prev.records.map((record) => ({ ...record, provenance: { ...record.provenance } }));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const matches = prev.matches.map((match) => ({ ...match, fieldScores: { ...match.fieldScores } }));
  const merges = prev.merges.map((merge) => ({ ...merge, chosen: { ...merge.chosen }, values: { ...merge.values }, choiceSource: { ...merge.choiceSource } }));

  const touches = (match: MatchCandidate) => affected.has(match.leftId) || affected.has(match.rightId);

  const decided = (status: MatchCandidate['status']) => status !== 'suggested';
  /** 把旧结论带旧依据写入新评分候选（或旧对象），返回应保留的候选。 */
  const resetToSuggested = (match: MatchCandidate, reason: string, fresh?: MatchCandidate): MatchCandidate => {
    const basis = {
      status: match.status,
      score: match.score,
      reasons: [...match.reasons],
      reviewedAt: match.reviewedAt,
      decidedBy: match.decidedBy,
      ruleVersion: match.ruleVersion,
      resetAt: nowIso(),
      resetReason: reason,
      resetBatchId: batchId
    };
    const target = fresh ?? match;
    target.status = 'suggested';
    target.oldBasis = basis;
    delete target.reviewedAt;
    delete target.decidedBy;
    delete target.decidedIn;
    if (!fresh) {
      target.score = 0;
      target.reasons = [];
    }
    resets.push({ matchId: match.id, oldStatus: basis.status, reason });
    return target;
  };

  const staleMergedRecord = (merge: MergeResult) => {
    merge.basisStale = true;
    merge.staleReason = resetReason;
    const merged = recordById.get(merge.mergedRecordId);
    if (merged) {
      merged.stale = true;
      merged.staleReason = resetReason;
    }
    const left = recordById.get(merge.leftId);
    const right = recordById.get(merge.rightId);
    if (left && left.status === 'merged') left.status = 'unreviewed';
    if (right && right.status === 'merged') right.status = 'unreviewed';
  };

  // 枚举触及记录与对侧（非合并）记录的所有 A/B 对
  const live = records.filter((record) => record.status !== 'merged' || !affected.has(record.id));
  const pairMap = new Map<string, MatchCandidate>();
  affectedIds.forEach((id) => {
    const current = recordById.get(id);
    if (!current || current.status === 'merged') return;
    live
      .filter((other) => other.id !== id && other.group !== current.group && other.status !== 'merged')
      .forEach((other) => {
        const fresh = scoreCandidate(current, other);
        pairMap.set(fresh.id, fresh);
      });
  });

  const keep: MatchCandidate[] = [];
  const handled = new Set<string>();

  matches.forEach((match) => {
    if (!touches(match)) { keep.push(match); return; }
    handled.add(match.id);
    const left = recordById.get(match.leftId);
    const right = recordById.get(match.rightId);
    const fresh = left && right && left.status !== 'merged' && right.status !== 'merged'
      ? scoreCandidate(left, right)
      : undefined;

    if (!decided(match.status)) {
      // 未决候选：刷新；消失（一方成为合并记录）或跌破阈值则移除
      if (fresh && fresh.score >= MATCH_THRESHOLD) keep.push(fresh);
      return;
    }

    if (!fresh || fresh.score < MATCH_THRESHOLD) {
      // 候选不再成立，决定失效，带旧依据回到待复核（不参与常规列表评分展示）
      const wasMerged = match.status === 'merged';
      resetToSuggested(match, `候选不再满足匹配阈值（${resetReason}）`, undefined);
      match.score = fresh?.score ?? 0;
      match.reasons = fresh?.reasons ?? [];
      match.fieldScores = fresh?.fieldScores ?? match.fieldScores;
      if (wasMerged) {
        const merge = merges.find((item) => item.matchId === match.id && !item.supersededBy);
        if (merge) staleMergedRecord(merge);
      }
      keep.push(match);
      return;
    }

    const materialChange =
      Math.abs(fresh.score - match.score) >= 0.05 ||
      RULE_FIELDS.some((field) => {
        const delta = Math.abs((fresh.fieldScores[field] ?? 0) - (match.fieldScores[field] ?? 0));
        return delta >= 0.1;
      });

    if (materialChange) {
      const reset = resetToSuggested(match, `标题/日期/人物/地点变化使相似度变化（${resetReason}）`, fresh);
      if (reset.oldBasis?.status === 'merged') {
        const merge = merges.find((item) => item.matchId === match.id && !item.supersededBy);
        if (merge) staleMergedRecord(merge);
      }
      keep.push(reset);
    } else {
      // 分值实质未变：保留人工结论，仅静默刷新机器分
      match.score = fresh.score;
      match.fieldScores = fresh.fieldScores;
      match.reasons = fresh.reasons;
      match.ruleVersion = fresh.ruleVersion;
      keep.push(match);
    }
  });

  // 新增达标对
  pairMap.forEach((fresh) => {
    if (handled.has(fresh.id)) return;
    if (fresh.score >= MATCH_THRESHOLD) {
      keep.push(fresh);
      added.push(fresh.id);
    }
  });

  return {
    content: { records, matches: keep.sort((a, b) => b.score - a.score), merges },
    resets,
    added
  };
}

const clone = (content: StateContent): StateContent => ({
  records: content.records.map((record) => ({ ...record })),
  matches: content.matches.map((match) => ({ ...match })),
  merges: content.merges.map((merge) => ({ ...merge }))
});

export const changedRuleFields = (base: ArchiveRecord | undefined, next: ArchiveRecord | undefined): FieldKey[] => {
  if (!base || !next) return [];
  return RULE_FIELDS.filter((field) => fieldSignature(base, field) !== fieldSignature(next, field));
};
