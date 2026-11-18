'use strict';
/**
 * G0 主链/通用/移动端门禁：A1–A6、C2/C3、Q1–Q6、M1–M4。
 * A1/A2/Q3/M2 走真实函数体执行；其余是 UI / 原生层契约检查，mode=static，
 * 明确「只验自身正确性，不称对齐」，避免把静态检查伪装成行为证据。
 */
import { assertion, readText, extractBlock, instantiate, runSafe, runSafeAsync, stable } from './verify-mes-lib.mjs';
import { Uds, DID } from '../src/uds.js';
import { Elm327 } from '../src/elm327.js';
import { BridgePort } from '../src/serial/port-adapter.js';
import { computeAlignment } from '../src/alignment.js';

const MES_A2 = 'mes54r2-src/--/--.cs:36940 后 22 40 AA；总纲 §1.3 A2（②级：不静默为目标）';

export async function run(ctx) {
  const out = [];
  const add = (item, name, ok, detail, evidence, mode) => out.push(assertion(item, name, ok, detail, evidence, mode));
  const app = readText(`${ctx.root}/app/app.js`);
  const swift = readText(`${ctx.root}/mobile/ios/App/App/MfiSerialPlugin.swift`);
  const mobile = readText(`${ctx.root}/mobile/src/mobile-bridge.js`);
  const server = readText(`${ctx.root}/bridge/server.js`);
  const elmSrc = readText(`${ctx.root}/src/elm327.js`);
  const detectSrc = readText(`${ctx.root}/src/serial/detect.js`);
  const adapterSrc = readText(`${ctx.root}/src/serial/port-adapter.js`);

  // ── A1：DATA3 必须双读且不一致时中止（DATA1 已双读）──────────────
  {
    const calls = { d1: 0, d3: 0 };
    const block = () => Uint8Array.from([0x41, 0x42, 0x43]);
    const state = {
      session: { bodyModule: 'BCM', async ensureModule() {} },
      uds: {
        async readProxi() { calls.d1++; return block(); },
        async readDataByIdentifier(did) { if (did === DID.DATA3) calls.d3++; return pattern(80, 2); },
      },
      modules: { alignmentNodes: [] },
    };
    const applyAlignment = instantiate(app, 'applyAlignment', { state, computeAlignment, log: () => {} });
    const refresh = instantiate(app, 'refreshAlignment', { state, DID, applyAlignment });
    await runSafeAsync(() => refresh({ log: false }), 'ERR');
    add('A1', 'DATA3_DOUBLE_READ', calls.d3 >= 2,
      `DATA1 读 ${calls.d1} 次 / DATA3 读 ${calls.d3} 次（DATA3 必须 >=2）`,
      'app/app.js:1297-1300 + 总纲 §1.3 A1');
  }

  // ── A2：22 40 AA 的失败不得被 .catch(()=>{}) 吞掉 ────────────────
  {
    const seen = [];
    const link = {
      async request(payload) {
        const p = Array.from(payload);
        seen.push(p);
        if (p[0] === 0x22 && p[1] === 0x40 && p[2] === 0xaa) throw new Error('故意让 22 40 AA 失败');
        return Uint8Array.from([0x62, 0x10, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      },
    };
    const uds = new Uds(link);
    const res = await runSafeAsync(() => uds.verifyProxi(new Uint8Array(289)), null);
    const rejected = !!res && Object.keys(res).some((k) => /marker|40aa|verifyMarker/i.test(k) && res[k] === false);
    add('A2', 'MARKER_22_40_AA_NOT_SWALLOWED', rejected,
      `22 40 AA 失败后结果=${res ? stable(res).slice(0, 160) : 'ERR'}（必须显式标记失败）`, MES_A2);
  }

  // ── A3：复检失败不得保留「✓对齐完成」────────────────────────────
  {
    const hasText = /复检失败|复检.*未知|写入完成.*复检/.test(app);
    add('A3', 'RECHECK_FAILURE_CHANGES_VERDICT', hasText,
      `app.js 复检失败改判文案存在=${hasText}`, '总纲 §1.3 A3（③扩展：流程正确性）', 'static');
  }

  // ── A5：选择性对齐必须逐节点回读存储块，不能只看位图 needs=0 ───────
  {
    const has = /存储块回读|readbacks?\s*block|逐节点.*回读/.test(app);
    add('A5', 'SELECTIVE_STORAGE_READBACK', has,
      `选择性对齐逐节点存储块回读=${has}`, '总纲 §1.3 A5（③扩展：只验自身正确性）', 'extension');
  }

  // ── A6：未回读节点不得计入「回读成功」统计 ───────────────────────
  {
    const has = /unverified/.test(app) && /verified|回读成功/.test(app);
    add('A6', 'UNVERIFIED_NOT_COUNTED_AS_VERIFIED', has,
      `app.js 区分 unverified 与已回读成功=${has}`, '总纲 §1.3 A6（②级：披露保留、统计不得混淆）', 'static');
  }

  // ── D3：无字典模块必须从读码/快照下拉排除 ───────────────────────
  {
    const has = /dtc\.json|dtcModules|hasDtcModule|dtcDict/.test(app.slice(app.indexOf('function rebuildModuleSelects'), app.indexOf('function rebuildModuleSelects') + 2500));
    add('D3', 'NO_DICT_MODULE_EXCLUDED', has,
      `rebuildModuleSelects 依 DTC 字典过滤=${has}`, '总纲 §1.2 D3', 'static');
  }

  // ── Q4：桥「启动成功」必须等 listening，端口占用要有回退或明确报错 ─
  {
    const listening = /listening/.test(server);
    const fallback = /8848|EADDRINUSE|端口占用|catch/.test(server);
    add('Q4', 'BRIDGE_LISTENING_SIGNAL', listening && fallback,
      `WSS listening 事件=${listening}，占用回退/报错=${fallback}`, '总纲 §1.5 Q4', 'static');
  }

  // ── Q3：桥写失败必须被协议层监听，不能 emit 个没人听的 error ──────
  {
    const bridge = { onData: null, writeHex() { return Promise.reject(new Error('写失败')); } };
    const port = new BridgePort(bridge);
    new Elm327(port, { log: () => {} });
    const listeners = (port._h && port._h.error) ? port._h.error.length : 0;
    add('Q3', 'BRIDGE_WRITE_ERROR_SURFACED', listeners > 0,
      `Elm327 构造后在 BridgePort 上注册的 error 监听数=${listeners}（必须 >0）`,
      'src/serial/port-adapter.js:27 + 总纲 §1.5 Q3');
  }

  // ── Q5：latencyTest 的写必须 await；test() 失败路径必须关端口 ──────
  {
    const awaited = /await\s+this\.bridge\.writeText\s*\(/.test(detectSrc);
    const finallyClose = /finally\s*\{[\s\S]{0,200}bridge\.close/.test(detectSrc);
    add('Q5', 'LATENCY_WRITE_AWAITED', awaited, `await bridge.writeText=${awaited}`, '总纲 §1.5 Q5', 'static');
    add('Q5', 'TESTER_PORT_CLOSED', finallyClose, `try/finally close=${finallyClose}`, '总纲 §1.5 Q5', 'static');
  }

  // ── Q6：单一 error 监听 + 流控应答 ID 补齐 8 位 ───────────────────
  {
    const dup = (server.match(/sp\.on\('error'/g) || []).length;
    add('Q6', 'SERIAL_ERROR_LISTENER_SINGLE', dup <= 1,
      `bridge/server.js 上 sp.on('error') 数量=${dup}（必须 <=1）`, '总纲 §1.5 Q6', 'static');
    const padded = /padStart\s*\(\s*8\s*,\s*['"]0['"]\s*\)/.test(elmSrc);
    add('Q6', 'FLOW_CONTROL_ID_PADDED', padded,
      `src/elm327.js 中 respId 8 位补零=${padded}`, '总纲 §1.5 Q6', 'static');
  }

  // ── Q1：test-agent1 失败必须真 exit 1 ─────────────────────────────
  {
    let bad = 0; let checked = 0;
    for (const f of ctx.listFiles('test-agent1', /\.mjs$/)) {
      const s = readText(`${ctx.root}/test-agent1/${f}`);
      if (!s) continue;
      checked++;
      if (/process\.exit\(0\)/.test(s) && !/process\.exit\(1\)/.test(s)) bad++;
    }
    add('Q1', 'E2E_FAILURE_NOT_FORCED_GREEN', checked > 0 && bad === 0,
      `test-agent1 脚本 ${checked} 份，仅无条件 exit(0) 的 ${bad} 份（必须 0）`,
      '总纲 §1.5 Q1', 'static');
  }

  // ── Q2 / C2 / C3：入口即置 busy、轮询 generation、SGW 写路径 merge ─
  add('Q2', 'BUSY_SET_BEFORE_AWAIT', /async\s+function\s+connect[\s\S]{0,600}?state\.busy\s*=/.test(app),
    'connect() 入口 600 字符内置 state.busy', '总纲 §1.5 Q2', 'static');
  add('C2', 'LIVE_POLL_GENERATION_TOKEN', /generation|pollToken|runId/.test(app),
    '实时轮询存在 generation/token 丢弃旧采样', '总纲 §1.4 C2（③扩展）', 'extension');
  add('C3', 'SGW_BYPASS_WRITE_MERGES_DATA3', /mergeData3/.test(app.slice(app.indexOf('async function writeToEcu'), app.indexOf('async function writeToEcu') + 4000)),
    'writeToEcu 路径含 mergeData3', '总纲 §1.4 C3', 'static');

  // ── M2：真执行 MobileBridge.autoConnect（当前必须不存在 → 红）─────
  {
    let ok = false; let detail = 'autoConnect 不可执行';
    const cls = extractBlock(mobile, /class\s+MobileBridge\s*\{/);
    if (cls) {
      const MobileBridge = new Function(cls.replace(/^class\s+MobileBridge/, 'class MobileBridge') + '\nreturn MobileBridge;')();
      const mb = new MobileBridge();
      const res = await runSafeAsync(() => mb.autoConnect({ candidates: [] }), null);
      ok = !!res && res.ok === false;
      detail = `autoConnect 返回=${stable(res)}（必须给出明确失败结果，而不是 TypeError）`;
    }
    add('M2', 'AUTOCONNECT_EXECUTABLE', ok, detail,
      '总纲 §4.3 M2（③扩展：MES iOS 为①级机制证据，具体数值不许照抄）', 'extension');
  }

  // ── M1 / M3 / M4：原生与接线层契约 ────────────────────────────────
  {
    const noFirst = !/protocolStrings\.first/.test(swift);
    const white = /com\.obdlink|com\.vgatemall/.test(swift);
    add('M1', 'MFI_PROTOCOL_WHITELIST', noFirst && white,
      `Swift 不再用 .first=${noFirst}，白名单包含 MES 两串=${white}`,
      '总纲 §4.3 M1 / MES iOS Info.plist', 'static');
  }
  {
    const hasBranch = /autoConnect\s*\(/.test(app);
    add('M3', 'CONNECT_AUTO_BRANCH', hasBranch,
      `根 app.js 的 connect 消费 autoConnect=${hasBranch}`, '总纲 §4.3 M3', 'static');
  }
  {
    const neutral = !/ea:|ble:|tcp:/.test(elmSrc);
    add('M4', 'TRANSPORT_LAYER_UNCHANGED', neutral,
      `src/elm327.js 不含传输层细节=${neutral}`, '总纲 §4.3 M4（三种传输都进 AT 层）', 'static');
  }

  return out;
}

function pattern(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = (x >>> 16) & 0xff; }
  return out;
}
