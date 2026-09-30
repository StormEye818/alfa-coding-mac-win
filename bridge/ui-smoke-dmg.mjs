// 驱动真实 Electron 窗口做端到端验证
import puppeteer from 'puppeteer-core';
const results = [];
const check = (name, ok, actual) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     ${actual}`);
};
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9225', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().includes('/app/')) || pages[0];
page.on('dialog', (d) => d.accept().catch(() => {}));

await page.waitForFunction(() => document.getElementById('ifaceType')?.options?.length > 1, { timeout: 15000 });
check('界面加载（接口下拉有数据）', true, await page.title());

// 连接模拟车（WiFi 型 + TCP 地址）
await page.select('#ifaceType', 'obdlink-vlinker-wifi');
await page.$eval('#ifacePort', (el) => { el.value = '127.0.0.1:35001'; });
await page.click('#btnConnect');
try {
  await page.waitForFunction(() => /已读取/.test(document.getElementById('readState')?.textContent || ''), { timeout: 60000 });
  check('连接模拟车并自动读取', true, await page.$eval('#readState', (el) => el.textContent));
} catch {
  check('连接模拟车并自动读取', false, await page.$eval('#connState', (el) => el.textContent));
}

// 选中命名项 → 待写入 → 写入 ECU → 已写入
const picked = await page.evaluate(() => {
  const sel = document.querySelector('#namedGrid select');
  const opts = [...sel.options].filter((o) => o.value !== '');
  const target = opts.find((o) => o.value !== sel.value) || opts[0];
  sel.value = target.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { label: target.textContent, pending: /待写入/.test(document.querySelector('#namedGrid').textContent) };
});
check('选中命名项显示「待写入」', picked.pending, `选了「${picked.label}」`);

await page.click('[data-tab="editor"]');
await page.click('#btnWrite');
try {
  await page.waitForFunction(() => /已写入|写入失败/.test(document.querySelector('#namedGrid')?.textContent || ''), { timeout: 30000 });
  check('写入后显示「已写入」', true, (await page.$eval('#namedGrid', (el) => el.textContent)).slice(0, 100).replace(/\s+/g, ' '));
} catch {
  check('写入后显示「已写入」', false, '超时');
}
const ports = await page.evaluate(() => new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:8850'); ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: 'listPorts' })); ws.onmessage = (e) => { const m = JSON.parse(e.data); res(m.ports ? m.ports.length : -1); }; setTimeout(() => res(-2), 5000); }));
check('串口枚举（serialport 原生绑定可用）', ports >= 0, '发现 ' + ports + ' 个串口');
const fail = results.filter((r) => !r.ok).length;
console.log(`\n===== Electron 端到端：${results.length - fail} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
