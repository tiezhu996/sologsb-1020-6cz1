// 档案元数据核对台 · v2 可对账版本链数据模型

export type RecordGroup = 'A' | 'B';
export type RecordStatus = 'unreviewed' | 'confirmed' | 'merged';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey =
  | 'title' | 'date' | 'people' | 'places' | 'identifier'
  | 'medium' | 'extent' | 'rights' | 'notes';

/** 修改后会触发候选按现行规则重算的字段：标题、日期、人物、地点 */
export const RULE_FIELDS: ReadonlyArray<FieldKey> = ['title', 'date', 'people', 'places'];
export const ARRAY_FIELDS: ReadonlyArray<FieldKey> = ['people', 'places'];
export const FIELD_KEYS: ReadonlyArray<FieldKey> = [
  'title', 'date', 'people', 'places', 'identifier',
  'medium', 'extent', 'rights', 'notes'
];

/** 字段级来源：值来自哪个导入/操作批次与修订 */
export interface FieldSource {
  batchId: string;
  revisionId: string;
  at: string;
  note?: string;
}
export type FieldProvenance = Partial<Record<FieldKey, FieldSource>>;

export interface ArchiveRecord {
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
  updatedAt: string;
  status: RecordStatus;
  /** 记录首次进入本工作区的来源批次 */
  batchId: string;
  /** 每个字段最近一次取值的来源批次 */
  provenance: FieldProvenance;
  /** 合并结论因规则字段变化回到待复核时，合并记录带旧依据标记 */
  stale?: boolean;
  staleReason?: string;
}

/** 候选结论回到待复核时保留的旧依据 */
export interface OldBasis {
  status: MatchStatus;
  score: number;
  reasons: string[];
  reviewedAt?: string;
  decidedBy?: string;
  ruleVersion: string;
  resetAt: string;
  resetReason: string;
  resetBatchId: string;
}

export interface MatchCandidate {
  /** 确定性编号：match::leftId::rightId，两侧离线生成也一致 */
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
  /** 人工结论（确认/忽略/合并）来源批次与修订 */
  decidedBy?: string;
  decidedIn?: string;
  ruleVersion: string;
  oldBasis?: OldBasis;
}

export interface MergeResult {
  /** 确定性编号：merge::leftId::rightId */
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  mergedRecordId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  /** 每个字段裁决动作的来源批次 */
  choiceSource: Partial<Record<FieldKey, FieldSource>>;
  mergedAt: string;
  batchId: string;
  revisionId: string;
  /** 旧合并结论因重算回到待复核 */
  basisStale?: boolean;
  staleReason?: string;
  /** 被重新合并后的新结论取代 */
  supersededBy?: string;
}

export type BatchKind =
  | 'seed'        // 初始建账
  | 'migration'   // 旧数据升级补祖先
  | 'import'      // 本地原始文本导入
  | 'package'     // 外部核对包（快进或三方接续）
  | 'review'      // 确认/忽略候选
  | 'bulk'        // 批量复核
  | 'merge-record'// 执行记录合并
  | 'system';

export interface Batch {
  id: string;
  kind: BatchKind;
  label: string;
  at: string;
  source: 'local' | 'incoming';
  sourcePackage?: string;
  operator?: string;
  note?: string;
}

/** 版本链节点：0 个父=根，1 个父=普通修订，2 个父=三方接续合并节点 */
export interface Revision {
  id: string;
  parents: string[];
  batchId: string;
  at: string;
  message: string;
  /** 接续导入时的来件头修订 */
  incomingHead?: string;
  /** 共同祖先修订 */
  mergeBase?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  batchId: string;
  revisionId: string;
}

// ---- 接续导入（三方合并） ----

export type ConflictSubject = 'record-field' | 'record-status' | 'match-decision' | 'merge-field';

export interface SideConclusion {
  /** 该侧在共同祖先之后是否改过 */
  changed: boolean;
  present: boolean;
  batchId?: string;
  revisionId?: string;
  at?: string;
  label?: string;
  /** record-field 现值（数组字段以数组保存） */
  raw?: string | string[];
  /** 展示文本 */
  text?: string;
  /** match-decision 结论 */
  status?: MatchStatus;
  /** merge-field 裁决 */
  chosen?: RecordGroup | 'combine';
  chosenText?: string;
}

export interface ConflictResolution {
  pick: 'local' | 'incoming' | 'custom';
  /** custom 时的自定义文本 */
  custom?: string;
  batchId: string;
  revisionId: string;
  at: string;
}

export interface Conflict {
  id: string;
  subject: ConflictSubject;
  recordId?: string;
  field?: FieldKey;
  matchId?: string;
  mergeId?: string;
  /** 共同祖先处的展示值（null 表示祖先处无此对象） */
  baseText: string | null;
  local: SideConclusion;
  incoming: SideConclusion;
  resolution?: ConflictResolution;
}

export type AutoChangeKind =
  | 'record-added'
  | 'record-changed'
  | 'record-status'
  | 'match-added'
  | 'match-decision'
  | 'match-reset'
  | 'score-refresh'
  | 'merge-added';

export interface AutoChange {
  kind: AutoChangeKind;
  entityId: string;
  side: 'local' | 'incoming' | 'both';
  summary: string;
  fields?: FieldKey[];
}

export interface StagedImport {
  mode: 'package' | 'legacy-package' | 'raw';
  fileName: string;
  localHead: string;
  incomingHead: string;
  baseRevisionId: string | null;
  baseAncestryLabel: string;
  isFastForward: boolean;
  conflicts: Conflict[];
  autoChanges: AutoChange[];
  /** 暂存投影，裁决完成后才提交 */
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  incomingBatches: Batch[];
  incomingRevisions: Revision[];
  incomingAudit: AuditEntry[];
  /** 来件头对应的内容快照（导出他账时作为共同祖先内容） */
  incomingSnapshot: StateContent;
  /** 受规则字段变化影响、提交时需按现行规则重算的记录 */
  affectedIds: string[];
  stageBatchId: string;
  commitRevisionId: string;
  rawRows?: Array<Partial<ArchiveRecord>>;
  rawGroup?: RecordGroup;
  legacyNote?: string;
}

// ---- 持久化与对外包 ----

export interface StateContent {
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
}

export interface WorkspaceState extends StateContent {
  format: 2;
  workspaceId: string;
  revisionCounter: number;
  headId: string | null;
  batches: Batch[];
  revisions: Revision[];
  audit: AuditEntry[];
  activeMatchId: string;
  hydrated: boolean;
}

/** 本地持久化包：工作区 + 祖先内容快照 + 已吸收的来件头 */
export interface PersistedWorkspace extends WorkspaceState {
  snapshots: Record<string, StateContent>;
  importBases: string[];
}

export interface ReconciliationPackage {
  format: 2;
  packageType: 'sologsb-reconciliation';
  schemaVersion: 1;
  workspaceId: string;
  exportedAt: string;
  ruleVersion: string;
  head: { revisionId: string; batchId: string };
  /** 导出方声明的最近共同祖先（最近吸收的来件头或根） */
  baseAncestorId: string | null;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  batches: Batch[];
  revisions: Revision[];
  /** 共同祖先处的完整内容快照，供无此修订的接收方做三方比对 */
  baseState: StateContent | null;
  checksum: string;
}
