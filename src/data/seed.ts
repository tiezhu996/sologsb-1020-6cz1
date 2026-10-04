import type { RecordGroup, RecordSnap, WorkspaceState } from '../types';
import { createWorkspace, makeRecordSnap } from '../utils/version';

interface SeedRow {
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

const rows: SeedRow[] = [
  { id: 'a-001', group: 'A', title: '李秀珍口述史访谈', date: '2019-04-12', people: ['李秀珍', '周明远'], places: ['临河县', '河口村'], identifier: 'OH-LXZ-2019-01', medium: '数字录音', extent: '02:14:38', rights: '研究者授权', notes: '访谈共三个音频文件' },
  { id: 'b-001', group: 'B', title: '李秀珍女士口述访谈记录', date: '2019-04-12', people: ['李秀珍', '周明远'], places: ['临河县', '河口村'], identifier: 'OH-2019-001', medium: '数字音频', extent: '2小时14分', rights: '仅限研究使用', notes: '附件含访谈提纲和照片' },
  { id: 'a-002', group: 'A', title: '渡口船工王德海回忆', date: '2017-09-03', people: ['王德海'], places: ['白沙镇', '老渡口'], identifier: 'MS-WDH-17', medium: '手稿扫描', extent: '18页', rights: '家属授权', notes: '第三页有手写补记' },
  { id: 'b-002', group: 'B', title: '王德海口述：渡口与船工生活', date: '2017-09-03', people: ['王德海'], places: ['白沙镇'], identifier: 'OH-2017-088', medium: '录音', extent: '01:42:10', rights: '家属授权', notes: '原编号与手稿组共用一个采访批次' },
  { id: 'a-003', group: 'A', title: '张惠兰与县立女子中学', date: '2020-11-08', people: ['张惠兰'], places: ['临河县'], identifier: 'OH-ZHL-2020-04', medium: '数字录音', extent: '56分钟', rights: '未签授权文件', notes: '需补充授权确认' },
  { id: 'b-003', group: 'B', title: '张惠兰访谈', date: '2020-11-08', people: ['张惠兰'], places: ['临河县', '县立女子中学'], identifier: 'OH-2020-004', medium: '数字录音', extent: '00:56:22', rights: '待补授权', notes: '内容涉及女子中学创建' },
  { id: 'a-004', group: 'A', title: '木版年画艺人陈桂生', date: '2015-06-21', people: ['陈桂生'], places: ['桃花乡'], identifier: 'CRAFT-CGS-2015', medium: 'DV录像', extent: '86分钟', rights: 'CC BY-NC 4.0', notes: '记录了套色过程' },
  { id: 'b-004', group: 'B', title: '陈桂生师傅年画工艺访谈', date: '2015-06-22', people: ['陈桂生', '许小琴'], places: ['桃花乡'], identifier: 'CRAFT-2015-06', medium: '视频', extent: '01:26:04', rights: 'CC BY-NC 4.0', notes: '拍摄日期可能相差一天' },
  { id: 'a-005', group: 'A', title: '赤水河盐运档案访谈（上）', date: '2018-02-15', people: ['杨启富'], places: ['赤水镇'], identifier: 'OH-YQF-2018-A', medium: '数字录音', extent: '01:10:00', rights: '研究者授权', notes: '' },
  { id: 'b-005', group: 'B', title: '杨启富谈赤水河盐运', date: '2018-02-15', people: ['杨启富'], places: ['赤水镇', '盐仓'], identifier: 'OH-2018-050', medium: '数字录音', extent: '01:10:18', rights: '研究者授权', notes: '元数据人员补充了地点“盐仓”' },
  { id: 'a-006', group: 'A', title: '民间中医刘绍安手稿', date: '1998-12-01', people: ['刘绍安'], places: ['安平村'], identifier: 'MS-LSA-1998', medium: '纸质手稿', extent: '34页', rights: '公版', notes: '作者去世已满五十年' },
  { id: 'b-006', group: 'B', title: '刘绍安医案抄本', date: '1998-11-30', people: ['刘绍安'], places: ['安平村'], identifier: 'MANU-LSA-98', medium: '扫描件', extent: '33页', rights: '公版', notes: '日期按抄本落款录为11月30日' },
  { id: 'a-007', group: 'A', title: '铁路建设者赵春生采访', date: '2021-07-09', people: ['赵春生'], places: ['北岭市'], identifier: 'OH-ZCS-2021', medium: '数字录音', extent: '01:03:42', rights: '研究者授权', notes: '' },
  { id: 'b-007', group: 'B', title: '赵春生同志口述', date: '2021-07-09', people: ['赵春生'], places: ['北岭市', '青石岭'], identifier: 'OH-2021-071', medium: '数字录音', extent: '01:04:01', rights: '研究者授权', notes: '包含铁路工地地点' },
  { id: 'a-008', group: 'A', title: '女书传人何玉莲唱本', date: '2013-05-18', people: ['何玉莲'], places: ['上江乡'], identifier: 'MS-HYL-2013', medium: '手稿影像', extent: '42页', rights: '需联系后人', notes: '缺第12页' },
  { id: 'b-008', group: 'B', title: '何玉莲女书唱本扫描件', date: '2013-05-18', people: ['何玉莲'], places: ['上江乡'], identifier: 'MANU-HYL-13', medium: '扫描件', extent: '41页', rights: '联系人待定', notes: '扫描时第12页缺失' }
];

/**
 * 种子工作区：所有记录归属同一个根批次（候选由现行规则生成）。
 * 记录上的字段来源由 createWorkspace 统一归一到生成的根批次。
 */
export const seedState = (): WorkspaceState => {
  const rootLabel = '初始批次 · 示例口述史与手稿';
  const records: RecordSnap[] = rows.map((row) => makeRecordSnap(row, 'pending-root', rootLabel, 'seed'));
  return createWorkspace(rootLabel, records);
};
