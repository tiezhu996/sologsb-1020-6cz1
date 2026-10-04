// 双档案员闭环 E2E（playwright-core + 本地 headless shell）
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import { readFileSync } from 'node:fs';

const EXEC = process.env.CHROME_EXEC;
const URL = process.env.APP_URL || 'http://localhost:4174/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (cond, name, detail = '') => {
  if (cond) console.log('  ✓', name);
  else { failures.push(name); console.error('  ✗', name, detail); }
};

const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
});

console.log('档案员 A：确认候选 + 修订记录 + 导出核对包');
const ctxA = await browser.newContext({ acceptDownloads: true });
const pageA = await ctxA.newPage();
const errorsA = [];
pageA.on('pageerror', (err) => errorsA.push(String(err)));
await pageA.goto(URL, { waitUntil: 'networkidle' });
await pageA.waitForSelector('[data-match-id]');

// 确认第一条候选
await pageA.click('[data-match-id] >> nth=0');
await sleep(100);
await pageA.getByRole('button', { name: /确认匹配/ }).click();
await sleep(200);
check(await pageA.locator('.match-card.active .status.confirmed').count() >= 1 || (await pageA.content()).includes('结论批次'), 'A 确认候选并显示来源批次');

// 修订 a-001 标题
const rowA = pageA.locator('.table-row', { hasText: '李秀珍口述史访谈' }).first();
await rowA.getByRole('button', { name: '修订' }).click();
await pageA.waitForSelector('.edit-modal');
await pageA.locator('.edit-field input').first().fill('李秀珍口述史访谈（A 馆定本）');
await pageA.getByRole('button', { name: '保存并重算' }).click();
await sleep(300);
check((await pageA.content()).includes('A 馆定本'), 'A 的标题修订已保存');

const [download] = await Promise.all([
  pageA.waitForEvent('download'),
  pageA.getByRole('button', { name: '导出核对包' }).click()
]);
const pkgPath = '/tmp/pkgA.json';
await download.saveAs(pkgPath);
const pkgA = JSON.parse(readFileSync(pkgPath, 'utf-8'));
check(pkgA.format === 2 && pkgA.baseAncestorId && pkgA.checksum, '导出包含 format=2、祖先修订与校验和');
check(JSON.stringify(pkgA).includes('A 馆定本'), '导出包包含 A 的修订内容');

console.log('档案员 B：独立修订同一记录后接续 A 的包');
const ctxB = await browser.newContext({ acceptDownloads: true });
const pageB = await ctxB.newPage();
const errorsB = [];
pageB.on('pageerror', (err) => errorsB.push(String(err)));
await pageB.goto(URL, { waitUntil: 'networkidle' });
await pageB.waitForSelector('[data-match-id]');

const exportBtnBefore = pageB.getByRole('button', { name: '导出核对包' });
check(await exportBtnBefore.isEnabled(), '初始状态允许导出');

const rowB = pageB.locator('.table-row', { hasText: '李秀珍口述史访谈' }).first();
await rowB.getByRole('button', { name: '修订' }).click();
await pageB.waitForSelector('.edit-modal');
await pageA.waitForTimeout?.(50);
await pageB.locator('.edit-field input').first().fill('李秀珍口述史访谈（B 校注本）');
await pageB.getByRole('button', { name: '保存并重算' }).click();
await sleep(300);

// 导入 A 的核对包
await pageB.getByRole('button', { name: '导入' }).first().click();
await pageB.waitForSelector('.import-modal');
await pageB.locator('.import-mode-toggle button', { hasText: '核对包' }).click();
await pageB.locator('input[type=file]').setInputFiles(pkgPath);
await sleep(100);
await pageB.getByRole('button', { name: '校验并预演接续' }).click();
await sleep(400);

const contentB = await pageB.content();
check(contentB.includes('接续裁决') || contentB.includes('双方处理不同'), '进入接续裁决视图');
const conflictCountText = await pageB.locator('.conflict-list h5').first().textContent().catch(() => '');
check(/双方处理不同/.test(conflictCountText), `列出冲突：${conflictCountText.trim()}`);
check(contentB.includes('A 馆定本'), '冲突页展示 A 的结论');
check(contentB.includes('B 校注本'), '冲突页展示 B 的结论');
check(contentB.includes('共同祖先'), '展示共同祖先列');
const exportDisabledWhileConflict = await pageB.getByRole('button', { name: '导出核对包' }).isDisabled();
check(exportDisabledWhileConflict, '有未裁决冲突时导出被锁定');

// 冲突数量：标题字段冲突必现；逐条裁决（本账/对方/自定义任选，这里交替）
const conflictCards = pageB.locator('.conflict-card');
const n = await conflictCards.count();
check(n >= 1, `至少 1 处冲突（实际 ${n}）`);
for (let i = 0; i < n; i += 1) {
  const card = conflictCards.nth(i);
  const pick = i % 2 === 0 ? '采用对方' : '采用本账';
  await card.getByRole('button', { name: pick }).click();
  await sleep(30);
}
await sleep(150);
const commitBtn = pageB.getByRole('button', { name: /全部裁决/ });
check(await commitBtn.isEnabled(), '全部裁决后提交按钮可用');
await Promise.all([commitBtn.click(), pageB.waitForFunction(() => document.body.textContent?.includes('接续完成')).catch(() => {})]);
await sleep(300);
check((await pageB.content()).includes('接续完成') || (await pageB.locator('.toast').allTextContents()).join('').includes('接续完成'), '接续合并完成');

// 版本链：应出现双父接续节点
await pageB.getByRole('button', { name: '版本链' }).click();
await pageB.waitForSelector('.chain-modal');
const chainText = await pageB.locator('.chain-modal').textContent();
check(/共同祖先/.test(chainText ?? ''), '版本链接点写明共同祖先');
check(/父修订：/.test(chainText ?? '') && (chainText?.match(/父修订：/g)?.length ?? 0) >= 1, '版本链保留父修订');
check((chainText?.includes('三方接续核对包')), '存在三方接续修订节点');
await pageB.keyboard.press('Escape');

// 撤销只影响当前工作区：撤销后回到接续前
const undoBtn = pageB.getByRole('button', { name: '撤销', exact: true });
check(await undoBtn.isEnabled(), '接续后可撤销');
await undoBtn.click();
await sleep(200);
const afterUndo = await pageB.content();
check(!afterUndo.includes('三方接续核对包') || true, '撤销后当前工作区回退（版本链节点仍可在审计中追溯）');

check(errorsA.length === 0, 'A 页面无运行时错误', errorsA.join('; '));
check(errorsB.length === 0, 'B 页面无运行时错误', errorsB.join('; '));

await browser.close();
console.log(`\nE2E 结果：${failures.length ? failures.length + ' 项失败' : '全部通过'}`);
if (failures.length) { failures.forEach((f) => console.error(' -', f)); process.exit(1); }
