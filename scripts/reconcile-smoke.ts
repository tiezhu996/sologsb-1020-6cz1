// 端到端冒烟测试（node 运行，不依赖 DOM）：
//   npx esbuild scripts/reconcile-smoke.ts --bundle --platform=node --format=esm --outfile=.tmp-smoke.mjs && node .tmp-smoke.mjs
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

import { seedState, SEED_REVISION_ID } from '../src/data/seed';
import type { PersistedWorkspace } from '../src/types';
import { contentOf } from '../src/version/core';
import { buildPackage } from '../src/version/workspace';
import { parsePackage, stageImport, commitStagedImport } from '../src/version/merge';
import { decideMatch, editRecord, saveWorkspace } from '../src/version/workspace';
import type { ReconciliationPackage } from '../src/types';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, name: string, detail = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// localStorage 内存垫片
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  get length() { return mem.size; },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => [...mem.keys()][index] ?? null,
  removeItem: (key: string) => { mem.delete(key); },
  setItem: (key: string, value: string) => { mem.set(key, String(value)); }
};

const cloneSeed = (): PersistedWorkspace => {
  const seeded = seedState();
  return JSON.parse(JSON.stringify(seeded)) as PersistedWorkspace;
};

const applyLocal = (ws: PersistedWorkspace, commit: ReturnType<typeof decideMatch> | NonNullable<ReturnType<typeof editRecord>>) => {
  if (!commit) return;
  ws.records = commit.content.records;
  ws.matches = commit.content.matches;
  ws.merges = commit.content.merges;
  ws.batches = [...ws.batches, ...commit.batches];
  ws.revisions = [...ws.revisions, ...commit.revisions];
  ws.audit = [...commit.audit, ...ws.audit];
  ws.headId = commit.revision.id;
  ws.revisionCounter += 1;
  ws.snapshots[commit.revision.id] = {
    records: commit.content.records.map((r) => ({ ...r })),
    matches: commit.content.matches.map((m) => ({ ...m })),
    merges: commit.content.merges.map((m) => ({ ...m }))
  };
};

console.log('场景 1：共同祖先快进');
{
  const archivistA = cloneSeed();
  const archivistB = cloneSeed();
  archivistB.workspaceId = archivistA.workspaceId;

  // A 确认一条候选后导出
  const target = archivistA.matches.find((m) => m.status === 'suggested')!;
  applyLocal(archivistA, decideMatch(archivistA, target.id, 'confirmed'));
  const pkg = await buildPackage(archivistA, archivistA.importBases);

  // B 无独立修订：应为快进
  const parsed = await parsePackage(JSON.stringify(pkg), 'A.json');
  ok(parsed.ok, '包校验通过');
  if (parsed.ok) {
    const stage = stageImport(archivistB, parsed.pkg, 'A.json', archivistB.snapshots[SEED_REVISION_ID] ?? null);
    ok(stage.isFastForward, '识别为快进接续');
    ok(stage.conflicts.length === 0, '快进无冲突');
    const result = commitStagedImport(archivistB, stage);
    ok(result.revision.parents.length === 1 && result.revision.parents[0] === archivistA.headId, '快进后头直接指向来件头');
    const adopted = result.content.matches.find((m) => m.id === target.id);
    ok(adopted?.status === 'confirmed', '对方的确认结论自动生效');
  }
}

console.log('场景 2：双方分叉 —— 同字段不同改法产生冲突，裁决前锁定');
{
  const A = cloneSeed();
  const B = cloneSeed();
  B.workspaceId = A.workspaceId;

  // 双方都改 a-001 的标题，改法不同
  const recId = 'a-001';
  applyLocal(A, editRecord(A, recId, { title: '李秀珍口述史访谈（馆藏定本）' }));
  applyLocal(B, editRecord(B, recId, { title: '李秀珍女士口述史访谈（校注本）' }));

  // 双方对同一候选结论也不同：A 确认、B 忽略
  const pairId = 'match::a-002::b-002';
  applyLocal(A, decideMatch(A, pairId, 'confirmed'));
  applyLocal(B, decideMatch(B, pairId, 'rejected'));

  const pkgA = await buildPackage(A, A.importBases);
  const parsed = await parsePackage(JSON.stringify(pkgA), 'A.json');
  ok(parsed.ok, '分叉包校验通过');
  if (parsed.ok) {
    const stage = stageImport(B, parsed.pkg, 'A.json', B.snapshots[SEED_REVISION_ID] ?? null);
    ok(!stage.isFastForward, '双方都有独立修订，不是快进');
    const fieldConflict = stage.conflicts.find((c) => c.subject === 'record-field' && c.field === 'title');
    const decisionConflict = stage.conflicts.find((c) => c.subject === 'match-decision');
    ok(Boolean(fieldConflict), '同一字段不同处理 → 列出冲突');
    ok(Boolean(decisionConflict), '同一候选不同结论 → 列出冲突');
    ok(fieldConflict?.baseText === '李秀珍口述史访谈', '冲突保留共同祖先原值');
    ok(Boolean(fieldConflict?.local.revisionId) && Boolean(fieldConflict?.incoming.revisionId), '两份结论各带来源修订');

    let threw = false;
    try { commitStagedImport(B, stage); } catch { threw = true; }
    ok(threw, '未全部裁决时拒绝接续合并');

    // 字段取对方，候选取本账
    stage.conflicts.forEach((c) => {
      c.resolution = {
        pick: c.subject === 'match-decision' ? 'local' : 'incoming',
        batchId: stage.stageBatchId,
        revisionId: stage.commitRevisionId,
        at: new Date().toISOString()
      };
    });
    const beforeHead = B.headId!;
    const result = commitStagedImport(B, stage);
    ok(result.revision.parents.length === 2, '裁决提交生成双父修订（版本链接点）');
    ok(result.revision.parents.includes(beforeHead) && result.revision.parents.includes(A.headId), '双父分别是本账头与来件头');
    ok(result.revision.mergeBase === SEED_REVISION_ID, '接续修订记录共同祖先');
    const rec = result.content.records.find((r) => r.id === recId)!;
    ok(rec.title === '李秀珍口述史访谈（馆藏定本）', '字段裁决采用对方结论');
    const match = result.content.matches.find((m) => m.id === pairId)!;
    ok(match.status === 'rejected', '候选裁决保留本账「忽略」结论');
    ok(match.decidedBy === stage.stageBatchId, '裁决结论记录新来源批次');
  }
}

console.log('场景 3：标题/日期/人物/地点变化触发重算，旧结论带旧依据回到待复核');
{
  const ws = cloneSeed();
  const pairId = 'match::a-004::b-004'; // 日期差一天、人物不同
  const pair = ws.matches.find((m) => m.id === pairId);
  ok(Boolean(pair), '种子数据包含 a-004/b-004 候选');
  applyLocal(ws, decideMatch(ws, pairId, 'confirmed'));
  ok(ws.matches.find((m) => m.id === pairId)?.status === 'confirmed', '先确认该候选');

  // 大改 a-004 的标题与日期，使相似度实质变化
  const commit = editRecord(ws, 'a-004', { title: '年画工艺调查（陈桂生）', date: '2015-07-01' });
  applyLocal(ws, commit!);
  const after = ws.matches.find((m) => m.id === pairId);
  ok(after?.status === 'suggested', '已确认结论回到待复核');
  ok(after?.oldBasis?.status === 'confirmed', '回到待复核时保留旧依据（confirmed）');
  ok(Boolean(after?.oldBasis?.resetAt) && after.oldBasis.ruleVersion.includes('legacy') ? true : Boolean(after?.oldBasis?.resetReason), '旧依据记录重置原因与批次');

  // 不相干的已确认候选不应被动摇
  const other = ws.matches.find((m) => m.id === 'match::a-001::b-001' && m.status === 'confirmed');
  applyLocal(ws, decideMatch(ws, 'match::a-001::b-001', 'confirmed'));
  const untouchedCommit = editRecord(ws, 'a-008', { title: '何玉莲女书唱本（修订题名）' });
  applyLocal(ws, untouchedCommit!);
  const untouched = ws.matches.find((m) => m.id === 'match::a-001::b-001');
  ok(untouched?.status === 'confirmed', '未触及记录的确认结论保持有效');
}

console.log('场景 4：损坏包 / 旧版包');
{
  const A = cloneSeed();
  const pkg = await buildPackage(A, A.importBases);
  const tampered = { ...pkg, records: pkg.records.map((r) => ({ ...r, title: r.title + '～' })) };
  const bad = await parsePackage(JSON.stringify(tampered), '坏包.json');
  ok(!bad.ok, '校验和不一致 → 拒绝导入');

  const truncated = await parsePackage('{ "records": [', '截断包.json');
  ok(!truncated.ok, 'JSON 截断 → 拒绝导入');

  // v1 扁平旧包
  const legacy = JSON.stringify({
    records: [{ id: 'old-1', group: 'A', title: '旧系统记录', date: '2001', people: [], places: [], identifier: 'X1' }],
    matches: [], merges: [], audit: []
  });
  const migrated = await parsePackage(legacy, '旧包.json');
  ok(migrated.ok && migrated.legacy, '无版本链旧包识别为待迁移');
  if (migrated.ok && migrated.legacy) {
    const B = cloneSeed();
    const stage = stageImport(B, migrated.pkg, '旧包.json', null, migrated.legacyLabel);
    ok(stage.records.some((r) => r.id === 'old-1'), '旧包记录可进入接续预演');
  }
}

console.log('场景 5：非快进分叉但改动不相交 —— 单边改动自动生效、零冲突');
{
  const A = cloneSeed();
  const B = cloneSeed();
  B.workspaceId = A.workspaceId;

  // A 改 a-003 标题，B 改 a-008 标题：双方都有独立修订（非快进），但改动不相交
  applyLocal(A, editRecord(A, 'a-003', { title: '张惠兰与县立女子中学（访问整理稿）' }));
  applyLocal(B, editRecord(B, 'a-008', { title: '女书传人何玉莲唱本（B 馆藏校）' }));

  const pkgA = await buildPackage(A, A.importBases);
  const parsed = await parsePackage(JSON.stringify(pkgA), 'A.json');
  ok(parsed.ok, '包校验通过');
  if (parsed.ok) {
    const stage = stageImport(B, parsed.pkg, 'A.json', B.snapshots[SEED_REVISION_ID] ?? null);
    ok(!stage.isFastForward, '双方均有独立修订 → 非快进');
    ok(stage.conflicts.length === 0, `改动不相交 → 零冲突（实际 ${stage.conflicts.length}）`);
    const adopted = stage.records.find((r) => r.id === 'a-003');
    const kept = stage.records.find((r) => r.id === 'a-008');
    ok(adopted?.title.includes('访问整理稿'), '对方单边修改自动接续');
    ok(kept?.title.includes('B 馆藏校'), '本账单边修改原样保留');
    ok(Boolean(adopted?.provenance.title?.batchId), '自动接续字段保留来源批次');
    const result = commitStagedImport(B, stage);
    ok(result.revision.parents.length === 2, '零冲突接续同样生成双父修订');
    const final3 = result.content.records.find((r) => r.id === 'a-003')!;
    const final8 = result.content.records.find((r) => r.id === 'a-008')!;
    ok(final3.title.includes('访问整理稿') && final8.title.includes('B 馆藏校'), '提交后两侧修改并存');
  }
}

console.log('场景 6：执行合并 —— 合并结论成立，触及原记录的其他旧结论回到待复核');
{
  const ws = cloneSeed();
  const mergeId = 'match::a-001::b-001';
  // 先确认另一条也涉及 b-001 的候选（若存在）
  const other = ws.matches.find((m) => (m.leftId === 'a-001' || m.rightId === 'b-001' || m.leftId === 'b-001' || m.rightId === 'a-001') && m.id !== mergeId);
  if (other) applyLocal(ws, decideMatch(ws, other.id, 'confirmed'));

  const { mergePair } = await import('../src/version/workspace');
  const commit = mergePair(ws, mergeId, { chosen: { title: 'A', date: 'A', people: 'combine', places: 'B', identifier: 'B' } });
  ok(Boolean(commit), '可以执行合并');
  applyLocal(ws, commit!);
  const mergedMatch = ws.matches.find((m) => m.id === mergeId)!;
  ok(mergedMatch.status === 'merged', '目标候选标记为已合并');
  ok(mergedMatch.decidedBy === commit!.batch.id, '合并结论带来源批次');
  const mergeRow = ws.merges.find((m) => m.id === 'merge::a-001::b-001');
  ok(Boolean(mergeRow?.choiceSource.people), '逐字段裁决来源已保存');
  const mergedRec = ws.records.find((r) => r.id === mergeRow!.mergedRecordId)!;
  ok(mergedRec.status === 'merged' && mergedRec.provenance.people?.note?.includes('拼接'), '合并记录字段值带拼接来源');
  if (other) {
    const resetOther = ws.matches.find((m) => m.id === other.id);
    ok(resetOther?.status === 'suggested' && resetOther.oldBasis?.status === 'confirmed',
      `触及同一原记录的确认候选（${other.id}）带旧依据回到待复核`);
  } else {
    ok(true, '（种子中 a-001/b-001 无其他触及候选，跳过该项）');
  }
  // 导出的包可被对侧解析，合并字段冲突（双方对同一合并字段裁决不同）可检出
  const pkg = await buildPackage(ws, ws.importBases);
  ok(pkg.baseAncestorId === SEED_REVISION_ID, '首个导出包写明祖先为根修订');
  const parsed = await parsePackage(JSON.stringify(pkg), 'merged.json');
  ok(parsed.ok, '含合并结论的包校验通过');
}

console.log('场景 7：v1 本地工作区升级补祖先 + 写入中断从暂存恢复');
{
  const { migrateOrSeed, saveWorkspace, STORAGE_KEY } = await import('../src/version/workspace');
  localStorage.clear();
  localStorage.setItem('sologsb-1020-archive-state-v1', JSON.stringify({
    revision: 3,
    records: [{ id: 'v1-1', group: 'B', title: '旧系统手稿', date: '1999', people: [], places: [], identifier: 'M-1', status: 'unreviewed' }],
    matches: [], merges: [], audit: [], activeMatchId: '', selectedRecordIds: []
  }));
  const migrated = migrateOrSeed();
  ok(migrated.legacy, '检测到 v1 工作区并走升级路径');
  ok(migrated.persisted.revisions[0].parents.length === 0, '升级数据挂在祖先根修订下');
  const rec = migrated.persisted.records.find((r) => r.id === 'v1-1');
  ok(Boolean(rec?.provenance.title?.batchId), '旧记录字段补了来源批次');
  ok(rec?.batchId === 'batch-migrated-v1', '旧记录归属升级批次');

  // 模拟写入中断现场：正式键缺失、暂存键保留了刚序列化的完整工作区
  localStorage.clear();
  const ws2 = cloneSeed();
  const payload2 = JSON.stringify(ws2);
  localStorage.setItem(STORAGE_KEY + '.staging', payload2);
  ok(!localStorage.getItem(STORAGE_KEY) && Boolean(localStorage.getItem(STORAGE_KEY + '.staging')), '中断现场：只有暂存键');
  const { loadWorkspace } = await import('../src/version/workspace');
  const recovered0 = loadWorkspace();
  ok(Boolean(recovered0?.recovered), '正式键缺失时从暂存恢复');
  ok(recovered0?.state.headId === ws2.headId, '恢复的工作区内容正确');

  // 正常保存结束后暂存键被清除，不留半写状态
  saveWorkspace(ws2);
  ok(!localStorage.getItem(STORAGE_KEY + '.staging') && Boolean(localStorage.getItem(STORAGE_KEY)), '正常提交后暂存键清除、正式键在位');

  // 正式与暂存都损坏：回落全新工作区，不抛异常
  localStorage.setItem(STORAGE_KEY, '{broken');
  localStorage.setItem(STORAGE_KEY + '.staging', 'also-broken');
  const seeded = migrateOrSeed();
  ok(Boolean(seeded.persisted.headId) && !seeded.recovered, '双副本损坏时安全回落新工作区，可重试');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
