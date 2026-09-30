/**
 * 测试 06：§二 测试/扫描接口 + 换线提示流程（ELM327 跨总线）
 */
import { BridgeClient } from '../src/serial/bridge-client.js';
import { InterfaceTester } from '../src/serial/detect.js';
import { Elm327 } from '../src/elm327.js';
import { BridgePort } from '../src/serial/port-adapter.js';
import { Session } from '../src/session.js';
import { Uds } from '../src/uds.js';
import fs from 'fs';

const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const timeout = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时 ' + ms + 'ms')), ms))]);

// ---------- §二 「测试」按钮 ----------
console.log('--- §二 测试接口 ---');
const bridge = new BridgeClient('ws://127.0.0.1:8850');
await bridge.connect();
const tester = new InterfaceTester(bridge);
const ifaces = JSON.parse(fs.readFileSync(new URL('../src/data/interfaces.json', import.meta.url), 'utf8'));
// 接口表静态断言：vlinker-ms-wifi 条目存在（手机端 WiFi 首选，缺了会误提示换线）
const vw = (ifaces.interfaces || ifaces).find((x) => x.id === 'vlinker-ms-wifi');
check('接口表含 vlinker-ms-wifi（kind=vlinker 免换线）', 'id 存在且 kind=vlinker、transport=wifi、caps 含 autobus',
  vw ? JSON.stringify({ kind: vw.kind, transport: vw.transport, caps: vw.caps }) : '缺失',
  !!vw && vw.kind === 'vlinker' && vw.transport === 'wifi' && (vw.caps || []).includes('autobus'));
// 沙箱连接走内联 spec（产品接口表不暴露测试入口）；kind=vlinker 与真 vLinker MS 语义一致
const spec = {
  id: 'vlinker-ms-sandbox', kind: 'vlinker', name: 'Vgate vLinker MS（沙箱）',
  transport: 'wifi', host: '127.0.0.1', port: 35001,
  probe: ['ATZ', 'ATE0', 'ATI'], expect: 'ELM', caps: ['can', 'kline', 'autobus'],
};
console.log('     spec:', spec.name, spec.host + ':' + spec.port);
const r = await timeout(tester.test(spec, { host: spec.host, port: spec.port }), 30000, 'tester.test');
console.log('     steps:\n       ' + r.steps.join('\n       '));
check('接口测试通过', 'ok=true，识别型号与版本、延迟', `ok=${r.ok} name=${r.identify && r.identify.name} ver=${r.identify && r.identify.version} lat=${r.latency}ms kind=${r.identify && r.identify.kind}`,
    r.ok && /VLinker/i.test(r.identify.name) && typeof r.latency === 'number');
check('识别型号/版本', 'VLinker MS，版本解析', `name="${r.identify.name}" version="${r.identify.version}"`, r.identify.ok && r.identify.name.includes('VLinker'));

// ---------- §二 「扫描接口」 ----------
console.log('--- §二 扫描接口 ---');
let scanOut = '';
try {
    const bridgeScan = new BridgeClient('ws://127.0.0.1:8850');
    await bridgeScan.connect();
    const tester2 = new InterfaceTester(bridgeScan);
    const found = await timeout(tester2.scan(spec), 60000, 'tester.scan');
    scanOut = `发现 ${found.length} 个：` + found.map((f) => f.path + '→' + f.identify.name).join(', ');
} catch (e) { scanOut = e.message; }
check('扫描接口（本机无串口时应明确报未找到）', '发现 0 个或列出可用端口', scanOut, /发现 \d+ 个/.test(scanOut));

// ---------- 换线提示（ELM327 跨总线）----------
console.log('--- §二 换线提示流程（ELM327）---');
const bridge2 = new BridgeClient('ws://127.0.0.1:8850');
await bridge2.connect();
await bridge2.tcpOpen('127.0.0.1', 35001);
const link = new Elm327(new BridgePort(bridge2), { adapter: 'elm327', log: () => {} });
await link.init({ protocol: 8 });
const cables = JSON.parse(fs.readFileSync(new URL('../src/data/cables.json', import.meta.url), 'utf8'));
const mods = JSON.parse(fs.readFileSync(new URL('../src/data/modules.json', import.meta.url), 'utf8'));
const session = new Session(link, { cables, platform: '952', log: () => {} });
const hints = [];
session.on('cableRequired', (e) => { hints.push(e.hint); session.confirmCable(); });
session.on('cableDone', () => { hints.push('(cableDone)'); });

try {
    await timeout(session.ensureModule(session.bodyModule), 15000, 'ensureModule body');
    console.log('     车身电脑连接 OK，换线提示数:', hints.length);
    // 舒适 CAN 节点（125k，5 号蓝线）
    const comfort = mods.alignmentNodes.find((n) => !n.excluded && n.baud === 125 && n.name !== 'Additional Heater Node (CTM)');
    await timeout(session.connectNode(comfort), 15000, 'connect comfort');
    console.log('     舒适节点', comfort.name, '提示数:', hints.length);
    // 底盘/安全 CAN 节点（swapCable，6 号灰线）
    const swap = mods.alignmentNodes.find((n) => !n.excluded && n.swapCable);
    await timeout(session.connectNode(swap), 15000, 'connect swap');
    console.log('     底盘节点', swap.name, '提示数:', hints.length);
    check('ELM327 跨总线应提示换线', '至少 1 次换线提示，含 5 号蓝/6 号灰文案', JSON.stringify(hints),
        hints.some((h) => /5 号|蓝色/.test(h)) && hints.some((h) => /6 号|灰色/.test(h)));
} catch (e) {
    check('ELM327 跨总线应提示换线', '完成跨总线连接并提示', '异常: ' + e.message, false);
}

// vLinker MS 不应提示换线（教程：多路 CAN 自动切换）
const bridge3 = new BridgeClient('ws://127.0.0.1:8850');
await bridge3.connect();
await bridge3.tcpOpen('127.0.0.1', 35001);
const link3 = new Elm327(new BridgePort(bridge3), { adapter: 'vlinker-ms', log: () => {} });
await link3.init({ protocol: 8 });
const session3 = new Session(link3, { cables, platform: '952', log: () => {} });
const hints3 = [];
session3.on('cableRequired', (e) => { hints3.push(e.hint); session3.confirmCable(); });
try {
    await timeout(session3.ensureModule(session3.bodyModule), 15000, 'vlinker body');
    const swap = mods.alignmentNodes.find((n) => !n.excluded && n.swapCable);
    await timeout(session3.connectNode(swap), 15000, 'vlinker swap');
    check('vLinker MS 不提示换线（多路 CAN 自动切换）', '无 cableRequired', JSON.stringify(hints3), hints3.length === 0);
} catch (e) {
    check('vLinker MS 不提示换线（多路 CAN 自动切换）', '无 cableRequired', '异常: ' + e.message, false);
}

console.log('\n=== 汇总 ===');
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}`);
console.log(`通过 ${results.filter((x) => x.ok).length}/${results.length}`);
process.exit(0);
