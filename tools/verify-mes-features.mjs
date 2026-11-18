'use strict';
/**
 * G0 特殊功能门禁：S1–S7。
 * S1/S2/S5/S6 从 **app/app.js 真实源码**切出函数体编译后真跑（假时钟 + 假串口），
 * S3/S4/S7 是 UI/数据层契约检查，明确标 mode=static，不冒充行为证据。
 */
import { assertion, fakeClock, readJson, readText, instantiate, runSafe, runSafeAsync, stable } from './verify-mes-lib.mjs';
import { hexToBytes } from '../src/elm327.js';
import { isRoutineBusy } from '../src/uds.js';
import { NRC } from '../src/uds.js';

const MES_S1 = 'mes54r2-src/--/--.cs:4622-4681';
const MES_S2 = 'mes54r2-src/--/--.cs:4586-4610';
const MES_S5 = 'mes54r2-src/--/--.cs:4689,4696-4712';
const MES_S4 = 'mes54r2-src/--/--.cs:4646-4679';

function makeHarness() {
  const clock = fakeClock();
  const requests = [];
  const link = {
    async request(payload) {
      const p = Array.from(payload);
      requests.push(p);
      if (p[0] === 0x31 && p[1] === 0x03) return Uint8Array.from([0x71, 0x03, ...p.slice(2)]);
      if (p[0] === 0x31) return Uint8Array.from([0x71, p[1], ...p.slice(2)]);
      return Uint8Array.from([0x62, 0xf1, 0xb0, 0xaa]);
    },
  };
  const state = { link, modules: { alignmentNodes: [] }, busy: null };
  return { clock, requests, state };
}

export async function run(ctx) {
  const out = [];
  const add = (item, name, ok, detail, evidence, mode) => out.push(assertion(item, name, ok, detail, evidence, mode));
  const app = readText(`${ctx.root}/app/app.js`);
  if (!app) {
    add('S1', 'APP_SOURCE_PRECONDITION', false, 'app/app.js 读不到（这不是前置缺失，是仓库缺陷）', 'G0 自有前置', 'static');
    return out;
  }

  const depsForRun = (h) => ({
    state: h.state, hexToBytes, isRoutineBusy, NRC, fnAbort: false,
    setTimeout: h.clock.setTimeout, Date: h.clock.Date,
    confirm: () => true, stage: () => {}, log: () => {}, alert: () => {},
    $: () => ({ textContent: '', className: '', classList: { add() {}, remove() {} } }),
  });

  const runCmd = async (cmdStr, item, h) => {
    const fn = instantiate(app, 'runCommandString', depsForRun(h));
    return await fn(cmdStr, item);
  };

  // ── S1：FUNC 只发 commands[0] + 自造 31 03 轮询（不得发 commands[1..n]）──
  {
    const h = makeHarness();
    const item = { resultFormat: 'FUNC', commands: '0431012000,0631022001FF,0431032000' };
    await runSafeAsync(() => runCmd(item.commands, item, h), 'ERR');
    const starts = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x01).length;
    const stops = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x02).length;
    const polls = h.requests.filter((p) => p[0] === 0x31 && p[1] === 0x03).length;
    add('S1', 'FUNC_ONLY_FIRST_COMMAND', starts === 1 && stops === 0 && polls >= 1,
      `31 01=${starts}（必须 1） 31 02=${stops}（必须 0） 31 03=${polls}（必须 >=1）`, MES_S1);
  }

  // ── S2：0.5SEC / 1SEC 不乘沉降倍数（仅 num>1000 才乘）──────────────
  for (const [flag, expectedMs] of [['0.5SEC', 500], ['1SEC', 1000]]) {
    const h = makeHarness();
    const item = { resultFormat: flag, commands: '0431012000' };
    await runSafeAsync(() => runCmd(item.commands, item, h), 'ERR');
    const waited = h.clock.delays.reduce((a, b) => a + b, 0);
    add('S2', `INTERVAL_${flag.replace('.', '')}_NO_MULTIPLIER`, waited > 0 && waited <= expectedMs * 1.1,
      `${flag} 单命令累计等待≈${Math.round(waited)}ms（必须≈${expectedMs}ms，不得×5）`, MES_S2);
  }

  // ── S6：5SEC 的权威值是结构化字段 intervalMs === 5000（不是旗标文本，也不是近似等待）──
  {
    const data = readJson(`${ctx.root}/src/data/functions.json`);
    let exact5000 = 0; let flagged5000 = 0;
    const walk = (v) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        if (v.intervalMs === 5000) { exact5000++; if (/5SEC/i.test(v.resultFormat || '')) flagged5000++; }
        Object.values(v).forEach(walk);
      }
    };
    walk(data);
    add('S6', 'INTERVAL_MS_FIELD_EXACT_5000', exact5000 > 0 && exact5000 === flagged5000,
      `结构化 intervalMs===5000 的条目=${exact5000}，其中带 5SEC 旗标=${flagged5000}（必须相等且 >0；精确相等，不用容差）`,
      'src/data/functions.json（build-functions.cjs:61 解析 5SEC=5000）+ 总纲 §1.1 S6', 'extension');
  }
  {
    // 只给 intervalMs、故意不给 5SEC 旗标：若仍绿，说明运行时真消费了结构化字段，
    // 而不是从 resultFormat 文本重新解析。假时钟按 ms 前进，累计值是精确量。
    const h = makeHarness();
    const item = { resultFormat: 'PROBE_ONLY', commands: '0431012000', intervalMs: 5000 };
    await runSafeAsync(() => runCmd(item.commands, item, h), 'ERR');
    const waited = h.clock.delays.reduce((a, b) => a + b, 0);
    const expected = 25000;   // MES：num>1000 时 基准 + 4×基准 = 5×5000（单命令）
    add('S6', 'INTERVAL_MS_CONSUMED_EXACT', waited === expected,
      `旗标串不含 5SEC、仅给 intervalMs=5000 时累计等待=${waited}（必须精确 ${expected}；若仍取默认 2000 会是 10000）`,
      'mes54r2-src/--/--.cs:4586-4610（num>1000 加 4×num）+ 总纲 §1.1 S6', 'extension');
  }

  // ── S5：读改写基线取读命令 DID，不是写模板 DID ───────────────────
  {
    const readDids = [];
    const state = { uds: { async readDataByIdentifier(did) { readDids.push(did); return Uint8Array.from([0xaa]); } } };
    const mergeWriteField = instantiate(app, 'mergeWriteField', {});
    const mergeRw = instantiate(app, 'mergeRwUserEntry', { state, hexToBytes, mergeWriteField });
    const item = { commands: '0322F1B0,042EF190AA', input: { kind: 'hex' } };
    const result = await runSafeAsync(() => mergeRw(item, { value: 'AA' }), 'ERR');
    add('S5', 'RWUSERENTRY_READ_DID_BASELINE', readDids.length === 1 && readDids[0] === 0xf1b0 && result !== 'ERR',
      `实读 DID=0x${readDids[0] ? readDids[0].toString(16).toUpperCase() : 'ERR'}（必须 F1B0；写模板 DID F190 不能拿来读）`, MES_S5);
  }

  // ── S4：BitResults 映射必须在源码里真存在（③级里混着的①级缺口）──
  {
    const hasMap = /BitResults|_0091/.test(app) && /Completed correctly|完成正确|温度|油位/.test(app);
    add('S4', 'BITRESULTS_DECODE_PRESENT', hasMap,
      `app.js 中 BitResults 映射=${hasMap}（必须 true：结果不能只显示裸 FF00）`, MES_S4, 'static');
  }

  // ── S3：并发闸与按钮禁用必须在第一个 await 之前 ──────────────────
  {
    const awaitAt = app.indexOf('await state.uds.securityAccess');
    const gate = app.lastIndexOf('if (operationBlocked()) return;', awaitAt > 0 ? awaitAt : 0);
    const disableAt = app.lastIndexOf('b.disabled = true', awaitAt > 0 ? awaitAt : 0);
    const ok = gate > 0 && awaitAt > gate && disableAt > gate && disableAt < awaitAt;
    add('S3', 'CONCURRENCY_GATE_BEFORE_AWAIT', ok,
      `gate@${gate} disable@${disableAt} await@${awaitAt}（必须 gate < disable < await；从 await 位置向前找最近的 disable）`,
      '总纲 §1.1 S3（③扩展：我方并发，不称对齐）', 'extension');
  }

  // ── S7：execManual 不许留在数据里当死字段 ────────────────────────
  {
    const data = readJson(`${ctx.root}/src/data/functions.json`);
    let withField = 0;
    const walk = (v) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        if ('execManual' in v) withField++;
        Object.values(v).forEach(walk);
      }
    };
    walk(data);
    // 不能只数源码里出现了几次 execManual：注释和一次性赋值也算。
    // 真判据：在「特殊功能按钮 click handler」内，有 item.execManual === true 的分支，
    // 且该分支 600 字符内出现 prompt( 与 return null（操作者能选 Abort 不发帧）。
    const at = app.indexOf('item.execManual === true');
    const handler = app.lastIndexOf("b.addEventListener('click', async () => {", at > 0 ? at : 0);
    const seg = at > 0 ? app.slice(at, at + 600) : '';
    const inPath = at > 0 && handler > 0 && handler < at
      && /prompt\s*\(/.test(seg) && /return null/.test(seg);
    add('S7', 'EXEC_MANUAL_NOT_DEAD', withField === 0 || inPath,
      `数据含 execManual 的条目=${withField}；执行路径内分支=${inPath}`
      + `（app.js:${app.slice(0, Math.max(0, at)).split('\n').length}，click handler@${handler}；`
      + `必须 prompt + return null，只出现在注释/赋值不算）`,
      '总纲 §1.1 S7（③扩展：MES 确有 EXECMANUAL 语义）', 'extension');
  }

  return out;
}
