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
    // auxCheck.at 是 epoch 毫秒，每次运行都变：**不许进指纹**。
    // 这里先就地打码，runner 里还有一层通用 scrub 兜底（见 align-mes.mjs）。
    const shown = res && typeof res === 'object'
      ? stable({ ...res, ...(res.auxCheck ? { auxCheck: { ...res.auxCheck, at: '<epoch>' } } : {}) })
      : String(res);
    add('A2', 'MARKER_22_40_AA_NOT_SWALLOWED', rejected,
      `22 40 AA 失败后结果=${shown.slice(0, 160)}（必须显式标记失败）`, MES_A2);
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

  // ── M2：真执行 MobileBridge.autoConnect（按真实 opts 契约注入钩子）──
  // 真实签名：const { listPorts=()=>this.listPorts(), connect=..., identify=... } = opts;
  // candidates **不是** opts 字段；旧夹具传 {candidates:[]} 会走真实 listPorts() 抛错而假红。
  {
    const cls = extractBlock(mobile, /class\s+MobileBridge\s*\{/);
    if (!cls) {
      add('M2', 'AUTOCONNECT_EXECUTABLE', false, '无法从 mobile-bridge.js 提取 MobileBridge 类',
        '总纲 §4.3 M2', 'extension');
    } else {
      const MobileBridge = new Function('log', cls + '\nreturn MobileBridge;')(() => {});
      const mk = () => new MobileBridge();

      // 负向：无候选必须抛明确错误（不是返回 {ok:false}，也不是 TypeError）
      const neg = await runSafeAsync(async () => {
        await mk().autoConnect({ listPorts: async () => [] });
        return null;
      }, 'THREW');
      // 用显式捕获拿错误文案，避免把 Error 对象字符串化出栈信息
      let negMsg = '';
      try { await mk().autoConnect({ listPorts: async () => [] }); }
      catch (e) { negMsg = String(e && e.message ? e.message : e); }
      const negativeOk = neg === 'THREW' && /OBD interface not detected!/.test(negMsg);

      // 正向：坏/好两个候选，按 MFi 优先锁定第一个识别成功的
      let pos = null;
      try {
        pos = await mk().autoConnect({
          listPorts: async () => [
            { path: 'spp:BAD', friendly: 'BAD' },
            { path: 'ea:GOOD|com.obdlink', friendly: 'GOOD' },
          ],
          connect: async () => {},
          identify: async (spec) => (spec.name === 'GOOD' ? { ok: true, kind: 'mfi', name: 'GOOD' } : { ok: false }),
        });
      } catch { pos = null; }
      const positiveOk = !!pos && pos.ok === true && pos.path === 'ea:GOOD|com.obdlink';

      add('M2', 'AUTOCONNECT_EXECUTABLE', negativeOk && positiveOk,
        `空候选错误文案=${JSON.stringify(negMsg)}（必须含 OBD interface not detected!）`
        + `；坏/好候选锁定=${pos ? pos.path : 'null'}（必须 ea:GOOD|com.obdlink）`,
        '总纲 §4.3 M2 + mobile/src/mobile-bridge.js:462-505', 'extension');
    }
  }

  // ── M1 / M3 / M4：原生与接线层契约 ────────────────────────────────
  {
    // 先剥 Swift 注释：M1 的修复说明本身就写着「不再静默用 acc.protocolStrings.first」，
    // 直接 grep 全文会把「说明已修复的注释」当成「仍在用」—— 典型假红。
    const code = swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const usesFirst = /=\s*acc\.protocolStrings\.first\b/.test(code);
    const white = /com\.obdlink|com\.vgatemall/.test(code);
    const ordered = /topPriority/.test(code) && /declared/.test(code);
    add('M1', 'MFI_PROTOCOL_WHITELIST', !usesFirst && white && ordered,
      `剥注释后代码里 =acc.protocolStrings.first=${usesFirst}（必须 false）`
      + `，白名单含 MES 两串=${white}，优先级表=${ordered}（必须全 true）`,
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

  // ── §7 补挖项 N1–N5：全部真执行（N5 是文档口径，标静态契约）──────
  {
    // N1：readProxiData3 只请求一次 DATA3；readProxiAll 仍三次且顺序不变
    const seen = [];
    const fake = Object.create(Uds.prototype);
    fake.readDataByIdentifier = async (did) => { seen.push(did); return Uint8Array.from([0xaa, 0xbb]); };
    await fake.readProxiData3();
    const once = [...seen];
    seen.length = 0;
    await fake.readProxiAll();
    const thrice = [...seen];
    const ok = once.length === 1 && once[0] === DID.DATA3
      && thrice.length === 3 && thrice[0] === DID.PROXI_DATA1 && thrice[1] === DID.DATA2 && thrice[2] === DID.DATA3;
    add('N1', 'READ_PROXI_DATA3_SINGLE_DID', ok,
      `readProxiData3 DID=${JSON.stringify(once)}（必须仅 DATA3）；readProxiAll=${JSON.stringify(thrice)}（必须 DATA1,DATA2,DATA3）`,
      'mes55-knowledge-pack/docs/05-protocol.md:75,77', 'behavior');
  }

  {
    // N2：同步闸真跑两次（第二次必须 false），且调用点在 btnAlign handler 的第一个 await 之前
    const state = { aligning: false, busy: null };
    let alerts = 0;
    const gate = instantiate(app, 'tryAcquireAlignGate', { state, alert: () => { alerts++; } });
    const first = runSafe(() => gate(), null);
    const locked = state.aligning === true;
    const second = runSafe(() => gate(), null);
    const clickAt = app.indexOf("$('btnAlign').addEventListener");
    const gateAt = app.indexOf('tryAcquireAlignGate()', clickAt > 0 ? clickAt : 0);
    const awaitAt = app.indexOf('await ensureRead()', clickAt > 0 ? clickAt : 0);
    const beforeAwait = clickAt > 0 && gateAt > clickAt && awaitAt > gateAt;
    add('N2', 'ALIGN_GATE_SYNC_BEFORE_AWAIT', first === true && second === false && locked && alerts === 1 && beforeAwait,
      `首次=${first} 二次=${second}（必须 true/false） state.aligning=${locked} alert=${alerts}（必须 1）`
      + ` gate@${gateAt} await@${awaitAt}（必须 gate 在 await 前）`,
      '总纲 §7 N2（③扩展：只验自身正确性，不称对齐）', 'extension');
  }

  {
    // N3：写后校验三态真跑 classifyWriteVerification
    const classify = instantiate(app, 'classifyWriteVerification', {});
    const r1 = runSafe(() => classify({ ok: true, diffs: [] }, [], true), null);
    const r2 = runSafe(() => classify({ ok: true, diffs: [] }, [{ addr: 12, from: 1, to: 2 }], false), null);
    const marker = { byte: 12, xorMask: 3, got: 1, want: 2 };
    const r3 = runSafe(() => classify({ ok: false, diffs: [marker] }, [], false), null);
    const ok = !!r1 && r1.writeOk === true && r1.verified === false
      && !!r2 && r2.writeOk === false
      && !!r3 && r3.writeOk === false && r3.markerDiffs.length === 1 && r3.markerDiffs[0].byte === 12;
    add('N3', 'WRITE_VERIFICATION_THREE_STATES', ok,
      `未回读一致=${stable(r1)}（writeOk=true/verified=false） 整块差异=${stable(r2)}（writeOk=false）`
      + ` 主判据差异=${stable(r3)}（false 且列 byte12）`,
      '总纲 §7 N3（②级：未回读≠有差异）', 'behavior');
  }

  {
    // N4：wireBridgeEvents 真跑两种传输；handleBridgeClosed 真跑可见回调
    const seen = { error: null, closed: null };
    const wire = instantiate(app, 'wireBridgeEvents', {});
    const mobileBridge = { isMobile: true, onError: null, onClosed: null };
    const wiredMobile = runSafe(() => wire(mobileBridge, (m) => { seen.error = m; }, () => { seen.closed = true; }), null);
    mobileBridge.onError('boom');
    mobileBridge.onClosed();
    const mobileErr = seen.error;
    const listeners = {};
    const desktopBridge = { on: (ev, cb) => { listeners[ev] = cb; } };
    const wiredDesktop = runSafe(() => wire(desktopBridge, () => { seen.error = 'desktop-error'; }, () => { seen.closed = true; }), null);
    if (listeners.error) listeners.error('desk-boom');
    const st = { connected: true };
    let reports = 0;
    const onClosed = instantiate(app, 'handleBridgeClosed', { state: st, reportTransportLost: () => { reports++; } });
    onClosed();
    const ok = wiredMobile === true && mobileErr === 'boom' && seen.closed === true
      && wiredDesktop === true && seen.error === 'desktop-error' && reports === 1;
    add('N4', 'BRIDGE_EVENTS_SURFACED', ok,
      `mobile接线=${wiredMobile} 桌面接线=${wiredDesktop} mobileErr=${JSON.stringify(mobileErr)} error=${JSON.stringify(seen.error)}`
      + ` closed=${seen.closed} 未连接回调=${reports}（必须 1）`,
      '总纲 §7 N4 / MES iOS EAAccessoryManager 事件机制', 'behavior');
  }

  {
    // N5：README 的五个数字是文档口径，静态精确核对即可（不冒充行为断言）
    const readme = readText(`${ctx.root}/README.md`);
    const pairs = [[91, /91\s*个源节点/], [77, /77\s*个/], [40, /40\s*个模块定义/],
      [38, /38\s*个模块/], [4305, /4305\s*条/]];
    const miss = pairs.filter(([, re]) => !re.test(readme)).map(([n]) => n);
    add('N5', 'README_DOC_NUMBERS', miss.length === 0,
      `README 五数 91/77/40/38/4305 缺失=${JSON.stringify(miss)}（必须 []）`,
      'README.md:93-94（文档口径）', 'static');
  }

  return out;
}

function pattern(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = (x >>> 16) & 0xff; }
  return out;
}
