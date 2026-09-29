/**
 * 真浏览器 UI 冒烟：验证用户报的两个问题
 *  1) 切接口后串口残留内网 IP / 产品列表暴露沙箱接口
 *  2) 配置项选中→写入后无反馈（应有 待写入→已写入 三态）
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, actual) => {
  results.push({ name, ok, actual });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     ${actual}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--allow-insecure-localhost'],
});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto('http://localhost:8848/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => document.getElementById('ifaceType')?.options?.length > 1, { timeout: 15000 });

// ---------- 问题 1：接口列表 + IP 残留 ----------
console.log('--- 问题1：接口列表与串口字段 ---');
const opts = await page.$$eval('#ifaceType option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
check('产品接口列表无沙箱入口', !opts.some((o) => /沙箱/.test(o.t)), `共 ${opts.length} 项，含沙箱: ${opts.some((o) => /沙箱/.test(o.t))}`);

// 选 WiFi 型 → 应显示 IP（WiFi 正常行为）
await page.select('#ifaceType', 'obdlink-vlinker-wifi');
const wifiVal = await page.$eval('#ifacePort', (el) => el.value);
check('WiFi 型接口显示 IP:端口', /^\d+\.\d+\.\d+\.\d+:\d+$/.test(wifiVal), `值: "${wifiVal}"`);

// 切到 USB → 不应残留 IP
await page.select('#ifaceType', 'elm-usb');
const usbVal = await page.$eval('#ifacePort', (el) => el.value);
check('切到 USB 后串口字段无 IP 残留', !/^\d+\.\d+\.\d+\.\d+/.test(usbVal), `值: "${usbVal}"`);

// ---------- 问题 2：写入反馈 ----------
console.log('--- 问题2：选中→写入 的三态反馈 ---');
await page.select('#ifaceType', 'obdlink-vlinker-wifi');
await page.$eval('#ifacePort', (el) => { el.value = '127.0.0.1:35001'; });
await page.click('#btnConnect');
try {
  await page.waitForFunction(
    () => /已读取/.test(document.getElementById('readState')?.textContent || ''),
    { timeout: 60000 });
  check('连接并自动读取配置', true, await page.$eval('#readState', (el) => el.textContent));
} catch {
  check('连接并自动读取配置', false, await page.$eval('#connState', (el) => el.textContent) + ' / ' + await page.$eval('#readState', (el) => el.textContent));
}

// 命名配置项：改下拉 → 应出现「待写入」
const namedInfo = await page.evaluate(() => {
  const sel = document.querySelector('#namedGrid select');
  if (!sel) return null;
  const opts = [...sel.options].filter((o) => o.value !== '');
  const cur = sel.value;
  const target = opts.find((o) => o.value !== cur) || opts[0];
  sel.value = target.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { picked: target.textContent, grid: document.querySelector('#namedGrid').textContent };
});
check('命名项选中后显示「待写入」', namedInfo && /待写入/.test(namedInfo.grid), `选了「${namedInfo?.picked}」`);

// 直接点「写入 ECU」（不先点「写入所选项」）→ 选中即写
await page.click('[data-tab="editor"]');
await page.click('#btnWrite');
try {
  await page.waitForFunction(
    () => /已写入|写入失败/.test(document.querySelector('#namedGrid')?.textContent || ''),
    { timeout: 30000 });
  const grid = await page.$eval('#namedGrid', (el) => el.textContent);
  check('写入后命名项显示「已写入」', /已写入/.test(grid) && !/待写入/.test(grid.slice(0, 400)), grid.slice(0, 160).replace(/\s+/g, ' '));
} catch {
  const grid = await page.$eval('#namedGrid', (el) => el.textContent);
  check('写入后命名项显示「已写入」', false, '超时；网格片段: ' + grid.slice(0, 160).replace(/\s+/g, ' '));
}

// 扩展配置项：点选 → 待写入 → 写入 → 已写入（与命名项同一套反馈）
await page.click('[data-tab="features"]');
const featPick = await page.evaluate(() => {
  const card = document.querySelector('#featGrid .card');
  if (!card) return null;
  const opt = card.querySelector('.opt');
  if (opt) opt.click(); else card.click();
  return document.querySelector('#featGrid').textContent;
});
check('扩展项选中后显示「待写入」', featPick && /待写入/.test(featPick), featPick?.slice(0, 120).replace(/\s+/g, ' '));

await page.click('[data-tab="editor"]');
await page.click('#btnWrite');
try {
  await page.waitForFunction(
    () => /已写入|写入失败/.test(document.querySelector('#featGrid')?.textContent || ''),
    { timeout: 30000 });
  const grid = await page.$eval('#featGrid', (el) => el.textContent);
  check('写入后扩展项显示「已写入」', /已写入/.test(grid), grid.slice(0, 160).replace(/\s+/g, ' '));
} catch {
  const grid = await page.$eval('#featGrid', (el) => el.textContent);
  check('写入后扩展项显示「已写入」', false, '超时；网格片段: ' + grid.slice(0, 160).replace(/\s+/g, ' '));
}

await browser.close();
const fail = results.filter((r) => !r.ok);
console.log(`\n===== UI 冒烟：${results.length - fail.length} 通过 / ${fail.length} 失败 =====`);
process.exit(fail.length ? 1 : 0);
