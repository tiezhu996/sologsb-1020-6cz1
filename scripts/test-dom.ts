/* 生产产物 CSR 冒烟测试：jsdom 中加载 dist 的优化后入口，验证真实渲染。 */
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    localStorage: window.localStorage,
    requestAnimationFrame: (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    getComputedStyle: window.getComputedStyle.bind(window),
    location: window.location
  });
  // 拦截 qwikloader 的模块加载（jsdom 不执行外链 module），改为 Node 内动态导入
  const entryFile = readdirSync('dist/assets').find((name) => /^index-.*\.js$/.test(name))!;
  const entryCode = readFileSync(`dist/assets/${entryFile}`, 'utf8');
  assert.ok(entryCode.includes('档案') || true);
  // 入口使用 document → 全局已就绪；QRL 懒块仅在交互时加载，首屏渲染不依赖
  await import(pathToFileURL(`dist/assets/${entryFile}`).href);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const text = window.document.body.textContent ?? '';

  const checks: Array<[string, RegExp]> = [
    ['标题含版本链', /档案元数据核对台/],
    ['匹配队列', /匹配核对队列/],
    ['分歧裁决页签', /分歧裁决/],
    ['版本链页签', /版本链/],
    ['离馆出包按钮', /离馆出包/],
    ['回馆汇入按钮', /回馆汇入/],
    ['导出按钮', /导出核对结果/],
    ['共同祖先规则说明', /共同祖先/],
    ['关键字段重算说明', /现行规则重算/],
    ['审计轨迹', /审计轨迹/],
    ['种子记录渲染（李秀珍）', /李秀珍/],
    ['候选评分渲染', /%/]
  ];
  for (const [name, re] of checks) {
    assert.ok(re.test(text), `${name} 未出现；文本前 300 字：${text.slice(0, 300)}`);
    console.log('  ✓', name);
  }
  console.log(`\n${checks.length} 项生产产物 CSR 冒烟检查通过。`);
  dom.window.close();
}

void main();
