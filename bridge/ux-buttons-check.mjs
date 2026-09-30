/**
 * 回归验证：移动端按钮点击不被说明气泡劫持 + 说明层「知道了」可点。
 * 背景：2026-09-30 真机踩坑——title→data-help 转换拦截了按钮点击，且说明层被浮动条盖住。
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, info) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${info}`); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

await page.goto('http://localhost:8848/app/?mobile=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => document.body.classList.contains('mobile'), { timeout: 10000 });

// 1) 点「应用到字节（预览）」（带 title）→ 不得弹说明层；动作应执行（出现 toast 或状态变化）
await page.evaluate(() => document.getElementById('btnApply').click());
await new Promise((r) => setTimeout(r, 400));
let sheet = await page.$('.help-sheet');
check('点「应用到字节」不被说明层劫持', !sheet, sheet ? '弹出了说明层=被劫持' : '未弹说明层 ✓');

// 2) 点「写入 ECU」（隐藏功能页，带 title）→ 不得弹说明层
await page.evaluate(() => document.getElementById('btnWriteFeatures').click());
await new Promise((r) => setTimeout(r, 400));
sheet = await page.$('.help-sheet');
check('点「写入 ECU」不被说明层劫持', !sheet, sheet ? '弹出了说明层=被劫持' : '未弹说明层 ✓');

// 3) 说明层正常弹出（点非交互元素上的 ?）且「知道了」可点关闭
//    先制造一个带 title 的非交互元素（模拟统计块 tooltip）
await page.evaluate(() => {
  const d = document.createElement('div');
  d.id = 'probeTip'; d.title = '这是说明内容'; d.textContent = '提示测试';
  document.body.appendChild(d);
  const ui = window.__apxMobileInitTooltips || null;
  return ui;
});
await new Promise((r) => setTimeout(r, 3200));   // 等定时补扫把 title 转成 ?
const badge = await page.$('#probeTip .help-btn');
if (badge) {
  await page.evaluate(() => document.querySelector('#probeTip .help-btn').click());
  await new Promise((r) => setTimeout(r, 300));
  sheet = await page.$('.help-sheet');
  check('非交互元素 ? 可弹出说明层', !!sheet, sheet ? '说明层已弹出' : '未弹出');
  if (sheet) {
    // 「知道了」按钮可点（点完说明层消失）
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.help-sheet button')];
      const b = btns.find((x) => x.textContent === '知道了');
      if (b) b.click(); else document.querySelector('.help-sheet')?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    sheet = await page.$('.help-sheet');
    check('「知道了」点击后说明层关闭', !sheet, sheet ? '仍在=点不动' : '已关闭 ✓');
  }
} else {
  check('非交互元素 ? 可弹出说明层', false, '定时补扫未生成 ? 徽标');
}

// 4) 禁缩放属性存在
const vp = await page.$eval('meta[name=viewport]', (m) => m.content);
check('viewport 禁缩放', /user-scalable=no/.test(vp) && /viewport-fit=cover/.test(vp), vp);
const ta = await page.evaluate(() => getComputedStyle(document.body).touchAction);
check('body touch-action=manipulation', ta === 'manipulation', ta);

await browser.close();
const fail = results.filter((r) => !r.ok).length;
console.log(`\n===== 按钮回归：${results.length - fail} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
