/**
 * 移动端三态导航冒烟：dock / rail 的位置与遮挡（2026-10-30 P0+P1）。
 *
 * 无头浏览器没有刘海/状态栏，用 ?safe=t,r,b,l 注入安全区后再断言：
 *   · 导航整体落在「屏幕 − 安全区」以内
 *   · 顶部导航（rail）不盖住 header；底部导航（dock）不盖住 main 末尾
 *   · 悬浮写入条 / 状态条与导航不相交
 *
 * 用法：
 *   cd ~/alfaproxi && python3 -m http.server 8866 &
 *   cd bridge && node mobile-nav-smoke.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_URL || 'http://127.0.0.1:8866/app/';

const CASES = [
    { name: 'iPhone 竖屏 dock', w: 390, h: 844, safe: '59,0,34,0', mode: 'nav-dock' },
    { name: 'iPhone 横屏 dock', w: 852, h: 393, safe: '0,47,21,47', mode: 'nav-dock' },
    { name: 'Duo 展开 rail', w: 1080, h: 760, safe: '24,0,0,0', mode: 'nav-rail' },
    { name: 'iPad 竖屏 rail', w: 820, h: 1180, safe: '24,0,20,0', mode: 'nav-rail' },
];

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`PASS | ${n}${x ? `\n       ${x}` : ''}`)) : (fail++, console.log(`FAIL | ${n}${x ? `\n       ${x}` : ''}`)); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

for (const c of CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: c.w, height: c.h, deviceScaleFactor: 2 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`${BASE}?mobile=1&safe=${c.safe}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('ifaceType')?.options?.length > 1, { timeout: 15000 });
    await page.evaluate(() => document.getElementById('btnSimulate').click());
    await page.waitForFunction(() => /已读取/.test(document.getElementById('readState').textContent), { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 400));

    // 选一项，让悬浮写入条出现
    await page.evaluate(() => {
        for (const sel of document.querySelectorAll('#namedGrid select')) {
            const other = [...sel.options].find((o) => o.value !== sel.value && o.value !== '');
            if (other) { sel.value = other.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
        }
    });
    await new Promise((r) => setTimeout(r, 350));

    const g = await page.evaluate(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
        const cs = getComputedStyle(document.documentElement);
        const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
        const bar = document.getElementById('floatWriteBar');
        const stage = document.getElementById('stageBar');
        return {
            cls: document.body.className,
            vw: innerWidth, vh: innerHeight,
            safe: { t: px('--safe-t'), r: px('--safe-r'), b: px('--safe-b'), l: px('--safe-l') },
            nav: rect(document.querySelector('nav.tabs')),
            header: rect(document.querySelector('header.top')),
            main: rect(document.querySelector('main')),
            float: bar && !bar.classList.contains('hidden') ? rect(bar) : null,
            stage: stage && !stage.classList.contains('hidden') ? rect(stage) : null,
        };
    });

    const s = g.safe;
    console.log(`\n=== ${c.name}（${c.w}×${c.h} · safe ${c.safe}）`);
    check('导航形态正确', g.cls.includes(c.mode), g.cls);

    if (c.mode === 'nav-dock') {
        check('底栏距屏底 = 安全区 + 8', Math.abs((g.vh - g.nav.b) - (s.b + 8)) <= 1, `nav.b=${g.nav.b} vh=${g.vh} safeB=${s.b}`);
        check('底栏距左 = 安全区 + 12', Math.abs(g.nav.l - (s.l + 12)) <= 1, `nav.l=${g.nav.l} safeL=${s.l}`);
        check('底栏距右 = 安全区 + 12', Math.abs((g.vw - g.nav.r) - (s.r + 12)) <= 1, `nav.r=${g.nav.r} vw=${g.vw} safeR=${s.r}`);
        check('底栏在 header 之下（不重叠）', g.nav.t > g.header.b, `nav.t=${g.nav.t} header.b=${g.header.b}`);
        check('悬浮条在底栏之上', !g.float || g.float.b <= g.nav.t, g.float ? `float.b=${g.float.b} nav.t=${g.nav.t}` : '未显示');
        check('状态条在底栏之上', !g.stage || g.stage.b <= g.nav.t, g.stage ? `stage.b=${g.stage.b} nav.t=${g.nav.t}` : '未显示');
    } else {
        check('侧栏距右 = 安全区 + 10', Math.abs((g.vw - g.nav.r) - (s.r + 10)) <= 1, `nav.r=${g.nav.r} vw=${g.vw} safeR=${s.r}`);
        check('侧栏顶 = 顶栏底 + 8（不进入状态栏区域）',
            Math.abs(g.nav.t - (g.header.b + 8)) <= 2, `nav.t=${g.nav.t} header.b=${g.header.b}`);
        check('侧栏顶在状态栏下沿之外', g.nav.t >= s.t + 8, `nav.t=${g.nav.t} safeT=${s.t}`);
        check('侧栏宽 88', g.nav.w === 88, `w=${g.nav.w}`);
        check('侧栏在 header 右侧之外', g.header.r <= g.nav.l, `header.r=${g.header.r} nav.l=${g.nav.l}`);
        check('内容不钻进侧栏', g.main.r <= g.nav.l, `main.r=${g.main.r} nav.l=${g.nav.l}`);
        check('悬浮条让开侧栏', !g.float || g.float.r <= g.nav.l, g.float ? `float.r=${g.float.r} nav.l=${g.nav.l}` : '未显示');
        check('状态条不与侧栏相交', !g.stage || g.stage.r <= g.nav.l, g.stage ? `stage.r=${g.stage.r} nav.l=${g.nav.l}` : '未显示');
    }
    check('无页面 JS 异常', errs.length === 0, errs.slice(0, 2).join(' / '));

    await page.screenshot({ path: `/tmp/nav-${c.mode}-${c.w}.png` });
    await page.close();
}

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
