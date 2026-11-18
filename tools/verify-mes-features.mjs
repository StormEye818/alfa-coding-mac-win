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

  // ── S6：5SEC 旗标必须被解析，不得落回 2s 默认 ────────────────────
  {
    const h = makeHarness();
    const item = { resultFormat: '5SEC', commands: '0431012000' };
    await runSafeAsync(() => runCmd(item.commands, item, h), 'ERR');
    const waited = h.clock.delays.reduce((a, b) => a + b, 0);
    add('S6', 'FLAG_5SEC_PARSED', waited >= 5000 * 0.8,
      `5SEC 单命令累计等待≈${Math.round(waited)}ms（必须≈5000ms，2s 默认算未解析）`,
      'mes55-knowledge-pack 5.5 字符串表 + 总纲 §1.1 S6（③扩展：MES 5.4 无 5SEC）', 'extension');
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
    const runtimeUses = (app.match(/execManual/g) || []).length;
    add('S7', 'EXEC_MANUAL_NOT_DEAD', withField === 0 || runtimeUses > 0,
      `数据含 execManual 的条目=${withField}，运行时引用=${runtimeUses}（不得只写不读）`,
      '总纲 §1.1 S7（③扩展）', 'extension');
  }

  return out;
}
