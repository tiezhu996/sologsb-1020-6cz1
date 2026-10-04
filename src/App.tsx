import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Modal, Tabs } from '@qwik-ui/headless';
import type {
  ConflictEntry, DecisionStatus, FieldKey, RecordGroup, RecordSnap, WorkspaceState
} from './types';
import {
  FIELD_KEYS, LOW_SCORE, fieldText
} from './utils/matching';
import {
  FIELD_LABELS, batchDepth, buildExportBundle, editRecordFields, getBatch,
  hasOpenConflicts, importNewRecords, importOfflinePackage, createOfflinePackage,
  integrityProblems, isLegacyState, makeRecordSnap, migrateLegacy, performMerge,
  resolveConflict, setDecisionStatus, statusText
} from './utils/version';
import { parseImportRows, parseDateLabel, groupText } from './utils/parse';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-workspace-v2';

const BATCH_KIND_LABEL: Record<string, string> = {
  root: '始祖批次',
  work: '开放工作批次',
  'work-checkpoint': '离馆/回馆检查点',
  'offline-edit': '离线核对批次',
  'import-merge': '回馆汇入节点',
  'legacy-import': '旧数据迁移根'
};

const downloadJson = (name: string, data: unknown) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

interface UndoPiece { w: WorkspaceState['workSnapshot']; c: ConflictEntry[]; r: WorkspaceState['revisions']; a: WorkspaceState['audit']; }

export default component$(() => {
  const state = useStore<WorkspaceState>(seedState());
  const history = useSignal<UndoPiece[]>([]);
  const future = useSignal<UndoPiece[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | DecisionStatus>('all');
  const showSuperseded = useSignal(false);
  const visibleCount = useSignal(80);
  const selectedKeys = useSignal<string[]>([]);
  const activeKey = useSignal('');
  const panelTab = useSignal(0);

  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const editOpen = useSignal(false);
  const checkinOpen = useSignal(false);
  const returnOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importFileName = useSignal('');
  const checkinAuthor = useSignal('');
  const returnAuthor = useSignal('');
  const returnFileName = useSignal('');
  const returnRaw = useSignal('');
  const returnError = useSignal('');
  const returnReport = useSignal('');
  const editingId = useSignal('');
  const toast = useSignal('');
  const integrityBanner = useSignal<string[]>([]);

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A',
    medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });
  const editForm = useStore<Record<FieldKey, string>>({
    title: '', date: '', people: '', places: '', identifier: '',
    medium: '', extent: '', rights: '', notes: ''
  });

  // ── 撤销重做：只作用于当前开放工作批次的内容，封存批次永不回滚 ──
  const capture = $(() => {
    history.value = [...history.value.slice(-49), {
      w: JSON.parse(JSON.stringify(state.workSnapshot)),
      c: JSON.parse(JSON.stringify(state.conflicts)),
      r: JSON.parse(JSON.stringify(state.revisions)),
      a: JSON.parse(JSON.stringify(state.audit))
    }];
    future.value = [];
  });

  const restorePiece = (piece: UndoPiece) => {
    state.workSnapshot = piece.w;
    state.conflicts = piece.c;
    state.revisions = piece.r;
    state.audit = piece.a;
  };

  const undo = $(() => {
    const piece = history.value.at(-1);
    if (!piece) return;
    future.value = [...future.value, {
      w: JSON.parse(JSON.stringify(state.workSnapshot)),
      c: JSON.parse(JSON.stringify(state.conflicts)),
      r: JSON.parse(JSON.stringify(state.revisions)),
      a: JSON.parse(JSON.stringify(state.audit))
    }];
    history.value = history.value.slice(0, -1);
    restorePiece(piece);
  });

  const redo = $(() => {
    const piece = future.value.at(-1);
    if (!piece) return;
    history.value = [...history.value, {
      w: JSON.parse(JSON.stringify(state.workSnapshot)),
      c: JSON.parse(JSON.stringify(state.conflicts)),
      r: JSON.parse(JSON.stringify(state.revisions)),
      a: JSON.parse(JSON.stringify(state.audit))
    }];
    future.value = future.value.slice(0, -1);
    restorePiece(piece);
  });

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  // ── 派生视图 ──
  const allRecords = useComputed$(() => Object.values(state.workSnapshot.records));
  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return allRecords.value
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => showSuperseded.value || !record.supersededBy)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const allDecisions = useComputed$(() => Object.values(state.workSnapshot.decisions));
  const filteredDecisions = useComputed$(() => allDecisions.value
    .filter((decision) => statusFilter.value === 'all' || decision.status === statusFilter.value)
    .sort((a, b) => Number(b.status === 'suggested') - Number(a.status === 'suggested') || b.basis.score - a.basis.score));
  const visibleDecisions = useComputed$(() => filteredDecisions.value.slice(0, 150));
  const activeDecision = useComputed$(() =>
    allDecisions.value.find((decision) => decision.key === activeKey.value) ?? filteredDecisions.value[0]);

  const conflictList = useComputed$(() => state.conflicts);
  const openConflictCount = useComputed$(() => state.conflicts.filter((conflict) => !conflict.resolved).length);
  const conflictBlocked = useComputed$(() => hasOpenConflicts(state));
  const reopenedCount = useComputed$(() => allDecisions.value.filter((decision) => decision.reopened).length);
  const chain = useComputed$(() => {
    const cache = new Map<string, number>();
    return [...state.batches]
      .map((batch) => ({ batch, depth: batchDepth(state, batch.id, cache) }))
      .sort((a, b) => a.depth - b.depth || a.batch.createdAt.localeCompare(b.batch.createdAt));
  });

  const recordById = (id: string) => state.workSnapshot.records[id];
  const batchLabelOf = (id?: string) => (id ? getBatch(state, id)?.label ?? id : '—');

  // ── 候选操作 ──
  const setStatus = $(async (key: string, status: Exclude<DecisionStatus, 'merged'>) => {
    await capture();
    setDecisionStatus(state, key, status);
    notify(status === 'confirmed' ? '已确认候选' : status === 'rejected' ? '已忽略候选' : '已退回待复核');
  });

  const bulkStatus = $(async (status: Exclude<DecisionStatus, 'merged'>) => {
    const keys = selectedKeys.value;
    if (!keys.length) return;
    await capture();
    keys.forEach((key) => setDecisionStatus(state, key, status));
    selectedKeys.value = [];
    notify(`已批量${status === 'confirmed' ? '确认' : '忽略'} ${keys.length} 条候选`);
  });

  const openMerge = $(() => {
    const decision = activeDecision.value;
    if (!decision || conflictBlocked.value) return;
    activeKey.value = decision.key;
    FIELD_KEYS.forEach((field) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const doMerge = $(async () => {
    const decision = activeDecision.value;
    if (!decision || conflictBlocked.value) return;
    await capture();
    performMerge(state, decision.key, { ...choices });
    mergeOpen.value = false;
    notify('已生成合并记录，原记录保留；受影响候选已按现行规则重算');
  });

  // ── 记录补录 ──
  const doImportNew = $(async () => {
    let rows;
    try { rows = parseImportRows(importRaw.value); }
    catch { notify('导入内容格式不正确，请使用 JSON 数组或制表符/竖线分隔文本'); return; }
    if (!rows.length) return;
    await capture();
    const records = rows.map((row) => makeRecordSnap(
      { ...row, group: importGroup.value }, state.openBatchId, '馆内工作批次', 'import'
    ));
    const report = importNewRecords(state, records);
    importRaw.value = '';
    importFileName.value = '';
    importOpen.value = false;
    notify(`已补录 ${rows.length} 条记录，新增候选 ${report.newCandidates} 条、退回 ${report.reopened.length} 条`);
  });

  const readFile = $(async (element: HTMLInputElement, sink: 'import' | 'return') => {
    const file = element.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (sink === 'import') { importRaw.value = text; importFileName.value = file.name; }
    else { returnRaw.value = text; returnFileName.value = file.name; returnError.value = ''; }
  });

  // ── 编辑记录 ──
  const openEdit = $((recordId: string) => {
    const record = recordById(recordId);
    if (!record) return;
    editingId.value = recordId;
    FIELD_KEYS.forEach((field) => { editForm[field] = fieldText(record, field); });
    editOpen.value = true;
  });

  const saveEdit = $(async () => {
    const record = recordById(editingId.value);
    if (!record) return;
    await capture();
    const updates: Partial<Record<FieldKey, string | string[]>> = {
      title: editForm.title, date: editForm.date, identifier: editForm.identifier,
      medium: editForm.medium, extent: editForm.extent, rights: editForm.rights, notes: editForm.notes,
      people: editForm.people.split(/[，,、|]/).map((item) => item.trim()).filter(Boolean),
      places: editForm.places.split(/[，,、|]/).map((item) => item.trim()).filter(Boolean)
    };
    const report = editRecordFields(state, record.id, updates);
    editOpen.value = false;
    notify(report.reopened.length
      ? `已保存，${report.reopened.length} 条旧结论因关键字段变化退回待复核`
      : '已保存，相关候选已按现行规则重算');
  });

  // ── 分歧裁决 ──
  const adjudicate = $(async (conflictId: string, chosen: 'ours' | 'theirs') => {
    await capture();
    const report = resolveConflict(state, conflictId, chosen);
    const remaining = state.conflicts.filter((conflict) => !conflict.resolved).length;
    notify(remaining
      ? `已采用${chosen === 'ours' ? '馆内' : '离线'}结论，还剩 ${remaining} 条分歧；${report.reopened.length} 条候选退回待复核`
      : '全部分歧已裁决，可以继续合并与导出');
  });

  // ── 离馆出包 ──
  const doCheckout = $(() => {
    if (conflictBlocked.value) { notify('尚有分歧未裁决，不能生成离线核对包'); return; }
    try {
      const pack = createOfflinePackage(state, checkinAuthor.value.trim() || undefined);
      downloadJson(`离线核对包-${pack.exportedAt.slice(0, 10)}.json`, pack);
      history.value = [];
      future.value = [];
      checkinOpen.value = false;
      notify('已封存共同祖先检查点并下载离线核对包；馆内可继续工作，回馆时按祖先接续');
    } catch (error) {
      notify((error as Error).message);
    }
  });

  // ── 回馆汇入（失败保留原工作区，可重试）──
  const doReturnImport = $((event: Event) => {
    event.preventDefault();
    returnError.value = '';
    if (!returnRaw.value.trim()) { returnError.value = '请先选择离线核对包文件'; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(returnRaw.value); }
    catch { returnError.value = '文件不是有效 JSON，工作区未改动，可重新选择后重试'; return; }
    try {
      const report = importOfflinePackage(state, parsed, returnAuthor.value.trim() || undefined);
      history.value = [];
      future.value = [];
      selectedKeys.value = [];
      const total = report.autoAccepted.records + report.autoAccepted.decisions + report.autoAccepted.merges;
      returnReport.value = report.unrelated
        ? `未找到共同祖先，已按独立根接续：自动生效 ${total} 处，待裁决分歧 ${report.conflictsAdded} 条，重算退回 ${report.reopened.length} 条。`
        : `按共同祖先接续完成：自动生效 ${total} 处（字段 ${report.autoAccepted.records}、候选 ${report.autoAccepted.decisions}、合并 ${report.autoAccepted.merges}），待裁决分歧 ${report.conflictsAdded} 条，重算退回 ${report.reopened.length} 条。`;
      returnRaw.value = '';
      returnFileName.value = '';
      panelTab.value = 1;
      notify(report.conflictsAdded ? `汇入完成，${report.conflictsAdded} 条分歧待裁决` : '汇入完成，无分歧');
    } catch (error) {
      returnError.value = (error as Error).message;
    }
  });

  // ── 导出 ──
  const doExport = $(() => {
    if (conflictBlocked.value) { panelTab.value = 1; notify('仍有分歧未裁决，裁决前不能导出'); return; }
    try {
      const bundle = buildExportBundle(state);
      downloadJson(`档案核对结果-${bundle.exportedAt.slice(0, 10)}.json`, bundle);
      notify('已导出核对结果，内含完整祖先批次链与字段级修订来源');
    } catch (error) {
      notify((error as Error).message);
    }
  });

  // ── 本地持久化与旧数据迁移 ──
  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const legacyKey = 'sologsb-1020-archive-state-v1';
      if (raw) {
        const saved = JSON.parse(raw) as unknown;
        if (saved && typeof saved === 'object' && (saved as WorkspaceState).formatVersion === 2) {
          const loaded = saved as WorkspaceState;
          Object.assign(state, loaded, { hydrated: true });
          integrityBanner.value = integrityProblems(state);
          if (integrityBanner.value.length) notify('完整性检查发现批次链问题，详见版本链页签');
        } else if (isLegacyState(saved)) {
          const migrated = migrateLegacy(saved);
          migrated.hydrated = true;
          Object.assign(state, migrated);
          notify('已将旧版工作区升级为版本链结构并补建祖先批次');
        } else {
          integrityBanner.value = ['本地保存内容无法识别，已保持当前工作区不变'];
        }
      } else {
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw) {
          try {
            const migrated = migrateLegacy(JSON.parse(legacyRaw));
            migrated.hydrated = true;
            Object.assign(state, migrated);
            notify('检测到 v1 旧数据，已升级补祖先并按现行规则重算');
          } catch {
            notify('旧版数据无法解析，已从示例数据开始；旧数据键未删除');
          }
        }
        state.hydrated = true;
      }
    } catch {
      integrityBanner.value = ['本地工作区数据损坏，未覆盖任何数据，可刷新后重试'];
      state.hydrated = true;
    }
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify(state));
    if (state.hydrated) {
      try { localStorage.setItem(STORAGE_KEY, payload); } catch { /* 配额失败不阻断工作 */ }
    }
  });

  const moveReview = $(async (delta: number) => {
    const list = filteredDecisions.value;
    const index = list.findIndex((decision) => decision.key === activeDecision.value?.key);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      activeKey.value = next.key;
      document.querySelector(`[data-decision-key="${next.key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeDecision.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeDecision.value) { event.preventDefault(); setStatus(activeDecision.value.key, 'confirmed'); }
      if (key === 'r' && activeDecision.value) { event.preventDefault(); setStatus(activeDecision.value.key, 'rejected'); }
      if (key === 'x' && activeDecision.value) { event.preventDefault(); panelTab.value = 1; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const openBatch = getBatch(state, state.openBatchId);

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台 · 版本链</h1><p>ARCHIVE RECONCILIATION DESK · VERSION CHAIN</p></div>
        </div>
        <div class="top-stat">
          <span class="online-dot" />
          {state.hydrated ? `开放批次：${openBatch?.label ?? state.openBatchId.slice(0, 10)} · 链上 ${state.batches.length} 批` : '正在恢复本地工作区'}
        </div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => { importOpen.value = true; }}>补录记录</button>
          <button class="button ghost" onClick$={() => { checkinOpen.value = true; }}>离馆出包</button>
          <button class="button ghost" onClick$={() => { returnOpen.value = true; returnError.value = ''; returnReport.value = ''; }}>回馆汇入</button>
          <button class={`button ${conflictBlocked.value ? 'danger' : 'light'}`} onClick$={doExport}>导出核对结果</button>
        </div>
      </header>

      <div class="overview">
        <div>
          <span class="eyebrow">RECONCILIATION PROJECT</span>
          <h2>口述史与手稿元数据 · 可对账版本链</h2>
          <p>导入按共同祖先三方接续：只一边改过自动生效，两边改法不同列入分歧，裁决前不能合并或导出。</p>
        </div>
        <div class="metrics">
          <div><strong>{allRecords.value.filter((record) => record.group === 'A' && !record.supersededBy).length}</strong><span>A 组现行</span></div>
          <div><strong>{allRecords.value.filter((record) => record.group === 'B' && !record.supersededBy).length}</strong><span>B 组现行</span></div>
          <div><strong>{allDecisions.value.filter((decision) => decision.status === 'suggested').length}</strong><span>待复核</span></div>
          <div><strong class={reopenedCount.value ? 'warn-text' : ''}>{reopenedCount.value}</strong><span>带旧依据退回</span></div>
          <div class={openConflictCount.value ? 'danger' : ''}><strong>{openConflictCount.value}</strong><span>待裁决分歧</span></div>
        </div>
      </div>

      {conflictBlocked.value && (
        <div class="conflict-banner" onClick$={() => { panelTab.value = 1; }}>
          <strong>⚠ 存在 {openConflictCount.value} 条双方改法不同的分歧</strong>
          <span>已列出两份结论与来源修订批次；裁决前不能合并记录或导出核对结果，点此前往裁决。</span>
        </div>
      )}
      {integrityBanner.value.length > 0 && (
        <div class="integrity-banner">
          <strong>完整性提示：</strong><span>{integrityBanner.value.join('；')}</span>
        </div>
      )}

      <main class="desk-grid">
        {/* 01 匹配队列 */}
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J/K 移动 · C 确认 · R 忽略 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部候选</option>
              <option value="suggested">待复核</option>
              <option value="confirmed">已确认</option>
              <option value="rejected">已忽略</option>
              <option value="merged">已合并</option>
            </select>
            <button class="button small" disabled={!selectedKeys.value.length} onClick$={() => bulkStatus('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedKeys.value.length} onClick$={() => bulkStatus('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleDecisions.value.map((decision) => {
              const left = recordById(decision.leftId);
              const right = recordById(decision.rightId);
              const isActive = () => activeDecision.value?.key === decision.key;
              return (
                <article
                  data-decision-key={decision.key}
                  key={decision.key}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { activeKey.value = decision.key; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <input
                      type="checkbox"
                      class="plain-check"
                      aria-label={`选择候选 ${decision.key}`}
                      checked={selectedKeys.value.includes(decision.key)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedKeys.value = selectedKeys.value.includes(decision.key)
                          ? selectedKeys.value.filter((key) => key !== decision.key)
                          : [...selectedKeys.value, decision.key];
                      }}
                    />
                    <span class={`score ${decision.basis.score < LOW_SCORE ? 'low' : ''}`}>{Math.round(decision.basis.score * 100)}%</span>
                    <span class={`status ${decision.status}`}>{statusText(decision.status)}</span>
                    {decision.reopened && <span class="reopen-tag" title={decision.reopened.reason}>退回：{statusText(decision.reopened.oldStatus)}</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>{groupText('A')}</small><strong>{left?.title}</strong><span>{parseDateLabel(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>{groupText('B')}</small><strong>{right?.title}</strong><span>{parseDateLabel(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{decision.basis.reasons.join(' · ')}</div>
                  {decision.reopened && <div class="reopen-line" title={JSON.stringify(decision.reopened.oldBasis.left)}>↩ {decision.reopened.reason}</div>}
                </article>
              );
            })}
            {!visibleDecisions.value.length && <div class="empty-state">没有符合当前筛选条件的候选。</div>}
          </div>
        </section>

        {/* 02 记录索引 */}
        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">当前 {filteredRecords.value.length} 条 · 编辑触发重算</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value}
              onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value}
              onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
            <label class="check-inline"><input type="checkbox" checked={showSuperseded.value}
              onChange$={(event) => { showSuperseded.value = (event.target as HTMLInputElement).checked; }} />含合并原件</label>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>批次 / 状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong class={record.supersededBy ? 'struck' : ''}>{record.title}</strong>
                <span>{parseDateLabel(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class="record-meta">
                  <small title={`来源批次：${batchLabelOf(record.sourceBatchId)}`}>◷ {batchLabelOf(record.sourceBatchId).slice(0, 12)}</small>
                  {record.supersededBy
                    ? <span class="record-status merged">已合并 → {recordById(record.supersededBy)?.title.slice(0, 10)}</span>
                    : <button class="link-button" onClick$={() => openEdit(record.id)}>编辑重算</button>}
                </span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        {/* 03 右侧面板 */}
        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>复核详情</Tabs.Tab>
              <Tabs.Tab>{openConflictCount.value ? `分歧裁决 (${openConflictCount.value})` : '分歧裁决'}</Tabs.Tab>
              <Tabs.Tab>版本链</Tabs.Tab>
              <Tabs.Tab>修订审计</Tabs.Tab>
              <Tabs.Tab>帮助</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel class="tab-panel">
              {activeDecision.value ? (() => {
                const decision = activeDecision.value!;
                const left = recordById(decision.leftId)!;
                const right = recordById(decision.rightId)!;
                return <>
                  <div class="active-score">
                    <span>{Math.round(decision.basis.score * 100)}</span>
                    <div>
                      <strong>综合匹配分 · <span class={`status ${decision.status}`}>{statusText(decision.status)}</span></strong>
                      <small>{decision.basis.reasons.join(' · ')}</small>
                      {decision.reopened && <small class="reopen-text">↩ {decision.reopened.reason}（原结论：{statusText(decision.reopened.oldStatus)}）</small>}
                    </div>
                  </div>
                  <div class="field-compare compact">
                    <div class="field-label">字段</div><div>A 来源 <small class="src-batch">{batchLabelOf(left.origins.title?.batchId).slice(0, 10)}</small></div><div>B 来源 <small class="src-batch">{batchLabelOf(right.origins.title?.batchId).slice(0, 10)}</small></div>
                    {FIELD_KEYS.map((field) => {
                      const different = fieldText(left, field) !== fieldText(right, field);
                      return <><div class="field-label">{FIELD_LABELS[field]}</div>
                        <div class={different ? 'different' : ''}>{fieldText(left, field) || '—'}</div>
                        <div class={different ? 'different' : ''}>{fieldText(right, field) || '—'}</div></>;
                    })}
                  </div>
                  {conflictBlocked.value && <div class="block-note">分歧未裁决期间，合并功能锁定。</div>}
                  <div class="action-stack">
                    <button class="button primary wide" disabled={conflictBlocked.value} onClick$={openMerge}>逐字段合并</button>
                    <div class="split-actions">
                      <button class="button confirm" onClick$={() => setStatus(decision.key, 'confirmed')}>确认匹配 (C)</button>
                      <button class="button ghost" onClick$={() => setStatus(decision.key, 'rejected')}>忽略 (R)</button>
                    </div>
                  </div>
                </>;
              })() : <div class="empty-state">从左侧选择一条候选查看字段来源。</div>}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel conflict-panel">
              {conflictList.value.length ? <>
                {conflictList.value.map((conflict) => (
                  <div class={`conflict-card ${conflict.resolved ? 'resolved' : ''}`} key={conflict.id}>
                    <div class="conflict-head">
                      <strong>{conflict.entityLabel}</strong>
                      <span class="conflict-field">{conflict.fieldLabel}</span>
                      {conflict.resolved
                        ? <span class="status confirmed">已采用{conflict.chosen === 'ours' ? '馆内' : '离线'}</span>
                        : <span class="status suggested">待裁决</span>}
                    </div>
                    <div class="conflict-three">
                      <div class="conflict-side base"><small>共同祖先 · {conflict.base?.batchLabel ?? '无'}</small><p>{conflict.baseText || '—'}</p></div>
                      <div class="conflict-side ours"><small>馆内结论 · {conflict.ours.batchLabel}</small><p>{conflict.oursText || '—'}</p></div>
                      <div class="conflict-side theirs"><small>离线结论 · {conflict.theirs.batchLabel}{conflict.theirs.author ? ` · ${conflict.theirs.author}` : ''}</small><p>{conflict.theirsText || '—'}</p></div>
                    </div>
                    {!conflict.resolved && <div class="conflict-actions">
                      <button class="button small confirm" onClick$={() => adjudicate(conflict.id, 'ours')}>采用馆内结论</button>
                      <button class="button small" onClick$={() => adjudicate(conflict.id, 'theirs')}>采用离线结论</button>
                    </div>}
                  </div>
                ))}
              </> : <div class="empty-state">没有分歧记录。双方改法不同时，两份结论和来源修订会列在这里。</div>}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel chain-panel">
              <div class="chain-list">
                {chain.value.map(({ batch, depth }) => (
                  <div class={`chain-node kind-${batch.kind} ${batch.id === state.openBatchId ? 'open' : ''}`} key={batch.id} style={`margin-left:${depth * 18}px`}>
                    <span class="chain-kind">{BATCH_KIND_LABEL[batch.kind] ?? batch.kind}</span>
                    <div>
                      <strong>{batch.label}</strong>
                      <small>{new Date(batch.createdAt).toLocaleString('zh-CN', { hour12: false })}
                        {batch.author ? ` · ${batch.author}` : ''}</small>
                      <small class="chain-parents">父批次：{batch.parents.length
                        ? batch.parents.map((parent) => batchLabelOf(parent)).join('、')
                        : '（链根）'}</small>
                    </div>
                    {batch.id === state.openBatchId && <span class="chain-open-tag">当前工作区</span>}
                  </div>
                ))}
              </div>
              <p class="chain-note">每个封存批次持有一份不可变快照与祖先指针；再次离馆/回馆时以最近共同祖先做三方接续。</p>
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel">
              <div class="rev-list">
                {state.revisions.slice(0, 60).map((revision) => (
                  <div class="rev-entry" key={revision.id}>
                    <time>{new Date(revision.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                    <div>
                      <strong>{revision.action}
                        {revision.sourceBatchId && revision.sourceBatchId !== state.openBatchId
                          && <span class="src-tag">源自：{revision.sourceBatchLabel ?? batchLabelOf(revision.sourceBatchId)}</span>}
                      </strong>
                      <p>{revision.detail}</p>
                    </div>
                  </div>
                ))}
                {!state.revisions.length && <div class="empty-state">还没有修订记录。</div>}
              </div>
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条候选</span></div>
              <div><kbd>Enter</kbd><span>打开逐字段合并（分歧未清时锁定）</span></div>
              <div><kbd>C / R</kbd><span>确认 / 忽略当前候选</span></div>
              <div><kbd>X</kbd><span>跳到分歧裁决页签</span></div>
              <div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（仅当前工作批次）</span></div>
              <div><kbd>Ctrl + I</kbd><span>补录记录</span></div>
              <div class="rule-text">
                <p>1. 离馆出包会封存共同祖先检查点；回馆汇入只自动接续单边改动，双边分歧必须裁决。</p>
                <p>2. 标题、日期、人物、地点变化后候选按现行规则重算；已确认/忽略/合并结论带旧依据退回待复核。</p>
                <p>3. 记录、匹配、合并与审计均保留来源批次；导出包含祖先链与字段级修订来源。</p>
              </div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>审计轨迹（含来源批次）</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 10).map((entry) => <div class="audit-entry" key={entry.id}>
              <time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
              <div>
                <strong>{entry.action}
                  {entry.sourceBatchId && <span class="src-tag">{entry.sourceBatchLabel ?? batchLabelOf(entry.sourceBatchId)}</span>}
                </strong>
                <p>{entry.detail}</p>
              </div>
              <span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '批次'}</span>
            </div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>对账与保护规则</h3></div></div>
          <div class="rule-row"><span>1</span><p>汇入按共同祖先三方接续：单边改动自动生效，双边不同进分歧清单，裁决前禁止合并与导出。</p></div>
          <div class="rule-row"><span>2</span><p>关键字段（标题/日期/人物/地点）变化触发现行规则重算，旧结论携带旧依据回到待复核。</p></div>
          <div class="rule-row"><span>3</span><p>记录、匹配、合并、修订、审计都带来源批次；旧版数据升级时补建祖先链。</p></div>
          <div class="rule-row"><span>4</span><p>汇入先在草稿上完成，包损坏或中断不触碰原工作区，可直接重试；撤销重做只影响当前工作批次。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 补录记录 */}
      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>向当前工作批次补录记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">新记录归属当前开放批次并保留来源，导入后自动按现行规则重算候选。支持 JSON 数组或制表符/竖线分隔文本。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(_, element) => readFile(element, 'import')} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value}
            onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value}
            placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importFileName.value && <div class="file-name">已读取：{importFileName.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={doImportNew}>补录并重算</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 编辑记录 */}
      <Modal.Root bind:show={editOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel edit-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">EDIT &amp; RECOMPUTE</span><Modal.Title>编辑记录字段</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">修改标题、日期、人物或地点保存后，相关候选按现行规则重算，受影响的已确认/忽略/合并结论带旧依据退回待复核。</Modal.Description>
          <div class="edit-grid">
            {FIELD_KEYS.map((field) => <label class="edit-field" key={field}>
              <span>{FIELD_LABELS[field]}{field === 'people' || field === 'places' ? <small>（顿号分隔）</small> : ''}</span>
              {field === 'notes'
                ? <textarea value={editForm[field]} onInput$={(event) => editForm[field] = (event.target as HTMLTextAreaElement).value} />
                : <input value={editForm[field]} onInput$={(event) => editForm[field] = (event.target as HTMLInputElement).value} />}
            </label>)}
          </div>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={saveEdit}>保存并重算候选</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 合并 */}
      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeDecision.value && (() => {
            const decision = activeDecision.value!;
            const left = recordById(decision.leftId)!;
            const right = recordById(decision.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段显示两条记录的值与其来源批次。合并后原记录保留并标记接替关系，字段来源随合并结果保留。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源 · {batchLabelOf(left.origins.title?.batchId)}</span><span>B 组来源 · {batchLabelOf(right.origins.title?.batchId)}</span></div>
              <div class="field-picker">
                {FIELD_KEYS.map((field) => {
                  const leftValue = fieldText(left, field) || '—';
                  const rightValue = fieldText(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}>
                    <div class="picker-label"><strong>{FIELD_LABELS[field]}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div>
                    <label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}>
                      <input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} />
                      <span><b>A</b>{leftValue}</span>
                    </label>
                    <label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}>
                      <input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} />
                      <span><b>B</b>{rightValue}</span>
                    </label>
                    <button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'}>拼接</button>
                  </div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={doMerge}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>

      {/* 离馆出包 */}
      <Modal.Root bind:show={checkinOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel small-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">CHECK OUT</span><Modal.Title>离馆核对包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">
            将封存当前工作批次作为<strong>共同祖先检查点</strong>并下载离线核对包（含全量快照）。
            馆内此后可继续工作；回馆汇入时按该祖先接续，单边离线改动自动生效，双边改法不同进入分歧裁决。
            {conflictBlocked.value && <strong class="warn-text"> 当前有未裁决分歧，不能出包。</strong>}
          </Modal.Description>
          <div class="import-controls vertical">
            <label class="edit-field"><span>离线核对人（可选）</span>
              <input placeholder="例如：档案员小李" value={checkinAuthor.value} onInput$={(event) => checkinAuthor.value = (event.target as HTMLInputElement).value} /></label>
          </div>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" disabled={conflictBlocked.value} onClick$={doCheckout}>封存检查点并下载离线包</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 回馆汇入 */}
      <Modal.Root bind:show={returnOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel small-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">CHECK IN</span><Modal.Title>回馆汇入离线核对包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">
            汇入在草稿上完成：核对包损坏、结构不符或中断时<strong>当前工作区保持不变</strong>，可重新选择重试。
          </Modal.Description>
          <form class="import-controls vertical" onSubmit$={doReturnImport}>
            <label class="edit-field"><span>回馆核对人（可选）</span>
              <input placeholder="姓名" value={returnAuthor.value} onInput$={(event) => returnAuthor.value = (event.target as HTMLInputElement).value} /></label>
            <label class="file-button wide">选择离线核对包 JSON
              <input type="file" accept=".json" onChange$={(_, element) => readFile(element, 'return')} /></label>
            {returnFileName.value && <div class="file-name">已读取：{returnFileName.value}</div>}
            {returnError.value && <div class="error-text">✕ {returnError.value}</div>}
            {returnReport.value && <div class="report-text">✓ {returnReport.value}</div>}
            <Modal.Footer class="modal-footer">
              <Modal.Close class="button ghost">关闭</Modal.Close>
              <button class="button primary" type="submit" disabled={!returnRaw.value.trim()}>按共同祖先接续汇入</button>
            </Modal.Footer>
          </form>
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
