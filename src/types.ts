// 版本链核对台核心类型：批次 DAG + 快照 + 三方接续合并
// 所有已封存批次（根、工作检查点、离线修订、汇入节点）各自持有一份不可变快照，
// 当前工作区始终挂在一个开放 work 批次上，撤销重做只改变该开放批次的内容。

export type RecordGroup = 'A' | 'B';

export type FieldKey =
  | 'title' | 'date' | 'people' | 'places' | 'identifier'
  | 'medium' | 'extent' | 'rights' | 'notes';

/** 候选 / 已裁决结论状态。suggested 既是初始建议，也是被退回后的待复核状态。 */
export type DecisionStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';

export type BatchKind =
  | 'root'              // 工作区始祖批次
  | 'work'              // 当前开放工作批次（可编辑、可撤销）
  | 'work-checkpoint'   // 工作区封存检查点（导出 / 接续前生成）
  | 'offline-edit'      // 档案员离线核对批次
  | 'import-merge'      // 回馆汇入节点（两个父批次：本馆检查点 + 离线末梢）
  | 'legacy-import';    // 无共同祖先的旧版数据根

export type BatchOrigin = 'seed' | 'local' | 'offline' | 'migration';

export type OriginVia = 'seed' | 'edit' | 'import' | 'merge' | 'adjudication';

/** 单个字段值的来源凭据：来自哪个批次、以何种方式进入。 */
export interface FieldOrigin {
  batchId: string;
  batchLabel: string;
  via: OriginVia;
  at?: string;
}

export interface RecordSnap {
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
  /** 合并后被新记录接替时指向新记录 id，原记录保留不删除。 */
  supersededBy?: string;
  /** 每个字段当前取值的来源批次（对账凭据）。 */
  origins: Partial<Record<FieldKey, FieldOrigin>>;
  updatedAt: string;
  /** 记录最初进入工作区时的批次。 */
  sourceBatchId: string;
}

/** 裁决依据中参与“现行规则重算”的字段快照（标题、日期、人物、地点）。 */
export interface SignatureSlim {
  title: string;
  date: string;
  people: string;
  places: string;
}

export interface DecisionBasis {
  score: number;
  fieldScores: Partial<Record<FieldKey, number>>;
  reasons: string[];
  left: SignatureSlim;
  right: SignatureSlim;
}

/** 结论因记录关键字段变化而退回待复核时，保留旧结论与旧依据。 */
export interface ReopenInfo {
  oldStatus: DecisionStatus;
  reason: string;
  at: string;
  oldBasis: DecisionBasis;
}

export interface DecisionSnap {
  key: string;
  leftId: string;
  rightId: string;
  status: DecisionStatus;
  basis: DecisionBasis;
  decidedByBatchId?: string;
  decidedAt?: string;
  reopened?: ReopenInfo;
}

export interface MergeSnap {
  id: string;
  key: string;
  leftId: string;
  rightId: string;
  mergedId: string;
  choices: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  origins: Partial<Record<FieldKey, FieldOrigin>>;
  basis: DecisionBasis;
  batchId: string;
  createdAt: string;
}

/** 批次快照：某一批次封存时刻的完整结论面。 */
export interface Snapshot {
  records: Record<string, RecordSnap>;
  decisions: Record<string, DecisionSnap>;
  merges: Record<string, MergeSnap>;
}

export interface BatchNode {
  id: string;
  kind: BatchKind;
  origin: BatchOrigin;
  /** 共同祖先链由此表达：汇入节点有两个父，其余节点一个父，根节点为空。 */
  parents: string[];
  label: string;
  author?: string;
  createdAt: string;
}

export interface ConflictSide {
  batchId: string;
  batchLabel: string;
  author?: string;
  at?: string;
}

export type ConflictKind = 'record-field' | 'match-decision' | 'merge-field';

/**
 * 未裁决分歧。同一字段 / 候选在共同祖先之后被两边改成不同结果时产生，
 * 列出两边结论文本与来源修订批次；裁决前禁止合并与导出。
 */
export interface ConflictEntry {
  id: string;
  kind: ConflictKind;
  entityId: string;
  field: FieldKey | 'decision' | 'identity';
  fieldLabel: string;
  entityLabel: string;
  baseText: string;
  oursText: string;
  theirsText: string;
  ours: ConflictSide;
  theirs: ConflictSide;
  base?: ConflictSide;
  resolved: boolean;
  chosen?: 'ours' | 'theirs';
  resolvedAt?: string;
}

export interface RevisionEntry {
  id: string;
  at: string;
  /** 写入此修订时所在的工作批次。 */
  batchId: string;
  /** 该改动实际源自哪个批次（自动接续的离线改动记离线批次）。 */
  sourceBatchId?: string;
  sourceBatchLabel?: string;
  action: string;
  detail: string;
  targetType: 'record' | 'match' | 'merge' | 'batch' | 'conflict';
  targetId: string;
  field?: FieldKey | 'decision';
  beforeText?: string;
  afterText?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  batchId: string;
  sourceBatchId?: string;
  sourceBatchLabel?: string;
  action: string;
  detail: string;
  recordIds: string[];
}

export interface WorkspaceState {
  formatVersion: 2;
  workspaceId: string;
  batches: BatchNode[];
  /** 已封存批次快照（开放 work 批次不在其中）。 */
  snapshots: Record<string, Snapshot>;
  openBatchId: string;
  workSnapshot: Snapshot;
  conflicts: ConflictEntry[];
  revisions: RevisionEntry[];
  audit: AuditEntry[];
  hydrated: boolean;
}

/** v1 旧工作区结构（仅用于迁移类型判断）。 */
export interface LegacyStateShape {
  revision?: number;
  records?: unknown;
  matches?: unknown;
  merges?: unknown;
  audit?: unknown;
}
