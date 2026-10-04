import type {
  ArchiveRecord, Batch, BatchKind, FieldKey, FieldSource,
  Revision, StateContent, WorkspaceState
} from '../types';
import { FIELD_KEYS, ARRAY_FIELDS } from '../types';

export const RULE_VERSION = 'rules-2026-10';
export const WORKSPACE_FORMAT = 2;

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const nowIso = () => new Date().toISOString();

export function makeBatch(kind: BatchKind, label: string, source: Batch['source'], extra: Partial<Batch> = {}): Batch {
  return { id: uid('batch'), kind, label, at: nowIso(), source, ...extra };
}

export function makeRevision(parents: string[], batchId: string, message: string, extra: Partial<Revision> = {}): Revision {
  return { id: uid('rev'), parents, batchId, at: nowIso(), message, ...extra };
}

export function fieldSource(batchId: string, revisionId: string, note?: string): FieldSource {
  return { batchId, revisionId, at: nowIso(), ...(note ? { note } : {}) };
}

export function contentOf(state: StateContent): StateContent {
  return {
    records: state.records.map((record) => ({ ...record })),
    matches: state.matches.map((match) => ({ ...match })),
    merges: state.merges.map((merge) => ({ ...merge }))
  };
}

/**
 * 纯数据深拷贝。版本链对象只含可 JSON 序列化数据；
 * 不用 structuredClone，因为 Qwik 的响应式代理对象无法被结构化克隆。
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---- 字段签名：数组字段按排序后的项比较，标量按 trim 后字符串比较 ----

export function fieldSignature(record: ArchiveRecord, field: FieldKey): string {
  const value = record[field];
  if (ARRAY_FIELDS.includes(field)) return [...(value as string[])].map((item) => item.trim()).filter(Boolean).sort().join('␟');
  return String(value ?? '').trim();
}

export function fieldText(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.filter(Boolean).join('、') : value;
}

export function parseListField(value: string): string[] {
  return value.split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean);
}

/** 规则字段（标题/日期/人物/地点）是否有差异 */
export function ruleFieldsChanged(base: ArchiveRecord | undefined, next: ArchiveRecord | undefined, ruleFields: ReadonlyArray<FieldKey>): FieldKey[] {
  if (!base || !next) return [];
  return FIELD_KEYS.filter((field) => ruleFields.includes(field) && fieldSignature(base, field) !== fieldSignature(next, field));
}

// ---- 版本图：祖先判定与最低共同祖先 ----

export function ancestorMap(revisions: Revision[]): Map<string, Set<string>> {
  const parents = new Map<string, string[]>();
  revisions.forEach((revision) => parents.set(revision.id, revision.parents));
  const cache = new Map<string, Set<string>>();
  const collect = (id: string): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    (parents.get(id) ?? []).forEach((parent) => {
      set.add(parent);
      collect(parent).forEach((ancestor) => set.add(ancestor));
    });
    cache.set(id, set);
    return set;
  };
  revisions.forEach((revision) => collect(revision.id));
  return cache;
}

export function isAncestor(revisions: Revision[], maybeAncestor: string, descendant: string | null): boolean {
  if (!descendant) return false;
  if (maybeAncestor === descendant) return true;
  return ancestorMap(revisions).get(descendant)?.has(maybeAncestor) ?? false;
}

/** 最低共同祖先（merge base）。两个头在同一版本链上时返回较旧的那个。 */
export function findMergeBase(revisions: Revision[], aId: string | null, bId: string | null): string | null {
  if (!aId || !bId) return null;
  if (aId === bId) return aId;
  const ancA = ancestorMap(revisions);
  const setA = new Set<string>([aId, ...(ancA.get(aId) ?? [])]);
  const setB = ancA.get(bId);
  if (setA.has(bId)) return bId;
  if (setB?.has(aId)) return aId;
  if (setB) for (const id of setB) if (setA.has(id)) return id;
  return null;
}

// ---- 校验和（规范化 JSON + SHA-256） ----

export function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    // 忽略 undefined 字段，与 JSON.stringify 的持久化语义保持一致，
    // 否则带 undefined 的对象签发后经 JSON 往返会校验和不一致。
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function checksumOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---- 修订展示 ----

export function revisionLabel(state: Pick<WorkspaceState, 'revisions' | 'batches'>, revisionId: string): string {
  const revision = state.revisions.find((item) => item.id === revisionId);
  if (!revision) return revisionId.slice(0, 8);
  const batch = state.batches.find((item) => item.id === revision.batchId);
  const short = revision.id.slice(6, 12);
  return batch ? `${batch.label} · ${short}` : short;
}

export function batchLabel(state: Pick<WorkspaceState, 'batches'>, batchId?: string): string {
  if (!batchId) return '无来源';
  return state.batches.find((item) => item.id === batchId)?.label ?? batchId.slice(0, 10);
}

export function isIncomingBatch(batch: Batch | undefined): boolean {
  return batch?.source === 'incoming';
}
