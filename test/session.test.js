/** 会话/模块连接自测：node test/session.test.js */
import fs from 'fs';
import { Session } from '../src/session.js';
import { Elm327 } from '../src/elm327.js';
import { MockAdapter } from '../src/mock-adapter.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const cables = JSON.parse(fs.readFileSync(new URL('../src/data/cables.json', import.meta.url), 'utf8'));
const mk = (adapter) => {
    const port = new MockAdapter({});
    const link = new Elm327(port, { adapter });
    return { port, link };
};

console.log('适配线分组（来自 PROXIX1 的 ResultFormat）');
check('BODY33 是直连', cables.modules.BODY33.group === 'none');
check('ABSMMKC1 需换 6 号灰线', cables.modules.ABSMMKC1.group === 'swap');
check('CLIMA33 走 5 号蓝线', cables.modules.CLIMA33.group === 'comfort');
check('EPSZFX1 需换线', cables.modules.EPSZFX1.group === 'swap');

console.log('\nELM327：换线要提示');
{
    const { link } = mk('elm327');
    const s = new Session(link, { cables, platform: '952', log: () => {} });
    let prompted = 0;
    s.on('cableRequired', () => prompted++);
    await s.ensureModule('BODY33');
    check('直连模块不提示', prompted === 0);
    check('当前模块是 BODY33', s.current.code === 'BODY33');

    const p = s.ensureModule('ABSMMKC1');
    check('换线组弹提示', prompted === 1);
    check('确认前还没连上', s.current.code === 'BODY33');
    s.confirmCable();
    await p;
    check('确认后连上 ABSMMKC1', s.current.code === 'ABSMMKC1');
    check('换线组已更新', s.currentGroup === 'swap');
}

console.log('\nvLinker MS：免换线');
{
    const { link } = mk('vlinker-ms');
    const s = new Session(link, { cables, platform: '952', log: () => {} });
    let prompted = 0;
    s.on('cableRequired', () => prompted++);
    await s.ensureModule('ABSMMKC1');
    check('vLinker 不提示换线', prompted === 0);
    check('直接连上 ABSMMKC1', s.current.code === 'ABSMMKC1');
}

console.log('\nrunOn：先连模块再执行');
{
    const { link } = mk('elm327');
    const s = new Session(link, { cables, platform: '952', log: () => {} });
    const order = [];
    s.on('moduleConnected', (e) => order.push('connect:' + e.module.code));
    const p = s.runOn('ABG28', async (m) => { order.push('run:' + m.code); return 'ok'; });
    s.confirmCable();
    check('runOn 返回值', (await p) === 'ok');
    check('顺序是 先连接后执行', order.join('>') === 'connect:ABG28>run:ABG28', order.join('>'));
}

console.log('\n车型 → 车身电脑');
{
    const { link } = mk('sim');
    check('952 → BODY33', new Session(link, { cables, platform: '952' }).bodyModule === 'BODY33');
    check('949 → BODY30', new Session(link, { cables, platform: '949' }).bodyModule === 'BODY30');
}

console.log('\n未知模块要报错');
{
    const { link } = mk('sim');
    const s = new Session(link, { cables, platform: '952' });
    let threw = false;
    try { await s.ensureModule('NOPE'); } catch (e) { threw = true; }
    check('未知模块抛错', threw);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
