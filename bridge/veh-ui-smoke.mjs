/**
 * 无头 Chrome 冒烟：本车识别 + 模块清单过滤（模块诊断 / 特殊功能）。
 *
 * 用法（需要一个静态服务，端口随意）：
 *   cd ~/alfaproxi && python3 -m http.server 8861 &
 *   cd bridge && node veh-ui-smoke.mjs                       # 默认 http://127.0.0.1:8861/app/
 *   APP_URL=http://127.0.0.1:8848/app/ node veh-ui-smoke.mjs # 指定地址
 *
 * 模拟车 = Giulia 2.0 汽油（无 SCR / 无 V6 副 ECU）
 * 断言：
 *   - 顶部出现本车识别条，车型/发动机正确
 *   - 模块清单不含 2.2 柴油、2.9 V6（主/副）
 *   - 特殊功能的模块下拉同样过滤
 *   - 手动切 2.2 → 柴油 ECU 出现、2.0 消失
 *   - 「显示未配置」→ 清单变全量
 *   - 无 pageerror
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_APP = process.env.APP_URL || 'http://127.0.0.1:8861/app/';

const results = [];
const check = (name, ok, actual = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${actual ? `\n       ${actual}` : ''}`);
};

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const failedReq = [];
page.on('requestfailed', (r) => failedReq.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failedReq.push(`${r.status()} ${r.url()}`); });
page.on('dialog', (d) => d.accept().catch(() => {}));

await page.goto(URL_APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => document.getElementById('ifaceType')?.options?.length > 1, { timeout: 15000 });

// 进入模拟模式（等价点击「模拟」）
await page.evaluate(() => document.getElementById('btnSimulate').click());
await page.waitForFunction(() => !document.getElementById('vehBar').classList.contains('hidden'), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

const bar = await page.evaluate(() => ({
    name: document.getElementById('vehName').textContent.trim(),
    note: document.getElementById('vehNote').textContent.trim(),
    engine: document.getElementById('vehEngine').value,
    toggle: document.getElementById('vehToggle').textContent.trim(),
}));
check('本车识别条显示', /Giulia（952）/.test(bar.name) && /2\.0 汽油/.test(bar.name), JSON.stringify(bar));
check('自动识别来源说明（单 ECM 推断，可改）', /ECM|推断/.test(bar.note), bar.note);

const rowText = () => page.evaluate(() => [...document.querySelectorAll('#moduleList .mrow')].map((r) => r.innerText.replace(/\n/g, ' | ')));
let rows = await rowText();
const has = (rowsList, kw) => rowsList.some((t) => t.includes(kw));
check('模块清单已过滤（少于 35 行）', rows.length > 0 && rows.length < 35, `${rows.length} 行`);
check('不含 2.2 柴油 ECU（JTDM23GP）', !has(rows, 'JTDM23GP'), rows.length ? '' : '(空)');
check('不含 2.9 V6 主 ECU（MED17.3.5）', !rows.some((t) => /MED17\.3\.5\b/.test(t)));
check('不含 2.9 V6 副 ECU（MED17.3.5S）', !has(rows, 'MED17.3.5S'));
check('含 2.0 汽油 ECU（IAW10JAX）', has(rows, 'IAW10JAX'));
check('含 ABS / 车身（BODY33）', has(rows, 'ABSMMKC1') && has(rows, 'BODY33'));
check('含 EPS（模拟车里是「待添加」也要能看到）', has(rows, 'EPSZFX1'));

// 特殊功能的模块下拉
const fnOpts = await page.evaluate(() => {
    document.querySelector('.tab[data-tab="funcs"]').click();
    return [...document.getElementById('fnModule').options].map((o) => o.value).filter(Boolean);
});
check('特殊功能模块下拉已过滤', fnOpts.length > 0 && fnOpts.length < 30 && !fnOpts.includes('JTDM23GP'),
    `${fnOpts.length} 项：${fnOpts.slice(0, 6).join(',')}…`);
check('特殊功能下拉含 2.0 汽油', fnOpts.includes('IAW10JAX'));

// 手动把发动机改成 2.2 → 柴油 ECU 应立刻出现
await page.select('#vehEngine', '2.2');
await new Promise((r) => setTimeout(r, 400));
rows = await rowText();
check('手动 2.2 后出现柴油 ECU', has(rows, 'JTDM23GP'), rows.length ? '' : '(空)');
check('手动 2.2 后隐藏 2.0 汽油', !has(rows, 'IAW10JAX'));
const fnAfter = await page.evaluate(() => [...document.getElementById('fnModule').options].map((o) => o.value).filter(Boolean));
check('特殊功能下拉跟随手动选择', fnAfter.includes('JTDM23GP') && !fnAfter.includes('IAW10JAX'), fnAfter.join(','));

// 恢复自动
await page.select('#vehEngine', '');
await new Promise((r) => setTimeout(r, 300));
rows = await rowText();
check('恢复自动后回到 2.0', has(rows, 'IAW10JAX') && !has(rows, 'JTDM23GP'));

// 显示全部
const before = rows.length;
await page.evaluate(() => document.getElementById('vehToggle').click());
await new Promise((r) => setTimeout(r, 300));
rows = await rowText();
check('「显示未配置」后回到全量 34 个（PROXIX1 由对齐页接管，不进清单）', rows.length === 34, `${before} → ${rows.length}`);
check('全量时未配置模块带标签', rows.some((t) => /未配置|其它平台|其它动力/.test(t)));

check('无页面 JS 异常', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0,
    errors.slice(0, 3).join(' / '));
// .smoke-flag 是 app/smoke.js 的哨兵文件（不存在是正常的）；favicon 同理
check('无 404/资源加载失败', failedReq.filter((u) => !/favicon|\.smoke-flag/.test(u)).length === 0, failedReq.slice(0, 5).join(' / '));

await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
