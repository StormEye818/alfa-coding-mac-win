/**
 * 移动端 UX 巡检：手机视口逐标签页截图 + 溢出/字号检测。
 * 用法：node ux-sweep-mobile.mjs [host]
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.argv[2] || 'http://localhost:8848/app/?mobile=1';
const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${info}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => document.body.classList.contains('mobile'), { timeout: 10000 });
check('mobile 模式激活', true, 'body.mobile');

const tabs = await page.$$eval('.tabs .tab', (ts) => ts
  .filter((t) => t.dataset.tab && t.offsetParent !== null)   // 跳过隐藏 tab（如 ?dev=1 的待验证）
  .map((t) => t.dataset.tab));
console.log('标签页:', tabs.join(', '));

for (const tab of tabs) {
  await page.evaluate((t) => document.querySelector(`.tabs .tab[data-tab="${t}"]`).click(), tab);
  await new Promise((r) => setTimeout(r, 350));
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - window.innerWidth;
    // 找过小的可点元素（按钮/选项）
    const small = [...document.querySelectorAll('button, select, .opt')].filter((el) => {
      const r2 = el.getBoundingClientRect();
      return r2.height > 0 && r2.height < 30;
    }).length;
    return { overflow, small, title: document.title };
  });
  const ok = m.overflow <= 2 && m.small === 0;
  check(`tab=${tab}`, ok, `横向溢出 ${m.overflow}px · 过小控件 ${m.small} 个`);
  await page.screenshot({ path: `/tmp/ux-${tab}.png` });
}

// 连接 chip 动作单
await page.evaluate(() => window.scrollTo(0, 0));
const chip = await page.$('.conn-chip');
if (chip) {
  await chip.click();
  await new Promise((r) => setTimeout(r, 300));
  const open = await page.evaluate(() => document.querySelector('.conn')?.classList.contains('mobile-open'));
  check('连接动作单展开', !!open, `mobile-open=${open}`);
  // 防复发：展开后不得横向溢出，按钮不得独占一行
  const cm = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const btns = [...document.querySelectorAll('.conn.mobile-open > button')];
    const rows = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)));
    return { overflow, btnRows: rows.size, btnCount: btns.length };
  });
  check('连接区展开无溢出且按钮成行', cm.overflow <= 2 && cm.btnRows <= Math.ceil(cm.btnCount / 2),
    `溢出 ${cm.overflow}px · ${cm.btnCount} 个按钮排成 ${cm.btnRows} 行`);
  await page.screenshot({ path: '/tmp/ux-connsheet.png' });
} else {
  check('连接动作单展开', false, '无 .conn-chip');
}

// 防复发：实时数据页选中模块后不得横向溢出（此前 panel-head 横排被挤出屏）
await page.evaluate((t) => document.querySelector(`.tabs .tab[data-tab="${t}"]`).click(), 'live');
await new Promise((r) => setTimeout(r, 350));
const live = await page.evaluate(() => {
  const sel = document.getElementById('liveModule');
  const opt = [...sel.options].find((o) => o.value);
  if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    picked: opt ? opt.textContent : null,
  };
});
check('实时数据选模块后无溢出', live.overflow <= 2, `选了「${live.picked}」溢出 ${live.overflow}px`);
await page.screenshot({ path: '/tmp/ux-live-picked.png' });

await browser.close();
const fail = results.filter((r) => !r.ok).length;
console.log(`\n===== UX 巡检：${results.length - fail} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
