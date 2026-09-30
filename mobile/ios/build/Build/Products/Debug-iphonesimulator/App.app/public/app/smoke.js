/**
 * 移动端内置 e2e 自检（沙箱验收链路）。
 * 触发：www/app/.smoke-flag（sync-web --smoke 写入）或 ?smoke=1。
 * 输出：console 打 [SMOKE] PASS/FAIL 行，由 mobile/scripts/smoke-sim.sh
 * 通过 simctl log stream / adb logcat 收集聚合。
 *
 * 链路（镜像 test-agent1 的 §九 判据）：
 *   connect → read config（CRC 自洽）→ 写入→读回一致
 *   → 反向：改配置后未对齐应「里程表会闪烁」
 *   → 正向：全部对齐后应「整车对齐正常」
 */
import { Elm327 } from '../src/elm327.js';
import { Uds } from '../src/uds.js';
import { Session } from '../src/session.js';
import { ProxiBlock } from '../src/proxi.js';
import { BridgePort } from '../src/serial/port-adapter.js';
import { BridgeClient } from '../src/serial/bridge-client.js';

const results = [];
const out = (line) => { console.log(line); try { /* 某些 WebView 只收 console */ } catch {} };
const check = (step, ok, info) => {
  results.push({ step, ok, info });
  out(`[SMOKE] ${ok ? 'PASS' : 'FAIL'} step=${step}${info ? ' | ' + info : ''}`);
};

async function main() {
  const wantSmoke = /[?&]smoke=1/.test(location.search) ||
    await fetch('./.smoke-flag').then((r) => r.ok).catch(() => false);
  if (!wantSmoke) return;

  out('[SMOKE] 开始，UA=' + navigator.userAgent.slice(0, 60));

  // 平台地址：Android 模拟器经 10.0.2.2 访问宿主机；iOS 模拟器共享宿主网络
  const isAndroid = /Android/i.test(navigator.userAgent);
  const m = /[?&]smokeHost=([^&]+)/.exec(location.search);
  const host = m ? decodeURIComponent(m[1]) : (isAndroid ? '10.0.2.2' : '127.0.0.1');
  const port = 35001;
  out(`[SMOKE] 目标 sandbox ${host}:${port}`);

  const readJson = (p) => fetch(p).then((r) => r.json());

  // ---- 传输 ----
  let bridge;
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    const { MobileBridge } = await import('./vendor/mobile-bridge.js');
    bridge = new MobileBridge();
  } else {
    bridge = new BridgeClient();
    await bridge.connect();
  }
  await bridge.tcpOpen(host, port);

  const link = new Elm327(new BridgePort(bridge), {
    adapter: 'vlinker-ms',
    log: (m2) => out('  · ' + m2),
  });
  await link.init({ protocol: 8 });
  check('connect', true, 'ELM 初始化完成');

  const [mods, named] = await Promise.all([readJson('../src/data/modules.json'), readJson('../src/data/named-settings.json')]);
  const cables = await readJson('../src/data/cables.json');
  const uds = new Uds(link);
  const session = new Session(link, { cables, platform: '952', log: () => {} });
  session.on('cableRequired', (e) => session.confirmCable());
  await session.ensureModule(session.bodyModule);

  // ---- 读配置 ----
  const d1 = await uds.readProxi();
  const block = new ProxiBlock(d1);
  check('read', block.verify().ok, `读取 ${d1.length} 字节，CRC ${block.verify().ok ? '自洽' : '异常'}`);

  // ---- 写入→读回一致 ----
  const st = named.settings[0];
  const cur = block.getByte(st.startByte) & st.mask;
  const opt = st.options.find((o) => o.value !== cur) || st.options[0];
  const before = block.getByte(st.startByte);
  const after = (before & ~st.mask) | (opt.value & st.mask);
  block.setByte(st.startByte, after);
  block.seal();
  await uds.writeProxi(block.bytes);
  const back = new ProxiBlock(await uds.readProxi());
  const diff = back.diff(block);
  check('write-roundtrip', diff.length === 0, diff.length ? `差异 ${diff.length} 处` : `Byte${st.startByte} ${before.toString(16)}→${after.toString(16)} 读回一致`);

  // ---- 对齐判定（22 10 2A 主判据，镜像 drive.mjs checkAlignment）----
  const nodes = mods.alignmentNodes.filter((n) => !n.excluded);
  const absentSet = new Set();   // 写入被拒（NRC 0x31）= 未安装节点，不计未对齐（与 drive.mjs 一致）
  const checkAlign = async () => {
    await session.ensureModule(session.bodyModule);
    const refBytes = await uds.readProxi();
    const ref = await uds.readProxiWriteCounter();
    let misaligned = 0, failed = 0, absent = 0;
    for (const n of nodes) {
      if (absentSet.has(n.name)) { absent++; continue; }
      try {
        await session.connectNode(n);
        const v = await uds.verifyProxi(refBytes);
        const c = await uds.readProxiWriteCounter();
        if (!(v.ok && c === ref)) misaligned++;
      } catch { failed++; }
    }
    return { misaligned, failed, absent,
      verdict: misaligned === 0 && failed === 0
        ? `整车对齐正常，无里程表闪烁（未安装 ${absent} 个不计）`
        : `有 ${misaligned} 个模块未对齐 → 里程表会闪烁${failed ? `（另有 ${failed} 个读取失败）` : ''}` };
  };

  // 反向：改了配置（仅车身电脑）→ 其它模块未对齐 → 应闪
  const r1 = await checkAlign();
  check('odometer-negative', r1.misaligned > 0 || r1.failed > 0, r1.verdict);

  // 正向：全部对齐（写入被拒 NRC 0x31 的记为未安装）→ 不应闪
  for (const n of nodes) {
    try {
      await session.connectNode(n);
      await uds.writeProxi(block.bytes);
    } catch (e) {
      if (e && e.nrc === 0x31) absentSet.add(n.name);
    }
  }
  const r2 = await checkAlign();
  check('odometer-positive', r2.misaligned === 0, r2.verdict);

  const fail = results.filter((r) => !r.ok).length;
  out(`[SMOKE] 结果 ${results.length - fail}/${results.length} 通过`);
  out(fail ? '[SMOKE] ALL FAIL' : '[SMOKE] ALL PASS');
}

main().catch((e) => {
  check('fatal', false, (e && e.message) || String(e));
  out('[SMOKE] ALL FAIL');
});
