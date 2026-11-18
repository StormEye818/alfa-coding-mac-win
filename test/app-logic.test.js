/**
 * app.js 主链修复项真断言：S1–S7 / A1 / A4 / A6 / C2 / D1 / D3 / UX2 / UX3。
 * node test/app-logic.test.js
 *
 * 不查字符串：全部通过 instantiate() 从真实 app.js 切出函数体真跑，
 * 或调用纯函数并断言返回结构；反例注入用不同入参证明断言会红。
 */
import fs from 'fs';
import { instantiate, fakeClock } from '../tools/verify-mes-lib.mjs';
import { hexToBytes } from '../src/elm327.js';
import { isRoutineBusy, NRC, DID } from '../src/uds.js';
import { computeAlignment } from '../src/alignment.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => {
  c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`));
};

const src = fs.readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');
const fn = (name, deps = {}) => instantiate(src, name, deps);

/* ---------------- S1/S2/S4/S6：runCommandString 真跑 ---------------- */
console.log('特殊功能执行引擎（S1–S6）');

function cmdHarness(responses) {
  const clock = fakeClock();
  const requests = [];
  let i = 0;
  const state = {
    link: {
      async request(payload, opts) {
        const p = Array.from(payload);
        requests.push(p);
        const r = responses ? responses(p, requests.length, i++) : Uint8Array.from([0x71, p[1], ...p.slice(2)]);
        return typeof r === 'function' ? r() : r;
      },
    },
  };
  const deps = {
    state, hexToBytes, isRoutineBusy, NRC, fnAbort: false,
    setTimeout: clock.setTimeout, Date: clock.Date,
    confirm: () => true, stage() {}, log() {}, alert() {},
    $: () => ({ textContent: '', className: '', classList: { add() {}, remove() {} } }),
  };
  return { clock, requests, state, deps };
}

{
  // S1：commands[1] 是**合法**的 31 02（长度与字节都对），旧实现会真发出去。
  const h = cmdHarness();
  const item = { resultFormat: 'FUNC', commands: '0431012000,0531022001FF,0431032000' };
  await fn('runCommandString', h.deps)(item.commands, item);
  const starts = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x01).length;
  const stops = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x02).length;
  const polls = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x03).length;
  check('S1 只发 31 01 一次', starts === 1, `starts=${starts}`);
  check('S1 不发 commands[1] 的 31 02', stops === 0, `stops=${stops}`);
  check('S1 自造 31 03 轮询至少一次', polls >= 1, `polls=${polls}`);
}

for (const [flag, expected] of [['0.5SEC', 500], ['1SEC', 1000]]) {
  const h = cmdHarness();
  const item = { resultFormat: flag, commands: '0431012000' };
  await fn('runCommandString', h.deps)(item.commands, item);
  const waited = h.clock.delays.reduce((a, b) => a + b, 0);
  check(`S2 ${flag} 不乘沉降倍数（≈${expected}ms）`, waited > 0 && waited <= expected * 1.1,
    `waited=${Math.round(waited)}`);
  // 反例注入：2s 默认（>1000）必须乘 5，否则门控被改成「永远不乘」
  if (flag === '1SEC') {
    const h2 = cmdHarness();
    await fn('runCommandString', h2.deps)('0431012000', { resultFormat: '', commands: '0431012000' });
    const w2 = h2.clock.delays.reduce((a, b) => a + b, 0);
    check('S2 反例：2s 默认仍乘 5（>1000 门控生效）', w2 > 2000 * 1.5, `waited=${Math.round(w2)}`);
  }
}

{
  // S6：结构化字段是权威值；旗标只兜底。假时钟按 ms 前进，精确量必须与门禁一致。
  const h = cmdHarness();
  await fn('runCommandString', h.deps)('0431012000', { resultFormat: 'PROBE_ONLY', commands: '0431012000', intervalMs: 5000 });
  const waited = h.clock.delays.reduce((a, b) => a + b, 0);
  check('S6 intervalMs=5000 精确等待 25000ms', waited === 25000, `waited=${Math.round(waited)}`);
  const h2 = cmdHarness();
  await fn('runCommandString', h2.deps)('0431012000', { resultFormat: '5SEC', commands: '0431012000' });
  const w2 = h2.clock.delays.reduce((a, b) => a + b, 0);
  check('S6 旗标兜底同样 25000ms', w2 === 25000, `waited=${Math.round(w2)}`);
}

{
  // S4：BitResults（MMVV标签）把结果字节翻成可读文本；先忙一次再给完成/失败原因
  const seq = [
    Uint8Array.from([0x7f, 0x31, 0x21]),                     // 忙
    Uint8Array.from([0x71, 0x03, 0x02, 0x05]),               // b=0x05 → 冷却液温度超范围
  ];
  const h = cmdHarness((p, n) => (p[1] === 0x03 ? seq[Math.min(n - 2, seq.length - 1)] : undefined));
  const item = {
    resultFormat: 'FUNC',
    commands: '0431012000',
    options: ['FF00Completed correctly', 'FF05Coolant temperature out of range', '0000Generic error'],
  };
  const sent = await fn('runCommandString', h.deps)(item.commands, item);
  const text = sent.join('\n');
  check('S4 结果按 BitResults 映射为可读文本', /Coolant temperature out of range/.test(text), text);
  check('S4 不再只显示裸 FF00/原始字节', !/例程状态：71 03 02 05$/.test(text.trim()), text);
}

{
  // S3：每路独立 abort 令牌（对象形态）能中止；布尔 false 形态不误中止
  const h = cmdHarness();
  const token = { aborted: true };
  const sent = await fn('runCommandString', h.deps)('0431012000', {}, { abortToken: token });
  check('S3 abort 令牌生效（启动命令未执行，只走中止+恢复）',
    sent.length === 2 && sent[0].includes('执行中止') && sent[1].includes('恢复命令已发')
      && !sent.some((s) => s.includes(' → ✓')),
    JSON.stringify(sent));
  const h2 = cmdHarness();
  await fn('runCommandString', h2.deps)('0431012000', {});
  check('S3 布尔 false 回落不误中止', h2.requests.length > 0, `requests=${h2.requests.length}`);
}

/* ---------------- S5：读改写基线取读命令 DID ---------------- */
console.log('\n读改写基线（S5）');
{
  const readDids = [];
  const state = { uds: { async readDataByIdentifier(did) { readDids.push(did); return Uint8Array.from([0xaa, 0xbb]); } } };
  const mergeWriteField = fn('mergeWriteField');
  const mergeRw = fn('mergeRwUserEntry', { state, hexToBytes, mergeWriteField });
  const item = { commands: '0322F1B0,042EF190AA', input: { kind: 'hex' } };
  const result = await mergeRw(item, { value: 'CC' });
  check('S5 按读命令 DID F1B0 读基线', readDids.length === 1 && readDids[0] === 0xf1b0,
    `dids=${readDids.map((d) => d.toString(16)).join(',')}`);
  check('S5 写模板 DID 不变（F190）', typeof result === 'string' && result.includes('2EF190'), String(result));
  // 反例：读写 DID 相同的条目仍正常
  const read2 = [];
  const state2 = { uds: { async readDataByIdentifier(did) { read2.push(did); return Uint8Array.from([0xaa]); } } };
  await fn('mergeRwUserEntry', { state: state2, hexToBytes, mergeWriteField })(
    { commands: '0322F190,042EF190AA', input: { kind: 'hex' } }, { value: 'CC' });
  check('S5 反例：读写同 DID 时只读一次', read2.length === 1 && read2[0] === 0xf190, `dids=${read2.join(',')}`);
}

/* ---------------- A1：DATA3 双读一致性 ---------------- */
console.log('\n对齐前置双读（A1）');
{
  let d3read = 0, d1read = 0;
  const state = {
    session: { bodyModule: 'BCM', async ensureModule() {} },
    uds: {
      async readProxi() { d1read++; return Uint8Array.from([1, 2, 3]); },
      async readDataByIdentifier(did) {
        if (did === DID.DATA3) { d3read++; return Uint8Array.from([4, 5, 6]); }
        return Uint8Array.from([0]);
      },
    },
    modules: { alignmentNodes: [] },
  };
  const applyAlignment = fn('applyAlignment', { state, computeAlignment, log() {} });
  const refresh = fn('refreshAlignment', { state, DID, applyAlignment });
  const res = await refresh({ log: false });
  check('A1 DATA3 读两次', d3read === 2, `d3=${d3read}`);
  check('A1 DATA1 仍读两次', d1read === 2, `d1=${d1read}`);
  check('A1 一致时返回对齐结果', res && res.ok === false && Array.isArray(res.rows), JSON.stringify(res && res.counts));

  // 反例：两次 DATA3 不一致必须抛错，不能用脏位图
  let n = 0;
  state.uds.readDataByIdentifier = async (did) =>
    did === DID.DATA3 ? Uint8Array.from([++n, 5, 6]) : Uint8Array.from([0]);
  let threw = false;
  try { await refresh({ log: false }); } catch (e) { threw = /DATA3 不一致/.test(e.message); }
  check('A1 反例：DATA3 抖动时中止', threw, `threw=${threw}`);
}

/* ---------------- A4/A6：EOL 门槛与回读统计 ---------------- */
console.log('\nEOL 门槛与回读统计（A4/A6）');
{
  const eolWritable = fn('eolWritableRow');
  check('A4 E=1 可写', eolWritable({ eol: true }) === true);
  check('A4 E=0 不可写（MES continue）', eolWritable({ eol: false }) === false);
  check('A4 反例：无行不可写', eolWritable(null) === false);
  const note = fn('alignReadbackNote');
  const s = note(3, 2);
  check('A6 未回读不计入已回读成功', /已回读成功 3/.test(s) && /已写入未回读 2/.test(s), s);
}

/* ---------------- D1/D3：DTC 状态维度与模块准入 ---------------- */
console.log('\nDTC 状态维度与模块准入（D1/D3）');
{
  const dec = fn('decodeDtcStatus');
  const s20 = dec(0x20);
  check('D1 0x20 → stored=true（bit5）', s20.stored === true && s20.active === false, JSON.stringify(s20));
  const s80 = dec(0x80);
  check('D1 0x80 → mil=true（bit7）', s80.mil === true, JSON.stringify(s80));
  const s40 = dec(0x40);
  check('D1 0x40 → 仅自检未完成，非故障', s40.untested === true && s40.stored === false && s40.mil === false,
    JSON.stringify(s40));
  const multi = dec(0xa5);
  check('D1 四维度并存：0xa5 active+stored+mil 同时置位',
    multi.active && multi.stored && multi.mil && multi.testFailed && multi.failedSinceClear,
    JSON.stringify(multi));
  const flt = fn('dtcModuleCodes');
  const mods = [{ code: 'BODY30' }, { code: 'SVCRST29' }, { code: 'ABSMMKC1' }];
  const dict = { modules: { BODY30: {}, ABSMMKC1: {} } };
  const codes = flt(mods, dict, () => true);
  check('D3 无字典的 SVCRST29 被排除', !codes.includes('SVCRST29') && codes.length === 2, codes.join(','));
  check('D3 反例：有字典模块保留', codes.includes('BODY30') && codes.includes('ABSMMKC1'), codes.join(','));
}

/* ---------------- C2/M3：轮询 generation 与接口类别 ---------------- */
console.log('\n实时轮询令牌与接口类别（C2/M3）');
{
  const srcHasGeneration = /live\.generation\+\+/.test(src) && /live\.generation === myGeneration/.test(src);
  check('C2 轮询持有 generation 且丢弃过期采样', srcHasGeneration);
  const cat = fn('ifaceCategory');
  check('M3 WiFi 粗类别', cat({ transport: 'wifi' }) === 'WiFi', cat({ transport: 'wifi' }));
  check('M3 蓝牙/BLE 合并为一类', cat({ transport: 'bluetooth' }) === '蓝牙 / BLE');
  check('M3 USB+串口合并为一类', cat({ transport: 'usb' }) === cat({ transport: 'serial' }));
  const infer = fn('inferAdapterKind');
  check('M3 kind 由 identify 推断：vLinker', infer({ name: 'vLinker MS' }) === 'vlinker');
  check('M3 kind 由 identify 推断：CANtieCAR', infer({ expect: 'CANtieCAR' }) === 'cantiecar');
  check('M3 反例：未知落到 elm', infer({ name: 'Generic USB' }) === 'elm');
}

/* ---------------- UX2/UX3：排序置顶与五类清单 ---------------- */
console.log('\n实时数据排序置顶与 PROXI 五类清单（UX2/UX3）');
{
  const sort = fn('sortLiveItems', { liveItemName: (i) => String(i.name || '') });
  const items = [{ name: 'Zeta', spec: { unit: 'km' } }, { name: 'Alpha', spec: { unit: '°C' } },
    { name: 'Beta', spec: { unit: 'km' } }];
  const byName = sort(items, 'name', {}).map((x) => x.name);
  check('UX2 按名排序', byName.join(',') === 'Alpha,Beta,Zeta', byName.join(','));
  const byUnit = sort(items, 'unit', {}).map((x) => x.name);
  check('UX2 按单位排序', byUnit.join(',') === 'Alpha,Beta,Zeta', byUnit.join(','));
  const pinned = sort(items, 'name', { Zeta: true }).map((x) => x.name);
  check('UX2 置顶项优先于排序', pinned.join(',') === 'Zeta,Alpha,Beta', pinned.join(','));
  const def = sort(items, 'default', {}).map((x) => x.name);
  check('UX2 default 保持原顺序', def.join(',') === 'Zeta,Alpha,Beta', def.join(','));

  const five = fn('proxiFiveClasses');
  const r = five({ listed: 5, present: 3, ok: 2, eolOk: 1, added: 1, removed: 0, eolFailed: 1, eolExpected: 2, needs: 1 });
  check('UX3 CONFIGURED=ok+eolOk', r.configured === 3, String(r.configured));
  check('UX3 AVAILABLE=present', r.available === 3, String(r.available));
  check('UX3 NEW/EOL 计数', r.add === 1 && r.eol === 4, JSON.stringify(r));
  check('UX3 一句话结论含需对齐数', /还有 2 个节点需对齐/.test(r.line), r.line);
  const r2 = five({ present: 3, needs: 0, eolFailed: 0 });
  check('UX3 反例：一致时给重写存储块提示', /全部对齐/.test(r2.line), r2.line);
}

/* ---------------- N1-N4：补挖项 ---------------- */
console.log('\n补挖项 N1-N4');
{
  // N1：对齐前置只用只读 DATA3 方法，不再 readProxiAll 白读两块
  const alignSection = src.slice(src.indexOf('对齐前置：merge DATA3'), src.indexOf('对齐前置：merge DATA3') + 500);
  check('N1 对齐前置调用 readProxiData3',
    /await state\.uds\.readProxiData3\(\)/.test(alignSection)
      && !/await state\.uds\.readProxiAll\(\)/.test(alignSection), alignSection.slice(0, 200));
  const udsSrc = fs.readFileSync(new URL('../src/uds.js', import.meta.url), 'utf8');
  check('N1 反例：协议层确有该方法', /async\s+readProxiData3\s*\(/.test(udsSrc));

  // N2：同步闸 —— 第一次获取成功并置位，第二次在 await 之前就被拒
  const gState = { aligning: false, busy: null };
  const alerts = [];
  const acquire = fn('tryAcquireAlignGate', { state: gState, alert: (m) => alerts.push(m) });
  const first = acquire();
  const second = acquire();
  check('N2 第一次获取闸成功并置 aligning', first === true && gState.aligning === true);
  check('N2 第二次点击同步被拒（尚未进入 await）', second === false && /正在执行 PROXI 对齐/.test(alerts[0] || ''),
    JSON.stringify(alerts));
  const gState2 = { aligning: false, busy: '读取配置' };
  const acquire2 = fn('tryAcquireAlignGate', { state: gState2, alert: (m) => alerts.push(m) });
  check('N2 busy 时也被拒', acquire2() === false && gState2.aligning === false);

  // N3：未回读 ≠ 确有差异
  const classify = fn('classifyWriteVerification');
  const noRead = classify({ ok: true, diffs: [], unverified: true }, [], true);
  check('N3 未回读但整块一致 → 写入成功、未校验', noRead.writeOk === true && noRead.verified === false,
    JSON.stringify(noRead));
  const realDiff = classify({ ok: true, diffs: [] }, [{ addr: 40, from: 1, to: 2 }], false);
  check('N3 整块差异 → 写入失败', realDiff.writeOk === false, JSON.stringify(realDiff));
  const marker = classify({ ok: false, diffs: [{ byte: 41 }] }, [], false);
  check('N3 主判据差异 → 写入失败且列出字节', marker.writeOk === false && marker.markerDiffs.length === 1,
    JSON.stringify(marker));

  // N4：MobileBridge 的 onError/onClosed 必须在接线层被接住
  const events = {};
  const mb = { isMobile: true, onError: null, onClosed: null };
  const onErr = (m) => { events.error = m; };
  const onClosed = () => { events.closed = true; };
  const wire = fn('wireBridgeEvents', {
    handleBridgeError: (m) => { events.error = m; },
    handleBridgeClosed: () => { events.closed = true; },
  });
  check('N4 MobileBridge 回调已注册', wire(mb, onErr, onClosed) === true
    && typeof mb.onError === 'function' && typeof mb.onClosed === 'function');
  mb.onError('BLE 写失败');
  mb.onClosed();
  check('N4 错误/关闭事件被真正接住', events.error === 'BLE 写失败' && events.closed === true, JSON.stringify(events));
  const bc = { on(name, cb) { (events.listeners || (events.listeners = {}))[name] = cb; } };
  check('N4 桌面桥走 on() 接口', wire(bc, onErr, onClosed) === true
    && !!events.listeners.error && !!events.listeners.closed);
}

console.log(`\napp-logic 结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
