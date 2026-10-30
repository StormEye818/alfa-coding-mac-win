/**
 * 移动端底部堆叠冒烟：悬浮写入条 / 状态条 / 底部标签栏 不能互相压住。
 *
 * 背景（2026-10-30）：底部导航是 position:fixed；悬浮条与状态条的让位规则只写在
 * `@media (max-width:720px)` 里，平板/折叠机展开态（视口 >720）不生效 → 悬浮条
 * 直接压在标签栏上。本脚本按「宽视口 + mobile=1」复现那个状态并断言不再重叠。
 *
 * 用法：
 *   cd ~/alfaproxi && python3 -m http.server 8862 &
 *   cd bridge && node mobile-bottom-smoke.mjs                 # 默认 1080×760（duo 展开态）
 *   VW=390 VH=844 node mobile-bottom-smoke.mjs                # 手机竖屏
 *   APP_URL=http://127.0.0.1:8848/app/?mobile=1 node mobile-bottom-smoke.mjs
 */
import puppeteer from 'puppeteer-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_APP = process.env.APP_URL || 'http://127.0.0.1:8862/app/?mobile=1';
const W = Number(process.env.VW || 1080);
const H = Number(process.env.VH || 760);

const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${x ? `\n       ${x}` : ''}`); };

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
p.on('dialog', (d) => d.accept().catch(() => {}));
p.on('pageerror', (e) => check('无页面异常', false, e.message));
await p.goto(URL_APP, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('ifaceType')?.options?.length > 1);
await new Promise((r) => setTimeout(r, 400));

const geo = () => p.evaluate(() => {
    const bar = document.getElementById('floatWriteBar');
    const tabs = document.querySelector('nav.tabs');
    const stage = document.getElementById('stageBar');
    const cs = getComputedStyle(bar);
    const rb = bar.getBoundingClientRect();
    const rt = tabs.getBoundingClientRect();
    const bodyPad = parseFloat(getComputedStyle(document.body).paddingBottom);
    return {
        mobile: document.body.classList.contains('mobile'),
        display: cs.display,
        hasFloat: document.body.classList.contains('has-float-write'),
        barBottom: Math.round(rb.bottom),
        barTop: Math.round(rb.top),
        tabsTop: Math.round(rt.top),
        gap: Math.round(rt.top - rb.bottom),
        bodyPad: Math.round(bodyPad),
        stage: stage && !stage.classList.contains('hidden')
            ? { top: Math.round(stage.getBoundingClientRect().top), bottom: Math.round(stage.getBoundingClientRect().bottom) }
            : null,
        vh: window.innerHeight,
    };
});

let g = await geo();
check('未选任何项时浮动条收起', g.display === 'none', JSON.stringify(g));
check('未选时无 has-float-write', !g.hasFloat, JSON.stringify(g));

// 进入模拟模式并读配置
await p.evaluate(() => document.getElementById('btnSimulate').click());
await p.waitForFunction(() => /已读取/.test(document.getElementById('readState').textContent), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 500));

// 选一个命名配置项 → 浮动条出现
const picked = await p.evaluate(() => {
    for (const sel of document.querySelectorAll('#namedGrid select')) {
        const opts = [...sel.options].filter((o) => o.value !== '');
        const cur = sel.value;
        const other = opts.find((o) => o.value !== cur);
        if (other) {
            sel.value = other.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { from: cur, to: other.value, label: sel.closest('.named-item')?.innerText?.split('\n')[0] };
        }
    }
    return null;
});
await new Promise((r) => setTimeout(r, 400));
g = await geo();
check('选中后浮动条出现', g.display === 'flex', `${JSON.stringify(g)} picked=${JSON.stringify(picked)}`);
check('浮动条不压标签栏（底部留出间隙）', g.gap >= 0 && g.barBottom <= g.tabsTop,
    `bar.bottom=${g.barBottom} tabs.top=${g.tabsTop} gap=${g.gap}`);
check('出现时正文补了底部留白', g.hasFloat && g.bodyPad >= 120, `padding-bottom=${g.bodyPad}px`);
check('状态条不压在悬浮条上', !g.stage || g.stage.bottom <= g.barTop,
    g.stage ? `stage.bottom=${g.stage.bottom} bar.top=${g.barTop}` : '状态条已隐藏');

await p.screenshot({ path: '/tmp/duo-after.png' });

// 取消选择 → 收起
await p.evaluate(() => {
    for (const sel of document.querySelectorAll('#namedGrid select')) {
        if (sel.value !== '') { sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
    }
});
await new Promise((r) => setTimeout(r, 300));
g = await geo();
check('取消选择后收起', g.display === 'none' && !g.hasFloat, JSON.stringify(g));

await b.close();
const pass = results.filter(Boolean).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
