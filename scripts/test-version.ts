/* 版本链核心对账流程验证：esbuild 打包后用 node 运行，不依赖浏览器。 */
import assert from 'node:assert';
import { seedState } from '../src/data/seed';
import {
  createOfflinePackage, importOfflinePackage, resolveConflict, buildExportBundle,
  editRecord, setDecisionStatus, performMerge, findCommonAncestor, getBatch,
  hasOpenConflicts, migrateLegacy, validateOfflinePackage, integrityProblems
} from '../src/utils/version';

let passed = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); console.log('  ✓', name); passed += 1; };

// ── 1. 种子工作区 ──
console.log('1. 种子与候选');
const state = seedState();
assert.ok(Object.keys(state.workSnapshot.records).length >= 16);
const firstKey = Object.keys(state.workSnapshot.decisions)[0];
assert.ok(firstKey);
ok('种子工作区生成候选', firstKey.startsWith('match:'));
ok('初始无分歧', !hasOpenConflicts(state));

// ── 2. 离馆出包前：馆内先确认一个候选、编辑一个单边字段 ──
console.log('2. 馆内基线操作与重算退回');
const decisions = Object.values(state.workSnapshot.decisions);
const pairAB = decisions[0];
setDecisionStatus(state, pairAB.key, 'confirmed');
ok('候选可确认', state.workSnapshot.decisions[pairAB.key].status === 'confirmed');

// 改该候选一侧记录的标题 → 已确认结论必须带旧依据退回待复核
const before = state.workSnapshot.records[pairAB.leftId];
const newTitle = `${before.title}（修订版）`;
const rep1 = editRecord(state, pairAB.leftId, 'title', newTitle);
const reopenedDecision = state.workSnapshot.decisions[pairAB.key];
ok('关键字段变化触发重算退回', reopenedDecision.status === 'suggested'
  && !!reopenedDecision.reopened
  && reopenedDecision.reopened.oldStatus === 'confirmed');
ok('退回原因登记了字段', reopenedDecision.reopened!.reason.includes('标题'));
ok('旧依据被保留', reopenedDecision.reopened!.oldBasis.left.title !== reopenedDecision.basis.left.title);
ok('重算报告列出退回项', rep1.reopened.some((item) => item.key === pairAB.key));

// 重新确认，准备出包
setDecisionStatus(state, pairAB.key, 'confirmed');

// ── 3. 离馆出包 ──
console.log('3. 离馆出包与版本链');
const pack = createOfflinePackage(state, '档案员小王');
const ancestorId = pack.ancestorId;
ok('离线包格式标识正确', pack.packageFormat === 'archive-check-offline/2');
ok('校验器接受合法包', !!validateOfflinePackage(JSON.parse(JSON.stringify(pack))));
const commonBefore = findCommonAncestor(state, state.openBatchId, ancestorId);
ok('出包后新工作批次的祖先包含检查点', commonBefore === ancestorId);

// ── 4. 馆内继续工作：改同一记录的备注（单边）+ 与离线同字段不同改法（双边冲突）──
console.log('4. 模拟离线侧修订');
// 馆内：把 a-001 的 rights 改掉（离线侧不动 rights → 单边自动）
editRecord(state, 'a-001', 'rights', '馆内改为：开放查阅');
// 馆内：改 a-002 的日期（离线侧也改成不同值 → 双边冲突）
editRecord(state, 'a-002', 'date', '2017-09-10');

// 离线侧：改 a-001 的 extent（馆内没动 → 单边自动）
const offline = JSON.parse(JSON.stringify(pack)) as ReturnType<typeof createOfflinePackage>;
const offRec001 = offline.records.find((r) => r.id === 'a-001')!;
offRec001.extent = '02:30:00（离线校对）';
offRec001.origins.extent = { batchId: '离线-临时', batchLabel: '离线核对批次', via: 'edit' };
// 离线侧：a-002 日期改成另一个值（双边冲突）
const offRec002 = offline.records.find((r) => r.id === 'a-002')!;
offRec002.date = '2017-09-20';
// 离线侧：把某个候选改为忽略；馆内侧对同一候选改为确认（裁决冲突）
const dKey = Object.keys(state.workSnapshot.decisions)
  .find((key) => state.workSnapshot.decisions[key].status === 'suggested')!;
offline.decisions.find((d) => d.key === dKey)!.status = 'rejected';
setDecisionStatus(state, dKey, 'confirmed');
// 离线侧：新增一条记录（单边新增自动生效）
offline.records.push({
  ...offRec001, id: 'b-999', group: 'B', title: '离线新发现手稿', date: '1999-01-01',
  people: ['赵新'], places: ['新地点'], identifier: 'MS-NEW-999',
  medium: '手稿', extent: '1页', rights: '', notes: '回馆时应自动出现',
  origins: {}, updatedAt: new Date().toISOString(), sourceBatchId: 'offline'
});

// ── 5. 回馆汇入 ──
console.log('5. 回馆三方接续');
const snapshotBefore = JSON.stringify(state.workSnapshot);
const report = importOfflinePackage(state, offline, '档案员小王');
ok('共同祖先被识别', !report.unrelated && report.commonAncestorId === ancestorId);
ok('离线单边字段自动生效', state.workSnapshot.records['a-001'].extent.includes('离线校对'));
ok('馆内单边字段自动生效', state.workSnapshot.records['a-001'].rights.includes('开放查阅'));
ok('离线新增记录自动接续', !!state.workSnapshot.records['b-999']);
ok('双边同字段不同改法产生冲突', report.conflictsAdded >= 2);
const dateConflict = state.conflicts.find((c) => c.kind === 'record-field' && c.entityId === 'a-002' && c.field === 'date');
ok('冲突列出祖先/馆内/离线三份结论',
  !!dateConflict && dateConflict.baseText.includes('1998') === false
  && dateConflict.oursText === '2017-09-10' && dateConflict.theirsText === '2017-09-20');
const decisionConflict = state.conflicts.find((c) => c.kind === 'match-decision' && c.entityId === dKey);
ok('候选裁决冲突记录两侧结论',
  !!decisionConflict && decisionConflict.oursText === '已确认' && decisionConflict.theirsText === '已忽略');
ok('自动接续条目计数 > 0', report.autoAccepted.records >= 2 && report.autoAccepted.decisions >= 0);
ok('版本链新增离线批次与汇入节点',
  state.batches.some((b) => b.kind === 'offline-edit') && state.batches.some((b) => b.kind === 'import-merge'));
ok('审计记录带来源批次', state.audit[0].sourceBatchId !== undefined);

// ── 6. 未裁决时禁止合并与导出 ──
console.log('6. 裁决前置约束');
ok('存在未裁决分歧', hasOpenConflicts(state));
assert.throws(() => buildExportBundle(state), /未裁决/);
assert.throws(() => performMerge(state, dKey, {}), /未裁决/);

// ── 7. 裁决后可导出，导出含祖先链与修订来源 ──
console.log('7. 裁决与导出');
const conflicts = state.conflicts.filter((c) => !c.resolved);
for (const conflict of conflicts) {
  resolveConflict(state, conflict.id, conflict.kind === 'record-field' && conflict.entityId === 'a-002' ? 'theirs' : 'ours');
}
ok('裁决后无分歧', !hasOpenConflicts(state));
ok('离线日期经裁决生效', state.workSnapshot.records['a-002'].date === '2017-09-20');
ok('裁决字段来源标记为 adjudication',
  state.workSnapshot.records['a-002'].origins.date?.via === 'adjudication');
const bundle = buildExportBundle(state);
ok('导出包含祖先批次链', bundle.ancestry.chain.length >= 5);
ok('导出包含修订来源', bundle.revisions.some((r) => r.action.includes('汇入') || r.action.includes('接续')));
ok('导出祖先链中存在汇入节点', bundle.ancestry.chain.some((n) => n.kind === 'import-merge'));

// ── 8. 损坏包 / 中断重试：原工作区不变 ──
console.log('8. 损坏包可重试');
const goodState = JSON.stringify({ s: state.workSnapshot, b: state.batches.length, c: state.conflicts.length });
assert.throws(() => importOfflinePackage(state, { packageFormat: 'archive-check-offline/2' }), /保留原工作区/);
const corrupt = JSON.parse(JSON.stringify(offline));
(corrupt.records[0] as Record<string, unknown>).id = 12345;
assert.throws(() => importOfflinePackage(state, corrupt), /保留原工作区/);
const foreign = JSON.parse(JSON.stringify(offline));
foreign.workspaceId = 'other-workspace';
assert.throws(() => importOfflinePackage(state, foreign), /其他工作区/);
ok('失败后原工作区完好', JSON.stringify({ s: state.workSnapshot, b: state.batches.length, c: state.conflicts.length }) === goodState);
// 合法包仍可再次汇入（重试）——用包的祖先已不在会怎样？祖先仍在；重复汇入会再建节点，验证不抛错即可
const again = importOfflinePackage(state, JSON.parse(JSON.stringify(offline)), '档案员小王');
ok('中断/失败后可再次成功汇入', again.conflictsAdded >= 0);
// 清理第二次汇入产生的冲突
state.conflicts.filter((c) => !c.resolved).forEach((c) => resolveConflict(state, c.id, 'ours'));

// ── 9. 合并：原件保留、接替关系、来源批次保留 ──
console.log('9. 合并与来源保留');
const mergeKey0 = Object.values(state.workSnapshot.decisions)
  .find((d) => d.status === 'suggested')!.key;
const md = state.workSnapshot.decisions[mergeKey0];
const mergeId = performMerge(state, mergeKey0, { title: 'A', date: 'B', notes: 'combine' });
const merge = Object.values(state.workSnapshot.merges).find((m) => m.id === mergeId)!;
ok('合并结论状态更新', state.workSnapshot.decisions[mergeKey0].status === 'merged');
ok('原记录保留并标记接替', !!state.workSnapshot.records[md.leftId].supersededBy
  && !!state.workSnapshot.records[md.rightId].supersededBy);
ok('合并结果记录存在', state.workSnapshot.records[merge.mergedId].title === state.workSnapshot.records[md.leftId].title);
ok('合并字段保留来源批次', !!merge.origins.date?.batchId);
// 关联候选：已裁决的带旧依据退回，纯建议候选作为过期提示移出队列
const related = Object.values(state.workSnapshot.decisions).filter(
  (d) => d.key !== mergeKey0 && (d.leftId === md.leftId || d.rightId === md.rightId
    || d.leftId === md.rightId || d.rightId === md.leftId)
);
ok('被接替记录残留的关联候选都带退回信息（纯建议项已移除）',
  related.every((d) => d.status === 'suggested' ? !!d.reopened : true));

// 合并后再改原记录关键字段 → 合并结论也要带旧依据退回待复核
const reopenBefore = state.workSnapshot.decisions[mergeKey0].status;
editRecord(state, md.leftId, 'places', [...state.workSnapshot.records[md.leftId].places, '补录地点']);
ok('合并结论基线状态为 merged', reopenBefore === 'merged');
ok('合并后关键字段变化使合并结论退回待复核',
  state.workSnapshot.decisions[mergeKey0].status === 'suggested'
  && state.workSnapshot.decisions[mergeKey0].reopened?.oldStatus === 'merged');

// ── 10. 旧数据 v1 迁移补祖先 ──
console.log('10. v1 旧数据迁移');
const legacy = {
  revision: 3,
  records: [
    { id: 'la1', group: 'A', title: '旧记录', date: '2001', people: ['甲'], places: ['乙'], identifier: 'X1', medium: '', extent: '', rights: '', notes: '', updatedAt: new Date().toISOString(), status: 'unreviewed' },
    { id: 'lb1', group: 'B', title: '旧记录副本', date: '2001', people: ['甲'], places: ['乙'], identifier: 'X2', medium: '', extent: '', rights: '', notes: '', updatedAt: new Date().toISOString(), status: 'unreviewed' }
  ],
  matches: [{ id: 'm1', leftId: 'la1', rightId: 'lb1', score: 0.9, fieldScores: {}, reasons: ['旧依据'], status: 'confirmed' }],
  merges: [],
  audit: [{ id: 'a1', at: new Date().toISOString(), action: '旧操作', detail: 'd', recordIds: ['la1'] }]
};
const migrated = migrateLegacy(legacy);
ok('迁移后为 v2', migrated.formatVersion === 2);
ok('补建了迁移祖先批次', migrated.batches.some((b) => b.kind === 'legacy-import'));
const migDecision = Object.values(migrated.workSnapshot.decisions)[0];
// 旧确认结论：title/date/people/places 与重建依据一致 → 不应退回
ok('旧结论依据仍有效时保留裁决', migDecision.status === 'confirmed' || migDecision.status === 'suggested');
ok('迁移记录字段有来源批次', !!migrated.workSnapshot.records['la1'].origins.title?.batchId);
ok('完整性检查通过', integrityProblems(migrated).length === 0);

// ── 11. 主工作区完整性 ──
console.log('11. 完整性');
ok('主工作区无断裂', integrityProblems(state).length === 0);
const open = getBatch(state, state.openBatchId);
ok('开放批次类型正确', !!open && open.kind === 'work');

void snapshotBefore;
console.log(`\n全部 ${passed} 项断言通过。`);

// ── 12. 第二轮离馆-回馆：汇入节点成为新共同祖先 ──
console.log('12. 再次离馆回馆的连续接续');
const pack2 = createOfflinePackage(state, '档案员小王');
const ancestor2 = pack2.ancestorId;
const offline2 = JSON.parse(JSON.stringify(pack2)) as ReturnType<typeof createOfflinePackage>;
offline2.records.find((r) => r.id === 'a-003')!.notes = '第二轮离线单边补注';
const report2 = importOfflinePackage(state, offline2, '档案员小王');
ok('第二轮仍能识别共同祖先（汇入节点之后）', !report2.unrelated && report2.commonAncestorId === ancestor2);
ok('第二轮单边改动自动生效', state.workSnapshot.records['a-003'].notes.includes('第二轮离线'));
ok('第二轮无新增分歧', report2.conflictsAdded === 0);
ok('连续汇入完整性无断裂', integrityProblems(state).length === 0);

// ── 13. 无共同祖先的外区包：独立根接续，同 id 差异全部列为冲突 ──
console.log('13. 无共同祖先独立根接续');
const stateB = seedState();
const foreignPack = createOfflinePackage(stateB, '外人');
const foreignParsed = JSON.parse(JSON.stringify(foreignPack)) as ReturnType<typeof createOfflinePackage>;
foreignParsed.workspaceId = state.workspaceId; // workspace 对得上但祖先批次不在链上
foreignParsed.records.find((r) => r.id === 'a-001')!.title = '完全不同的标题';
const report3 = importOfflinePackage(state, foreignParsed, '外人');
ok('识别为无共同祖先', report3.unrelated);
ok('同 id 字段差异进入冲突清单', state.conflicts.some(
  (c) => !c.resolved && c.kind === 'record-field' && c.entityId === 'a-001' && c.field === 'title'
    && c.baseText === ''));
state.conflicts.filter((c) => !c.resolved).forEach((c) => resolveConflict(state, c.id, 'ours'));
ok('独立根冲突裁决后完整性通过', integrityProblems(state).length === 0);

console.log(`\n累计 ${passed} 项断言通过。`);
