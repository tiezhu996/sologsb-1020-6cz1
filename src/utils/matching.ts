import type { DecisionBasis, FieldKey, RecordGroup, SignatureSlim } from '../types';

/** 与存储模型解耦的最小记录形状，使评分规则可在 Node 下直接测试。 */
export interface RecordLike {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
}

export const FIELD_KEYS: FieldKey[] = [
  'title', 'date', 'people', 'places', 'identifier',
  'medium', 'extent', 'rights', 'notes'
];

/** 触发“现行规则重算”的四个关键字段。 */
export const SIGNATURE_FIELDS = ['title', 'date', 'people', 'places'] as const;
export type SignatureField = (typeof SIGNATURE_FIELDS)[number];

export const SCORE_THRESHOLD = 0.38;
export const LOW_SCORE = 0.68;

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};

export function fieldText(record: Pick<RecordLike, FieldKey>, field: FieldKey): string {
  const value = record[field];
  return Array.isArray(value) ? value.filter(Boolean).join('、') : String(value ?? '');
}

/** 三方比对所用的规范化值：数组字段排序去重，文本字段 trim。 */
export function canonicalText(record: Pick<RecordLike, FieldKey>, field: FieldKey): string {
  if (field === 'people' || field === 'places') {
    return [...new Set(record[field].map((item) => item.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|');
  }
  return (record[field] as string).trim();
}

export function signatureSlim(record: Pick<RecordLike, FieldKey>): SignatureSlim {
  return {
    title: canonicalText(record, 'title'),
    date: canonicalText(record, 'date'),
    people: canonicalText(record, 'people'),
    places: canonicalText(record, 'places')
  };
}

export function scorePair(left: RecordLike, right: RecordLike): Omit<DecisionBasis, 'left' | 'right'> {
  const fieldScores: Partial<Record<FieldKey, number>> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title! * .3 + fieldScores.date! * .2 + fieldScores.people! * .2
    + fieldScores.places! * .14 + fieldScores.identifier! * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier! > .8) reasons.push('编号高度一致');
  if (fieldScores.title! > .58) reasons.push('标题相似');
  if (fieldScores.date! > .9) reasons.push('日期一致');
  if (fieldScores.people! > .8) reasons.push('人物一致');
  if (fieldScores.places! > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function decisionBasis(left: RecordLike, right: RecordLike): DecisionBasis {
  return { ...scorePair(left, right), left: signatureSlim(left), right: signatureSlim(right) };
}

export const matchKey = (leftId: string, rightId: string) => `match:${leftId}:${rightId}`;

/** 现行规则：按组配对、限制每侧候选数。键名以 A 在前 B 在后，保证跨批次稳定。 */
export function buildCandidates(
  records: Array<RecordLike & { supersededBy?: string }>
): Map<string, DecisionBasis> {
  const alive = records.filter((record) => !record.supersededBy);
  const left = alive.filter((record) => record.group === 'A');
  const right = alive.filter((record) => record.group === 'B');
  const result = new Map<string, DecisionBasis>();
  left.forEach((a) => {
    const candidates = right
      .map((b) => ({ record: b, basis: decisionBasis(a, b) }))
      .filter((item) => item.basis.score >= SCORE_THRESHOLD)
      .sort((x, y) => y.basis.score - x.basis.score)
      .slice(0, 4);
    candidates.forEach(({ record, basis }) => result.set(matchKey(a.id, record.id), basis));
  });
  return result;
}

/** 判断已裁决结论的旧依据是否与当前关键字段相符（决定是否退回待复核）。 */
export function basisStillValid(
  basis: DecisionBasis,
  left: Pick<RecordLike, FieldKey>,
  right: Pick<RecordLike, FieldKey>
): boolean {
  const nowLeft = signatureSlim(left);
  const nowRight = signatureSlim(right);
  return basis.left.title === nowLeft.title && basis.left.date === nowLeft.date
    && basis.left.people === nowLeft.people && basis.left.places === nowLeft.places
    && basis.right.title === nowRight.title && basis.right.date === nowRight.date
    && basis.right.people === nowRight.people && basis.right.places === nowRight.places;
}
