import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, FieldKey, MatchCandidate, PersistedWorkspace, RecordGroup,
  StagedImport, StateContent, Conflict
} from './types';
import { fieldValue } from './utils/matching';
import { RULE_VERSION, batchLabel as batchLabelOf } from './version/core';
import {
  buildPackage, bulkDecide, decideMatch, editRecord, importRawRows,
  mergePair, migrateOrSeed, packageDownloadName, saveWorkspace
} from './version/workspace';
import { commitStagedImport, fieldLabel, matchDecisionLabel, parsePackage, stageImport } from './version/merge';

const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const parseRows = (raw: string): Array<Partial<ArchiveRecord>> => {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text) as Array<Partial<ArchiveRecord>>;
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const cells = line.split(/\t|\|/).map((cell) => cell.trim());
    return {
      title: cells[0] || `未命名记录 ${index + 1}`,
      date: cells[1] || '',
      people: (cells[2] || '').split(/[；;、,，]/).filter(Boolean),
      places: (cells[3] || '').split(/[；;、,，]/).filter(Boolean),
      identifier: cells[4] || '',
      medium: cells[5] || '',
      extent: cells[6] || '',
      rights: cells[7] || '',
      notes: cells[8] || ''
    };
  });
};

export default component$(() => {
  const booted = useSignal(false);
  const state = useStore<PersistedWorkspace>({
    format: 2, workspaceId: '', revisionCounter: 0, headId: null,
    records: [], matches: [], merges: [], batches: [], revisions: [], audit: [],
    activeMatchId: '', hydrated: false, snapshots: {}, importBases: []
  });
  const history = useSignal<Array<{ headId: string; label: string }>>([]);
  const future = useSignal<Array<{ headId: string; label: string }>>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | MatchCandidate['status']>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const editOpen = useSignal(false);
  const chainOpen = useSignal(false);
  const importMode = useSignal<'raw' | 'package'>('raw');
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importFileName = useSignal('');
  const importError = useSignal('');
  const importInfo = useSignal('');
  const stage = useSignal<StagedImport | null>(null);
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const recovered = useSignal(false);
  const legacyNotice = useSignal('');

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });
  const editing = useStore<{ id?: string; title: string; date: string; people: string; places: string }>({ title: '', date: '', people: '', places: '' });

  const recordById = (id?: string) => state.records.find((record) => record.id === id);
  const matchLabel = (match: MatchCandidate) =>
    `${recordById(match.leftId)?.title ?? '未知记录'} ↔ ${recordById(match.rightId)?.title ?? '未知记录'}`;
  const batchLabel = (batchId?: string) => batchId ? batchLabelOf(state, batchId) : '无来源';

  const persist = () => saveWorkspace(state);

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  // 快照裁剪：保留全部根修订、来件祖先与最近 60 个修订的内容，避免 localStorage 无限增长
  const pruneSnapshots = () => {
    const roots = new Set(state.revisions.filter((revision) => revision.parents.length === 0).map((revision) => revision.id));
    const recent = new Set(state.revisions.slice(-60).map((revision) => revision.id));
    const keep = new Set<string>([...roots, ...recent, ...state.importBases]);
    if (state.headId) keep.add(state.headId);
    Object.keys(state.snapshots).forEach((id) => {
      if (!keep.has(id)) delete state.snapshots[id];
    });
  };

  // 应用一个本地单父修订
  const applyCommit = (commit: ReturnType<typeof decideMatch> | NonNullable<ReturnType<typeof mergePair>> | ReturnType<typeof importRawRows> | NonNullable<ReturnType<typeof editRecord>>) => {
    if (!commit) return;
    if (state.headId) history.value = [...history.value.slice(-49), { headId: state.headId, label: state.revisions.find((revision) => revision.id === state.headId)?.message ?? '' }];
    future.value = [];
    state.records = commit.content.records;
    state.matches = commit.content.matches;
    state.merges = commit.content.merges;
    state.batches = [...state.batches, ...commit.batches];
    state.revisions = [...state.revisions, ...commit.revisions];
    state.audit = [...commit.audit, ...state.audit].slice(0, 600);
    state.headId = commit.revision.id;
    state.revisionCounter += 1;
    state.snapshots[commit.revision.id] = {
      records: commit.content.records.map((record) => ({ ...record })),
      matches: commit.content.matches.map((match) => ({ ...match })),
      merges: commit.content.merges.map((merge) => ({ ...merge }))
    };
    pruneSnapshots();
    persist();
  };

  const checkout = (targetHeadId: string) => {
    const snapshot = state.snapshots[targetHeadId];
    if (!snapshot) { notify('该修订的内容快照缺失，无法跳转'); return; }
    state.records = snapshot.records.map((record) => ({ ...record }));
    state.matches = snapshot.matches.map((match) => ({ ...match }));
    state.merges = snapshot.merges.map((merge) => ({ ...merge }));
    state.headId = targetHeadId;
    state.activeMatchId = '';
  };

  const undo = $(() => {
    const last = history.value.at(-1);
    if (!last || !state.headId) return;
    future.value = [...future.value, { headId: state.headId, label: state.revisions.find((revision) => revision.id === state.headId)?.message ?? '' }];
    history.value = history.value.slice(0, -1);
    checkout(last.headId);
    persist();
    notify('已撤销：仅当前工作区回到上一修订，版本链保留');
  });

  const redo = $(() => {
    const next = future.value.at(-1);
    if (!next) return;
    if (state.headId) history.value = [...history.value, { headId: state.headId, label: '' }];
    future.value = future.value.slice(0, -1);
    checkout(next.headId);
    persist();
    notify('已重做：仅当前工作区前进到该修订');
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));
  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictOpenCount = useSignal(0);
  const staleCount = useComputed$(() => state.matches.filter((match) => match.oldBasis).length);

  const updateMatch = $((id: string, status: 'confirmed' | 'rejected') => {
    if (stage.value) { notify('存在未完成裁决的接续导入，裁决前不能处理候选'); return; }
    const commit = decideMatch(state, id, status);
    if (!commit) return;
    applyCommit(commit);
    notify(status === 'confirmed' ? '已确认，结论带来源批次入账' : '已忽略，结论带来源批次入账');
  });

  const bulkMatch = $((status: 'confirmed' | 'rejected') => {
    if (stage.value) return;
    const commit = bulkDecide(state, selectedMatchIds.value, status);
    if (!commit) return;
    applyCommit(commit);
    selectedMatchIds.value = [];
    notify(`批量${status === 'confirmed' ? '确认' : '忽略'} ${commit.audit[0].recordIds.length / 2} 条候选`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (stage.value) { notify('接续导入裁决完成前不能合并'); return; }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });
  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match || stage.value) return;
    const commit = mergePair(state, match.id, { chosen: { ...choices } });
    if (!commit) return;
    applyCommit(commit);
    mergeOpen.value = false;
    notify('已生成合并记录；逐字段来源批次、原记录与修订已入账');
  });

  const openEditor = $((record: ArchiveRecord) => {
    if (stage.value) { notify('接续导入裁决完成前不能修改记录'); return; }
    Object.assign(editing, {
      id: record.id, title: record.title, date: record.date,
      people: record.people.join('、'), places: record.places.join('、')
    });
    editOpen.value = true;
  });

  const closeEditor = $(() => {
    editOpen.value = false;
    Object.keys(editing).forEach((key) => delete (editing as Record<string, unknown>)[key]);
  });

  const saveEditor = $(() => {
    if (!editing.id) return;
    const commit = editRecord(state, editing.id, {
      title: editing.title.trim(),
      date: editing.date.trim(),
      people: editing.people.split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean),
      places: editing.places.split(/[；;、,，\n]/).map((item) => item.trim()).filter(Boolean)
    });
    if (!commit) { notify('内容没有变化'); return; }
    applyCommit(commit);
    editOpen.value = false;
    editing.id = undefined;
    notify(`已按现行规则（${RULE_VERSION}）重算：${commit.audit[0].detail.split('：')[1] ?? ''}`);
  });

  // ---- 导入：原始文本 或 核对包接续 ----

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importFileName.value = file.name;
    importRaw.value = await file.text();
    importError.value = '';
    importInfo.value = '';
  });

  const submitImport = $(async () => {
    importError.value = '';
    if (stage.value) { importError.value = '请先完成当前接续导入的冲突裁决或取消暂存。'; return; }
    if (importMode.value === 'raw') {
      let rows: Array<Partial<ArchiveRecord>>;
      try { rows = parseRows(importRaw.value); }
      catch { importError.value = '内容不是 JSON 数组或制表符/竖线分隔文本。'; return; }
      if (!rows.length) { importError.value = '没有可导入的行。'; return; }
      const commit = importRawRows(state, rows, importGroup.value);
      applyCommit(commit);
      importRaw.value = ''; importFileName.value = ''; importOpen.value = false;
      notify(`已导入 ${rows.length} 条并按现行规则重算，未覆盖任何旧结论`);
      return;
    }

    // 核对包：解析校验 → 定位共同祖先 → 预演
    const parsed = await parsePackage(importRaw.value, importFileName.value || '核对包.json');
    if (!parsed.ok) { importError.value = parsed.error; return; }
    let baseContent: StateContent | null = null;
    if (parsed.legacy) legacyNotice.value = parsed.legacyLabel;
    // 共同祖先内容：优先用本地快照精确重建
    const graphBase = findBaseId(state, parsed.pkg.head.revisionId, parsed.pkg.baseAncestorId, parsed.pkg.revisions);
    if (graphBase && state.snapshots[graphBase]) baseContent = state.snapshots[graphBase];
    const staged = stageImport(state, parsed.pkg, importFileName.value || '核对包.json', baseContent, parsed.legacy ? parsed.legacyLabel : undefined);
    stage.value = staged;
    conflictOpenCount.value = staged.conflicts.length;
    if (!staged.conflicts.length) {
      // 无冲突：直接接续提交（快进或自动合并）
      commitStage();
    } else {
      importInfo.value = `发现 ${staged.conflicts.length} 处双方处理不同：请逐条查看两份结论与来源修订，全部裁决后才能合并或导出。`;
      importOpen.value = false;
      panelTab.value = 1;
      notify(`有 ${staged.conflicts.length} 处冲突待裁决，裁决前不能合并或导出`);
    }
  });

  const commitStage = () => {
    const staged = stage.value;
    if (!staged) return;
    if (staged.conflicts.some((conflict) => !conflict.resolution)) {
      notify(`还有 ${staged.conflicts.filter((conflict) => !conflict.resolution).length} 处未裁决，不能接续合并`);
      return;
    }
    if (state.headId) history.value = [...history.value.slice(-49), { headId: state.headId, label: '接续前版本' }];
    future.value = [];
    const result = commitStagedImport(state, staged);
    state.records = result.content.records;
    state.matches = result.content.matches;
    state.merges = result.content.merges;
    state.batches = [...state.batches, ...result.batches];
    state.revisions = [...state.revisions, ...result.revisions];
    state.audit = [...result.audit, ...staged.incomingAudit, ...state.audit].slice(0, 600);
    state.headId = result.revision.id;
    state.revisionCounter += 1;
    state.importBases = [...state.importBases, staged.incomingHead];
    // 来件头内容留档：下一轮导出时作为共同祖先快照交给对方
    state.snapshots[staged.incomingHead] = {
      records: staged.incomingSnapshot.records.map((record) => ({ ...record })),
      matches: staged.incomingSnapshot.matches.map((match) => ({ ...match })),
      merges: staged.incomingSnapshot.merges.map((merge) => ({ ...merge }))
    };
    state.snapshots[result.revision.id] = {
      records: result.content.records.map((record) => ({ ...record })),
      matches: result.content.matches.map((match) => ({ ...match })),
      merges: result.content.merges.map((merge) => ({ ...merge }))
    };
    pruneSnapshots();
    persist();
    const summary = result.resetSummary;
    stage.value = null;
    conflictOpenCount.value = 0;
    importRaw.value = ''; importFileName.value = ''; importInfo.value = '';
    importOpen.value = false;
    notify(`接续完成：自动生效 ${staged.autoChanges.length} 项，${summary.count} 条旧结论回到待复核，新增候选 ${summary.added} 条`);
  };

  const resolveConflict = $((conflictId: string, pick: Conflict['resolution'] extends infer _ ? 'local' | 'incoming' | 'custom' : never, custom?: string) => {
    const staged = stage.value;
    if (!staged) return;
    const conflict = staged.conflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    const wasUnresolved = !conflict.resolution;
    conflict.resolution = {
      pick,
      ...(pick === 'custom' ? { custom: custom ?? '' } : {}),
      batchId: staged.stageBatchId,
      revisionId: staged.commitRevisionId,
      at: new Date().toISOString()
    };
    if (wasUnresolved) {
      conflictOpenCount.value = Math.max(0, conflictOpenCount.value - 1);
    }
    if (conflictOpenCount.value === 0) {
      notify('全部冲突已裁决，可以执行接续合并');
    }
  });

  const cancelStage = $(() => {
    stage.value = null;
    conflictOpenCount.value = 0;
    importError.value = '';
    importInfo.value = '';
    notify('已取消接续预演，工作区未做任何改动，可重新选择包重试');
  });

  const exportPackage = $(async () => {
    if (stage.value) { notify('接续导入尚有未裁决冲突，裁决前不能导出'); return; }
    const pkg = await buildPackage(state, state.importBases);
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = packageDownloadName(state);
    anchor.click();
    URL.revokeObjectURL(url);
    notify('核对包已导出：含祖先修订、祖先快照与全部字段/结论来源批次');
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // 启动：优先恢复 v2，其次从 staging 恢复，再其次升级 v1 旧数据补祖先
  useVisibleTask$(() => {
    const result = migrateOrSeed();
    Object.assign(state, result.persisted, { hydrated: true });
    recovered.value = result.recovered;
    legacyNotice.value = result.legacy ? '已检测到旧版本地工作区：升级时为全部内容补上了祖先修订与来源批次。' : '';
    booted.value = true;
  });

  useVisibleTask$(({ track }) => {
    track(booted);
    if (!booted.value) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editingInput = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editingInput) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const headShort = state.headId?.slice(6, 12) ?? '—';
  const chainDepth = state.revisions.length;

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK · 可对账版本链</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revisionCounter} · @${headShort} · 链长 ${chainDepth}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => { importMode.value = 'raw'; importOpen.value = true; }}>导入</button>
          <button class="button ghost" onClick$={() => chainOpen.value = true}>版本链</button>
          <button class="button light" disabled={Boolean(stage.value)} onClick$={exportPackage}>导出核对包</button>
        </div>
      </header>

      {(legacyNotice.value || recovered.value || staleCount.value) && (
        <div class="notice-bar">
          {recovered.value && <span class="notice warn">检测到上次写入中断，已从暂存副本恢复，原工作区可继续重试。</span>}
          {legacyNotice.value && <span class="notice">{legacyNotice.value}</span>}
          {staleCount.value > 0 && <span class="notice warn">{staleCount.value} 条候选的旧结论（确认/忽略/合并）因标题、日期、人物或地点变化带旧依据回到待复核。</span>}
          {stage.value && <span class="notice danger">接续导入暂存中：{conflictOpenCount.value} 处冲突待裁决，裁决前不能合并或导出。</span>}
        </div>
      )}

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>导入按共同祖先三方接续：只一边改过的自动生效，双方处理不同的列出两份结论与来源修订，裁决前不得合并或导出。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核候选</span></div>
          <div class="danger"><strong>{conflictOpenCount.value}</strong><span>待裁决冲突</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J/K 移动 · C/R 确认忽略 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部候选</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option><option value="merged">已合并</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length || Boolean(stage.value)} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length || Boolean(stage.value)} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(match.leftId);
              const right = recordById(match.rightId);
              return (
                <article data-match-id={match.id} class={`match-card ${state.activeMatchId === match.id ? 'active' : ''}`} onClick$={() => { state.activeMatchId = match.id; }} tabIndex={0}>
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label="选择候选"
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{matchDecisionLabel(match.status)}</span>
                    {match.oldBasis && <span class="reset-badge" title={`旧结论：${matchDecisionLabel(match.oldBasis.status)}，${match.oldBasis.resetReason}`}>旧:{matchDecisionLabel(match.oldBasis.status)}↩</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">
                    {match.reasons.join(' · ') || '旧结论失效，待重新评估'}
                    {match.status !== 'suggested' && <em> · 结论批次：{batchLabel(match.decidedBy)}</em>}
                  </div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的候选。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">点击「修订」改标题/日期/人物/地点会触发重算</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}{record.stale && <span class="stale-dot" title={record.staleReason ?? '合并依据已陈旧'}>旧依据</span>}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small><small class="src-line">来源批次：{batchLabel(record.batchId)}</small></span>
                <code>{record.identifier}</code>
                <span class="row-actions">
                  <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : '已合并'}</span>
                  <button class="link-button" disabled={Boolean(stage.value)} onClick$={() => openEditor(record)}>修订</button>
                </span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>复核详情</Tabs.Tab>
              <Tabs.Tab>接续裁决{stage.value ? ` (${conflictOpenCount.value})` : ''}</Tabs.Tab>
              <Tabs.Tab>合并追溯</Tabs.Tab>
              <Tabs.Tab>键盘帮助</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const match = activeMatch.value!;
                const left = recordById(match.leftId)!;
                const right = recordById(match.rightId)!;
                return <>
                  {match.oldBasis && (
                    <div class="basis-box">
                      <strong>旧依据回到待复核</strong>
                      <p>原结论「{matchDecisionLabel(match.oldBasis.status)}」（{match.oldBasis.resetReason}）。旧评分 {Math.round(match.oldBasis.score * 100)}%，规则版本 {match.oldBasis.ruleVersion}；现评分 {Math.round(match.score * 100)}%，规则版本 {match.ruleVersion}。</p>
                      <small>重置批次：{batchLabel(match.oldBasis.resetBatchId)} · {new Date(match.oldBasis.resetAt).toLocaleString('zh-CN')}</small>
                    </div>
                  )}
                  <div class="active-score"><span>{Math.round(match.score * 100)}</span><div><strong>综合匹配分 · 规则 {match.ruleVersion}</strong><small>{match.reasons.join(' · ')}</small>{match.status !== 'suggested' && <small>人工结论来自批次：{batchLabel(match.decidedBy)}（修订 {match.decidedIn?.slice(6, 12)}）</small>}</div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => (
                      <><div class="field-label">{label}</div>
                        <div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}<small class="cell-src">{batchLabel(left.provenance[field]?.batchId)}</small></div>
                        <div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}<small class="cell-src">{batchLabel(right.provenance[field]?.batchId)}</small></div>
                      </>
                    ))}
                  </div>
                  <div class="action-stack">
                    <button class="button primary wide" disabled={Boolean(stage.value)} onClick$={openMerge}>逐字段合并</button>
                    <div class="split-actions"><button class="button confirm" disabled={Boolean(stage.value)} onClick$={() => updateMatch(match.id, 'confirmed')}>确认匹配 (C)</button><button class="button ghost" disabled={Boolean(stage.value)} onClick$={() => updateMatch(match.id, 'rejected')}>忽略 (R)</button></div>
                  </div>
                </>;
              })() : <div class="empty-state">从左侧选择一条候选查看字段来源与旧依据。</div>}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel stage-panel">
              {!stage.value && <div class="empty-state">没有进行中的接续导入。导入他人核对包时，两份结论与来源修订会列在此处等待裁决。</div>}
              {stage.value && (
                <>
                <div class="stage-head">
                  <span class="eyebrow">THREE-WAY RECONCILIATION</span>
                  <h4>{stage.value.isFastForward ? '快进接续' : '按共同祖先接续'} · {stage.value.fileName}</h4>
                  <p>共同祖先：{stage.value.baseAncestryLabel}；本账头 @{stage.value.localHead.slice(6, 12)}，来件头 @{stage.value.incomingHead.slice(6, 12)}</p>
                </div>
                <details class="auto-details" open>
                  <summary>自动生效（只一边改过，{stage.value.autoChanges.length} 项）</summary>
                  <ul class="auto-list">
                    {stage.value.autoChanges.slice(0, 60).map((change, index) => <li key={index}><span class={`side-tag ${change.side}`}>{change.side === 'incoming' ? '对方改' : change.side === 'both' ? '双方' : '本账改'}</span>{change.summary}</li>)}
                  </ul>
                </details>
                <div class="conflict-list">
                  <h5>双方处理不同 · 两份结论与来源修订（{stage.value.conflicts.length}）</h5>
                  {stage.value.conflicts.map((conflict, index) => (
                    <div class={`conflict-card ${conflict.resolution ? 'resolved' : ''}`} key={conflict.id}>
                      <div class="conflict-title">
                        <strong>#{index + 1} {conflictSubjectLabel(conflict)}</strong>
                        <span class="conflict-entity">{conflict.recordId ? recordById(conflict.recordId)?.title : conflict.matchId ? matchLabel(state.matches.find((m) => m.id === conflict.matchId)!) : conflict.mergeId}</span>
                      </div>
                      <div class="conclusion-grid">
                        <div class="conclusion base"><small>共同祖先</small><p>{conflict.baseText ?? '（祖先处不存在）'}</p></div>
                        <div class={`conclusion local ${conflict.resolution?.pick === 'local' ? 'picked' : ''}`}>
                          <small>本账结论{conflict.local.label ? ` · ${conflict.local.label}` : ''}{conflict.local.revisionId ? ` · @${conflict.local.revisionId.slice(6, 12)}` : ''}</small>
                          <p>{conflict.subject === 'record-status' || conflict.subject === 'match-decision' ? conflict.local.text : conflict.local.text}</p>
                        </div>
                        <div class={`conclusion incoming ${conflict.resolution?.pick === 'incoming' ? 'picked' : ''}`}>
                          <small>对方结论{conflict.incoming.label ? ` · ${conflict.incoming.label}` : ''}{conflict.incoming.revisionId ? ` · @${conflict.incoming.revisionId.slice(6, 12)}` : ''}</small>
                          <p>{conflict.subject === 'record-status' || conflict.subject === 'match-decision' ? conflict.incoming.text : conflict.incoming.text}</p>
                        </div>
                      </div>
                      <div class="verdict-row">
                        <button class={`button small ${conflict.resolution?.pick === 'local' ? 'confirm' : 'ghost'}`} onClick$={() => resolveConflict(conflict.id, 'local')}>采用本账</button>
                        <button class={`button small ${conflict.resolution?.pick === 'incoming' ? 'confirm' : 'ghost'}`} onClick$={() => resolveConflict(conflict.id, 'incoming')}>采用对方</button>
                        {(conflict.subject === 'record-field' || conflict.subject === 'merge-field') && (
                          <span class="custom-wrap">
                            <input class="input custom-input" placeholder="或输入自定义取值后裁决" value={conflict.resolution?.pick === 'custom' ? conflict.resolution.custom : ''} onInput$={(event) => { ((event.target as HTMLInputElement)); resolveConflict(conflict.id, 'custom', (event.target as HTMLInputElement).value); }} />
                          </span>
                        )}
                        {conflict.resolution && <span class="resolved-tag">已裁决：{conflict.resolution.pick === 'local' ? '本账' : conflict.resolution.pick === 'incoming' ? '对方' : '自定义'}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <div class="stage-footer">
                  <button class="button ghost" onClick$={cancelStage}>取消预演（工作区不变，可重试）</button>
                  <button class="button primary" disabled={conflictOpenCount.value > 0} onClick$={commitStage}>全部裁决，接续合并并重算</button>
                </div>
                </>
              )}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(merge.leftId);
                const right = recordById(merge.rightId);
                const mergedRecord = recordById(merge.mergedRecordId);
                return (
                  <details class="merge-log" key={merge.id}>
                    <summary>
                      {left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}
                      {merge.basisStale && <span class="reset-badge">依据陈旧↩</span>}
                      {merge.supersededBy && <span class="superseded-badge">已被重新合并取代</span>}
                    </summary>
                    <p>{new Date(merge.mergedAt).toLocaleString('zh-CN')} · 合并批次：{batchLabel(merge.batchId)} · 修订 @{merge.revisionId.slice(6, 12)}{mergedRecord ? ` · 合并记录「${mergedRecord.title}」` : ''}</p>
                    <ul>{Object.entries(merge.chosen).map(([field, choice]) => (
                      <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>{choice === 'A' ? '保留 A 来源' : choice === 'B' ? '保留 B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span><small>裁决批次：{batchLabel(merge.choiceSource[field as FieldKey]?.batchId)}</small></li>
                    ))}</ul>
                  </details>
                );
              }) : <div class="empty-state">还没有合并记录。</div>}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条候选</span></div>
              <div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div>
              <div><kbd>C / R</kbd><span>确认 / 忽略当前候选（带来源批次）</span></div>
              <div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（只影响当前工作区，版本链保留）</span></div>
              <div><kbd>Ctrl + I</kbd><span>打开导入（原始数据 / 核对包接续）</span></div>
              <div class="help-note">接续导入存在未裁决冲突时，合并、再导入、导出都会被锁定；取消预演则工作区原样不变，可重试。</div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>审计轨迹（含来源批次与修订）</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 10).map((entry) => (
              <div class="audit-entry" key={entry.id}>
                <time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                <div><strong>{entry.action}</strong><p>{entry.detail}</p><small class="src-line">批次：{batchLabel(entry.batchId)} · 修订 @{entry.revisionId.slice(6, 12)}</small></div>
                <span>{entry.recordIds.length ? `${entry.recordIds.length} 条对象` : '系统'}</span>
              </div>
            ))}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>可对账规则</h3></div></div>
          <div class="rule-row"><span>1</span><p>导入核对包先定位共同祖先：本账无独立修订则快进；只有一边改过的内容自动生效并保留来源批次。</p></div>
          <div class="rule-row"><span>2</span><p>同一候选或字段双方处理不同时，列出两份结论与来源修订；未全部裁决前禁止合并、再次导入与导出。</p></div>
          <div class="rule-row"><span>3</span><p>标题、日期、人物或地点变化后相关候选按现行规则（{RULE_VERSION}）重算；已确认、忽略、合并结论带旧依据回到待复核。</p></div>
          <div class="rule-row"><span>4</span><p>记录、匹配、合并、审计全部带来源批次；旧数据升级补祖先；写入先落暂存，中断后可恢复重试；导出写明祖先与修订来源并附校验和。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 导入 */}
      <Modal.Root bind:show={importOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入：原始数据或核对包接续</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <div class="import-mode-toggle">
            <button class={importMode.value === 'raw' ? 'selected' : ''} onClick$={() => { importMode.value = 'raw'; importError.value = ''; }}>原始记录（JSON / 制表符 / 竖线）</button>
            <button class={importMode.value === 'package' ? 'selected' : ''} onClick$={() => { importMode.value = 'package'; importError.value = ''; }}>核对包（三方接续）</button>
          </div>
          {importMode.value === 'raw' && (
            <div class="import-controls">
              <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
              <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            </div>
          )}
          {importMode.value === 'package' && (
            <p class="modal-description">选择他人导出的核对包：系统校验完整性后按共同祖先预演。快进或单边改动自动接续；双方处理不同的候选/字段会进入「接续裁决」页，全部裁决后才写入双父修订。无版本链的旧包会先补虚拟祖先。</p>
          )}
          <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          {importFileName.value && <div class="file-name">已读取：{importFileName.value}</div>}
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder={importMode.value === 'raw' ? '李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | ...' : '也可把核对包 JSON 直接粘贴到此处'} />
          {importError.value && <div class="import-error">{importError.value}</div>}
          {importInfo.value && <div class="import-info">{importInfo.value}</div>}
          {stage.value && stage.value.conflicts.length > 0 && (
            <div class="stage-mini">
              <p>预演完成：{stage.value.isFastForward ? '可快进' : `共同祖先 ${stage.value.baseAncestryLabel}`}；自动生效 {stage.value.autoChanges.length} 项，冲突 {stage.value.conflicts.length} 处。</p>
              <button class="button small primary" onClick$={() => { importOpen.value = false; panelTab.value = 1; }}>前往裁决页</button>
              <button class="button small ghost" onClick$={cancelStage}>取消预演</button>
            </div>
          )}
          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" disabled={!importRaw.value.trim()} onClick$={submitImport}>{importMode.value === 'raw' ? '导入并重算' : '校验并预演接续'}</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 合并 */}
      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const match = activeMatch.value!;
            const left = recordById(match.leftId)!;
            const right = recordById(match.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段显示两条记录原始值与来源批次。生成的合并记录保留原记录编号与逐字段裁决依据；若相关记录日后改动，该合并会带旧依据回到待复核。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}>
                    <div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div>
                    <label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}<small>{batchLabel(left.provenance[field]?.batchId)}</small></span></label>
                    <label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}<small>{batchLabel(right.provenance[field]?.batchId)}</small></span></label>
                    <button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button>
                  </div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>

      {/* 字段修订 */}
      <Modal.Root bind:show={editOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel edit-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">RECORD EDIT</span><Modal.Title>修订记录（改动后按现行规则重算）</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {editing.id && (
            <>
              <label class="edit-field"><span>标题</span><input class="input" value={editing.title} onInput$={(event) => editing.title = (event.target as HTMLInputElement).value} /></label>
              <label class="edit-field"><span>日期</span><input class="input" value={editing.date} onInput$={(event) => editing.date = (event.target as HTMLInputElement).value} /></label>
              <label class="edit-field"><span>人物（、分隔）</span><input class="input" value={editing.people} onInput$={(event) => editing.people = (event.target as HTMLInputElement).value} /></label>
              <label class="edit-field"><span>地点（、分隔）</span><input class="input" value={editing.places} onInput$={(event) => editing.places = (event.target as HTMLInputElement).value} /></label>
              <p class="modal-description">标题、日期、人物或地点一旦变化，涉及该记录的候选按 {RULE_VERSION} 重算；已确认、忽略与合并结论会带旧依据回到待复核。</p>
              <Modal.Footer class="modal-footer"><button class="button ghost" onClick$={closeEditor}>取消</button><button class="button primary" onClick$={saveEditor}>保存并重算</button></Modal.Footer>
            </>
          )}
        </Modal.Panel>
      </Modal.Root>

      {/* 版本链 */}
      <Modal.Root bind:show={chainOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel chain-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">VERSION CHAIN</span><Modal.Title>可对账版本链与来源批次</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <div class="chain-list">
            {[...state.revisions].reverse().map((revision) => (
              <div class={`chain-node ${revision.id === state.headId ? 'head' : ''} ${revision.parents.length > 1 ? 'junction' : ''}`} key={revision.id}>
                <span class="chain-id">@{revision.id.slice(6, 12)}</span>
                <div>
                  <strong>{revision.message}</strong>
                  <p>{batchLabel(revision.batchId)} · {new Date(revision.at).toLocaleString('zh-CN')}</p>
                  <small>
                    {revision.parents.length ? `父修订：${revision.parents.map((parent) => parent.slice(6, 12)).join(' + ')}` : '根修订（祖先）'}
                    {revision.mergeBase ? ` · 共同祖先 @${revision.mergeBase.slice(6, 12)}` : ''}
                    {revision.incomingHead ? ` · 接续来件头 @${revision.incomingHead.slice(6, 12)}` : ''}
                  </small>
                </div>
                {revision.id === state.headId && <span class="head-tag">当前工作区</span>}
                {state.snapshots[revision.id] && revision.id !== state.headId && history.value.some((item) => item.headId === revision.id) && (
                  <button class="button small ghost" onClick$={() => { checkout(revision.id); chainOpen.value = false; notify('已跳转查看该修订（撤销/重做只影响当前工作区）'); }}>查看</button>
                )}
              </div>
            ))}
          </div>
          <p class="modal-description">双父节点是一次三方接续合并；导出包会写明头修订、共同祖先与祖先内容快照，对方可离线对账后再回并。</p>
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});

// ---- 接续辅助：在合并版本图中定位共同祖先 ----
function findBaseId(
  state: PersistedWorkspace,
  incomingHead: string,
  declaredBase: string | null,
  incomingRevisions: Array<{ id: string; parents: string[] }>
): string | null {
  const all = new Map<string, string[]>();
  [...state.revisions, ...incomingRevisions].forEach((revision) => all.set(revision.id, revision.parents));
  if (all.has(incomingHead) && state.headId) {
    const ancestorsOf = (start: string) => {
      const set = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const id = stack.pop()!;
        (all.get(id) ?? []).forEach((parent) => { if (!set.has(parent)) { set.add(parent); stack.push(parent); } });
      }
      return set;
    };
    const localSet = new Set([state.headId, ...ancestorsOf(state.headId)]);
    if (localSet.has(incomingHead)) return state.headId; // 快进
    const incomingSet = ancestorsOf(incomingHead);
    for (const id of incomingSet) if (localSet.has(id)) return id;
  }
  return declaredBase;
}

function conflictSubjectLabel(conflict: Conflict): string {
  if (conflict.subject === 'record-field') return `记录字段：${conflict.field ? fieldLabel(conflict.field) : ''}`;
  if (conflict.subject === 'record-status') return '记录状态';
  if (conflict.subject === 'match-decision') return '同一候选的不同结论';
  return `合并字段：${conflict.field ? fieldLabel(conflict.field) : ''}`;
}
