/**
 * AlfaProxi 界面逻辑。
 *
 * 流程：
 *   连接适配器 → 连接目标 ECU（必要时提示换适配线）→ 读取配置 → 显示当前值
 *   → 修改 → 写入 → 读回校验
 *
 * 模拟模式下适配器为 MockAdapter，同样走完整链路，便于验证流程与交互。
 */
import { ProxiBlock, CRC_OFFSET, CRC_DIGITS } from '../src/proxi.js';
import { applyScale, snapshotValue } from '../src/scale.js';
import { Elm327, hexToBytes } from '../src/elm327.js';
import { Uds, NRC, isRoutineBusy, DID } from '../src/uds.js';
import { computeAlignment, ALIGN_STATUS_LABEL } from '../src/alignment.js';
import { buildVehicleProfile, ENGINE_LABELS } from '../src/vehicle-profile.js';
import { DemoLink } from '../src/demo-link.js';
import { BridgeClient } from '../src/serial/bridge-client.js';
import { InterfaceTester } from '../src/serial/detect.js';
import { BridgePort } from '../src/serial/port-adapter.js';
import { Session } from '../src/session.js';

const $ = (id) => document.getElementById(id);

/** 记住用户刚点的按钮，换线提示就浮动在它旁边 */
let anchorEl = null;
function rememberAnchor(e) {
  const b = e && e.target && e.target.closest ? e.target.closest('button') : null;
  if (b && b.id !== 'cableOk') anchorEl = b;
}
document.addEventListener('click', rememberAnchor, true);

/**
 * 换线提示：固定在视口底部，滚动到任何位置都能看到。
 * 同时给 body 加底部预留，不遮挡页面内容。
 */
function showCableHint(hint) {
  const bar = $('cableBanner');
  $('cableHint').textContent = hint;
  bar.classList.add('show');
  document.body.classList.add('cable-active');
}
function hideCableHint() {
  $('cableBanner').classList.remove('show');
  document.body.classList.remove('cable-active');
}
const state = {
  features: null, modules: null, named: null, funcs: null,
  cables: null, i18n: null,
  block: null, baseline: null,
  selected: new Map(),          // featureId -> optionIndex|null
  namedPicks: new Map(),        // settingName -> {byte, mask, value}
  writeState: new Map(),        // 'named:X' / 'feat:Y' -> 'pending'|'written'|'failed'
  link: null, uds: null, session: null,
  connected: false, readDone: false, simMode: false,
  vin: null,                    // 车身电脑 VIN（仅日志/诊断用）
  data3: null,                  // DID 0x40A2（对齐状态位图来源）
  alignment: null,              // computeAlignment() 结果
  profile: null,                // 本车画像（vehicle-profile.js），用于过滤模块清单
  engineOverride: '',           // 用户手动指定的发动机版本（按 VIN 记住）
  showAllModules: false,        // 模块清单是否显示本车未配置的模块
  aligning: false,
  busy: null,                   // 长任务（对齐状态扫描等）并发闸：非 null = 正在跑的任务名
  bitEditIndex: null,
  ifaces: null, bridge: null, tester: null,
};

/* ================= 术语 ================= */
function t(name) {
  const d = state.i18n && (state.i18n.terms[name] || state.i18n.options[name] || state.i18n.modules[name]);
  return d ? d.zh : name;
}
/** 功能说明：查中译，未命中回退原文 */
function tdesc(d) {
  if (!d) return '';
  const m = state.i18nDesc && state.i18nDesc.desc;
  return (m && m[d]) || d;
}

function tSpan(name) {
  const d = state.i18n && (state.i18n.terms[name] || state.i18n.options[name] || state.i18n.modules[name]);
  return d && d.zh !== name ? `<span title="${name}">${d.zh}</span>` : `<span>${name}</span>`;
}
/** 大小写不敏感的多字段搜索 */
function hit(q, ...fields) {
  if (!q) return true;
  const k = q.trim().toLowerCase();
  return fields.some((f) => String(f ?? '').toLowerCase().includes(k));
}

/** 字节统一显示为两位大写十六进制（不带 0x） */
/** 16 位值（CRC）显示为四位大写十六进制 */
function hex16(v) {
  return ((v ?? 0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
function hex8(v) {
  return (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
}
/** 写入状态徽标与配色（命名配置项 / 扩展配置项 共用） */
function stateTag(kind) {
  const map = {
    pending: '<span class="state-tag pending">待写入</span>',
    written: '<span class="state-tag written">已写入</span>',
    failed: '<span class="state-tag failed">写入失败</span>',
  };
  return map[kind] || '';
}
function stateClass(kind) {
  return kind ? ' ' + kind : '';
}
function setWriteState(key, kind) {
  if (!kind) state.writeState.delete(key);
  else state.writeState.set(key, kind);
}

function log(msg) {
  $('logLine').textContent = msg;
  console.log('[AlfaProxi]', msg);
}

/* ================= 标签页 ================= */
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('tab-' + b.dataset.tab).classList.add('active');
    // 进「模块诊断 / 特殊功能 / 实时数据」时按当前块+位图重算本车画像：
    // 期间可能改过配置位、做过对齐，模块清单要跟着变（懒重算，避免每个写字节路径都挂一次）
    if (['diag', 'funcs', 'live'].includes(b.dataset.tab) && state.modules) refreshVehicleProfile();
  });
});

/* ================= 接口选择 / 测试 / 扫描 ================= */
function currentIface() {
  return state.ifaces.find((x) => x.id === $('ifaceType').value) || null;
}

function renderIfaceTypes() {
  const sel = $('ifaceType');
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = 'sim'; opt.textContent = '模拟模式（演示，不连车）';
  sel.appendChild(opt);
  const groups = {};
  const isMobile = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  for (const i of state.ifaces) {
    // 手机端只留无线接口（USB/串口/K线/自动扫描在手机上不可用）
    if (isMobile && !['wifi', 'bluetooth'].includes(i.transport)) continue;
    const k = { usb: 'USB', bluetooth: '蓝牙', wifi: 'WiFi', serial: '串口', auto: '自动' }[i.transport] || i.transport;
    (groups[k] = groups[k] || []).push(i);
  }
  for (const [g, list] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = g;
    for (const i of list) {
      const o = document.createElement('option');
      o.value = i.id;
      o.textContent = i.name + (i.note ? '' : '');
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = 'sim';
  syncIfaceUI();
}

function syncIfaceUI() {
  const spec = currentIface();
  const isWifi = spec && spec.transport === 'wifi';
  const isAuto = !spec;                        // 模拟模式
  $('portLabel').textContent = isWifi ? 'IP:端口' : '串口';
  $('baudField').style.display = (isWifi || isAuto) ? 'none' : '';
  const input = $('ifacePort'), dl = $('ifacePortList');
  if (isWifi) {
    // WiFi 型地址可编辑（教程 §二：地址填 127.0.0.1:35001），预置为默认值
    dl.innerHTML = `<option value="${spec.host}:${spec.port}">默认</option>`;
    input.value = `${spec.host}:${spec.port}`;
    input.placeholder = 'IP:端口';
    input.disabled = false;
  } else if (isAuto) {
    dl.innerHTML = '';
    input.value = '';
    input.placeholder = '—';
    input.disabled = true;
  } else {
    input.disabled = false;
    input.placeholder = '选择或输入串口';
    // 切到串口/USB/蓝牙接口时清掉 WiFi 地址残留（如 127.0.0.1:35001）
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test((input.value || '').trim())) input.value = '';
  }
}

/** 解析 WiFi 地址输入 "host:port"（可编辑，失败回落到接口预置） */
function wifiTargetOf(spec) {
  const raw = ($('ifacePort').value || '').trim();
  const m = /^(.+):(\d{1,5})$/.exec(raw);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: spec.host, port: spec.port };
}

async function refreshPorts() {
  if (!state.bridge) return;
  try {
    const ports = await state.bridge.listPorts();
    const input = $('ifacePort'), dl = $('ifacePortList');
    const keep = input.value;
    dl.innerHTML = ports.map((p) => `<option value="${p.path}">${p.manufacturer || ''}</option>`).join('');
    if (keep) input.value = keep;
    log(`发现 ${ports.length} 个串口`);
  } catch (e) {
    log('串口枚举失败：' + e.message);
  }
}

async function ensureBridge() {
  const alive = state.bridge && (state.bridge.isMobile || (state.bridge.ws && state.bridge.ws.readyState === 1));
  if (alive) return state.bridge;
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // 手机端：TCP/BLE/SPP 直连传输层（vendor 由 mobile/scripts/sync-web.mjs 打包）
    const { MobileBridge } = await import('./vendor/mobile-bridge.js');
    state.bridge = new MobileBridge();
    state.bridge.isMobile = true;
    log('移动端传输层已就绪');
  } else {
    state.bridge = new BridgeClient();
    await state.bridge.connect();
    log('串口桥已连接');
  }
  state.tester = new InterfaceTester(state.bridge);
  return state.bridge;
}

/** 断开传输（手机端生命周期用；桌面桥连接随 WS 自然回收） */
async function disconnectBridge() {
  if (state.bridge && state.bridge.close) {
    try { await state.bridge.close(); } catch {}
  }
  state.bridge = null;
  log('已断开连接');
}

/** 供移动端连接 chip 调用：断开并复位状态（「点此断开或重连」） */
window.__apxDisconnect = async () => {
  // ⚠️ 顺序：先停轮询、再断开传输，否则轮询会继续往一个已关闭的 port 写（2026-10-18 审查 M7）
  stopLiveLoop();
  live.running = false;
  live.samples = [];
  live.picks = [];
  live.items = [];
  try { await disconnectBridge(); } catch {}
  state.connected = false;
  state.readDone = false;
  state.vin = null;
  state.data3 = null;
  state.alignment = null;
  // 断开后待写选择没有意义：清掉并收起浮动条（否则会挂着一个旧计数）
  state.selected.clear();
  state.namedPicks.clear();
  state.writeState.clear();
  updateFloatBar();
  if (state.session) state.session.resetLink();
  // 模块会话必须一起复位：否则「进入模块」被拦（提示先退出），而退出按钮又是隐藏态 → 卡死
  modSess.code = null;
  if (state.modules) renderModuleSessionUI();
  $('connState').textContent = '未连接';
  $('connState').className = 'pill offline';
  $('modState').textContent = '未连接模块';
  $('modState').className = 'pill mod';
  $('readState').textContent = '未读取配置';
  $('readState').className = 'pill offline';
  log('已断开连接并复位');
};

/** 供移动端「进后台自动停实时」调用（原 mobile-ui 找的 btnLiveStop 元素根本不存在） */
window.__apxStopLive = () => {
  const was = live.running;
  stopLiveLoop();
  if (was) {
    [...document.querySelectorAll('.live-pick:checked')].forEach((el) => { el.checked = false; });
    renderLiveParams();
    stageDone('实时数据已停止');
  }
  return was;
};

/** 通信日志（elm327 层逐条记录 >> 命令 / << 应答 / FC） */
function logText() {
  const g = globalThis.__apxLog || [];
  const head = `AlfaProxi 通信日志 ${new Date().toISOString()} · ${navigator.userAgent.slice(0, 80)} · ${g.length} 条`;
  return head + '\n' + (g.length ? g.join('\n') : '（暂无记录）');
}
$('btnLogCopy').addEventListener('click', async () => {
  const txt = logText();
  try {
    await navigator.clipboard.writeText(txt);
    alert('日志已复制到剪贴板（' + (globalThis.__apxLog || []).length + ' 条）');
  } catch {
    downloadFile('alfaproxi-log-' + Date.now() + '.txt', txt);   // 剪贴板不可用时转导出
  }
});
$('btnLogSave').addEventListener('click', () => {
  downloadFile('alfaproxi-log-' + Date.now() + '.txt', logText());
});

/**
 * 导出 PROXI 采数：DATA1/2/3 三块原始 hex + 关键区摘录。
 * 用途：采集 merge DATA3→DATA1[25..56] 的字节映射样本（SGW 对齐相关）。
 * 采数时机：① 无 SGW 基线 ② SGW 车装 bypass 前 ③ 装 bypass 后 ④ 对齐后再采一次。
 */
async function exportProxiSample() {
  if (!(await ensureConnected())) return;
  if (operationBlocked()) return;
  stopLiveForOperation('导出 PROXI 采数');
  if (state.session) state.session.resetCableAbort();
  try {
    await state.session.ensureModule(state.session.bodyModule);
    stage('正在读取 DATA1 / DATA2 / DATA3…');
    const { data1, data2, data3 } = await state.uds.readProxiAll();
    const blk = new ProxiBlock(data1);
    const v = blk.verify();
    const hex24 = (u8) => {
      const out = [];
      for (let i = 0; i < u8.length; i += 24) {
        out.push(Array.from(u8.slice(i, i + 24)).map((b) => hex8(b)).join(' '));
      }
      return out.join('\n');
    };
    const zone = Array.from(data1.slice(25, 57)).map((b) => hex8(b)).join(' ');
    const crcStr = Array.from(data1.slice(6, 11)).map((c) => String.fromCharCode(c)).join('');
    const txt = [
      `AlfaProxi PROXI 采数 · ${new Date().toISOString()}`,
      `平台 ${navigator.platform || '?'} · ${navigator.userAgent}`,
      '',
      `# 用途：采集 merge DATA3→DATA1[25..56] 映射样本（SGW 对齐）。请在文件名或备注里注明场景：`,
      `#   no-sgw / sgw-before / sgw-after / aligned`,
      '',
      `## DATA1 (DID 0x2023) · ${data1.length} 字节 · CRC 存储=${crcStr} · 校验${v.ok ? '自洽' : '不一致（计算 ' + v.computed + '）'}`,
      `### DATA1[25..56]（merge 目标区，32 字节）`,
      zone,
      `### DATA1 全文`,
      hex24(data1),
      '',
      `## DATA2 (DID 0x40A1) · ${data2.length} 字节`,
      hex24(data2),
      '',
      `## DATA3 (DID 0x40A2) · ${data3.length} 字节`,
      hex24(data3),
      '',
    ].join('\n');
    const name = `proxi-sample-${Date.now()}.txt`;
    const ok = await downloadFile(name, txt);
    if (ok) stageDone(`采数已导出（DATA1 ${data1.length}B / DATA2 ${data2.length}B / DATA3 ${data3.length}B）`);
  } catch (e) {
    stageFail('采数失败：' + e.message);
    alert('采数失败：' + e.message);
  }
}
$('btnSample').addEventListener('click', exportProxiSample);

/**
 * 导出文件：桌面 Blob 下载；移动端走系统分享面板（iOS WebView 对 download 不响应）。
 * 实车踩坑（2026-10-09）：@capgo/capacitor-file-sharer 的方法名是 share()/save()，
 * 早先误写 shareFile() 直接 undefined → 静默回退 Blob → 手机上「点了没反应」。
 * 返回是否成功，供调用方决定要不要提示。
 */
async function downloadFile(name, text, mime = 'text/plain') {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const Sharer = Cap.Plugins && Cap.Plugins.FileSharer;
    // 优先 share()（弹系统分享面板，可存到文件/发微信等）；旧版插件可能只有 save()
    const fn = Sharer && (typeof Sharer.share === 'function' ? Sharer.share
      : (typeof Sharer.save === 'function' ? Sharer.save : null));
    if (fn) {
      try {
        await fn.call(Sharer, { filename: name, base64Data: b64, contentType: mime });
        return true;
      } catch (e) {
        log('系统分享失败: ' + (e && e.message));
      }
    } else {
      log('FileSharer 插件不可用');
    }
    // iOS 上 Blob 下载无效——退到剪贴板，至少让用户有办法带走
    try {
      await navigator.clipboard.writeText(text);
      alert(`系统分享不可用，内容已复制到剪贴板，可自行粘贴保存。\n（${name}）`);
      return true;
    } catch {
      alert('导出失败：系统分享不可用。请改用「导出日志」或截图保留。');
      return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return true;
}

$('ifaceType').addEventListener('change', async () => {
  syncIfaceUI();
  const spec = currentIface();
  if (spec && spec.transport !== 'wifi') {
    try { await ensureBridge(); await refreshPorts(); } catch (e) { log(e.message); }
    if (spec.baud) $('ifaceBaud').value = String(spec.baud);
  }
});

$('btnTestIface').addEventListener('click', async () => {
  const spec = currentIface();
  if (!spec) return alert('当前为模拟模式，无需测试接口');
  if (operationBlocked()) return;
  // 测试会发 ATZ 复位适配器，并在结束时关闭端口 —— 已连接时等于把链路掐死
  // （后续操作全部超时，界面却还显示"已连接"，2026-10-18 审查 M9）
  if (state.connected) {
    if (!confirm('测试接口会复位适配器（ATZ）并关闭当前端口。\n\n继续将先断开当前连接。是否继续？')) return;
    await window.__apxDisconnect();
  }
  try {
    stage('正在连接串口桥…');
    await ensureBridge();
    const opts = spec.transport === 'wifi'
      ? wifiTargetOf(spec)
      : { port: $('ifacePort').value, baud: Number($('ifaceBaud').value) };
    if (!opts.port && spec.transport !== 'wifi') return alert('请先选择串口');
    stage(`正在测试接口：${spec.name}…`);
    const r = await state.tester.test(spec, opts);
    r.steps.forEach((st) => log(st));
    if (r.ok) {
      stageDone(`✓ 接口可用：${r.identify ? r.identify.name : spec.name}，延迟 ${r.latency}ms`);
      alert('接口测试通过\n\n' + r.steps.join('\n'));
    } else {
      stageFail('✗ 接口测试未通过：' + (r.error || '未知原因'));
      alert('接口测试未通过\n\n' + r.steps.join('\n'));
    }
  } catch (e) {
    stageFail('测试失败：' + e.message);
    alert('测试失败：' + e.message + '\n\n请确认已运行串口桥服务：node bridge/server.js');
  }
});

$('btnScanIface').addEventListener('click', async () => {
  const spec = currentIface();
  if (!spec) return alert('当前为模拟模式，无需扫描');
  try {
    await ensureBridge();
    stage('正在扫描并识别接口…');
    const found = await state.tester.scan(spec);
    if (found.length) {
      stageDone(`扫描完成：发现 ${found.length} 个可用接口`);
      alert('扫描完成\n\n' + found.map((f) => `${f.path} → ${f.identify.name}（延迟 ${f.latency}ms）`).join('\n'));
      $('ifacePort').value = found[0].path;
    } else {
      stageFail('扫描完成：未找到可用接口');
      alert('扫描完成：未找到可用接口\n\n请确认接口已插好、驱动已安装，并已连接车辆（点火 ON）。');
    }
  } catch (e) {
    stageFail('扫描失败：' + e.message);
    alert('扫描失败：' + e.message);
  }
});

/* ================= 连接与读取 ================= */
/** 执行任何操作前调用；模拟模式自动连接 */
async function ensureConnected() {
  if (state.connected) return true;
  // 模拟模式自动连接；真实适配器需用户手动点「连接」（涉及串口与车辆）
  if (currentIface()) {
    alert('请先点击「连接」建立适配器通信。');
    return false;
  }
  await connect(true);
  return state.connected;
}

/** 修改配置前调用：必须已读取过车辆配置 */
async function ensureRead() {
  if (!(await ensureConnected())) return false;
  if (state.readDone) return true;
  alert('请先点击「读取车辆配置」，读取后才能查看当前值并写入。');
  return false;
}

async function connect(forceSim) {
  const spec = forceSim ? null : currentIface();
  try {
    stage(spec ? `正在连接适配器：${spec.name}…` : '正在进入模拟模式…');
    $('connState').textContent = '连接中…';
    $('connState').className = 'pill busy';
    if (!spec) {
      // 演示链路：与真实适配器同接口，不与车辆收发，只记录本应下发的帧
      state.link = new DemoLink({
        log: (m) => log(m),
        cables: state.cables,
        nodes: state.modules ? state.modules.alignmentNodes : [],
      });
    } else {
      // 真实适配器：经串口桥打开端口，用同一套 ELM327 协议层
      await ensureBridge();
      const opts = spec.transport === 'wifi'
        ? wifiTargetOf(spec)
        : { port: $('ifacePort').value, baud: Number($('ifaceBaud').value) };
      if (spec.transport === 'wifi') await state.bridge.tcpOpen(opts.host, opts.port);
      else {
        if (!opts.port) throw new Error('请先选择串口');
        await state.bridge.open(opts.port, opts.baud);
      }
      // 适配器能力：多通道能自动切总线的，对齐时免换线。
      // 实证（2026-10-10）：CANtieCAR（USB/BT/WiFi）与 vLinker MS 免换线；
      //   其余（ELM327/OBDKey/OBDLink 等）要按线号换适配线。
      const autoBus = spec.kind === 'vlinker' || spec.kind === 'cantiecar';
      state.link = new Elm327(new BridgePort(state.bridge), {
        adapter: autoBus ? (spec.kind === 'vlinker' ? 'vlinker-ms' : 'cantiecar') : 'elm327',
        log: (m) => log(m),
      });
      state.realAdapter = true;
    }
    await state.link.init({ protocol: 7 });
    state.uds = new Uds(state.link);
    state.session = new Session(state.link, {
      cables: state.cables,
      platform: $('platform').value,
      log: (m) => log(m),
    });
    state.session.on('cableRequired', (e) => {
      showCableHint(`${t(e.module.name)}（${e.module.code}）— ${e.hint}`);
    });
    state.session.on('cableDone', hideCableHint);
    state.session.on('moduleConnected', (e) => {
      const zh = e.module.zh || modLabel(e.module.code);
      $('modState').textContent = `已连接：${zh}`;
      $('modState').title = `${zh}\n代号 ${e.module.code} · 总线 ${e.module.bus} · 地址 0x${e.module.tx} ← 0x${e.module.rx} · ${e.module.baud}k`;
    });
    state.connected = true;
    state.simMode = !spec;
    // 新连接 = 新会话：清掉上一台车/上一个适配器留下的块与在场位基线
    // （此前只改 connected，块、基线、VIN、模块会话都会跨会话残留 —— 2026-10-18 审查 L11）
    state.vin = null;
    state.data3 = null;
    state.alignment = null;
    state.readDone = false;
    state.block = null;
    state.baseline = null;
    state.profile = null;
    state.engineOverride = '';
    state.showAllModules = false;
    renderVehicleBar();
    state.selected.clear();
    state.namedPicks.clear();
    state.writeState.clear();
    state.bitEditIndex = null;
    updateFloatBar();                    // 新会话无待写项 → 收起浮动条（含移动端底部留白）
    modSess.code = null;
    stopLiveLoop();
    live.samples = []; live.picks = []; live.items = [];
    $('modState').textContent = '未连接模块';
    $('modState').className = 'pill mod';
    if (state.simMode) {
      $('connState').textContent = '模拟模式';
      $('connState').className = 'pill busy';
      $('simBanner').classList.remove('hidden');
      stageDone('已进入模拟模式：不连接车辆，仅浏览功能与流程');
    } else {
      $('connState').textContent = '已连接';
      $('connState').className = 'pill online';
      $('simBanner').classList.add('hidden');
      stageDone(`适配器已连接：${spec.name}`);
    }
  } catch (e) {
    $('connState').textContent = '失败';
    $('connState').className = 'pill offline';
    stageFail('连接失败：' + e.message);
    alert('连接失败：' + e.message);
  }
}

/** 读取车辆配置：连上车身电脑 → 读 PROXI → 显示各项当前值 */
async function readConfig() {
  if (!(await ensureConnected())) return;
  if (operationBlocked()) return;
  stopLiveForOperation('读取配置');
  if (state.session) state.session.resetCableAbort();
  state.busy = '读取配置';
  try {
    const bodyName = modLabel(state.session.bodyModule);
    stage(`正在连接模块：${bodyName}（${state.session.bodyModule}）…`);
    await stageWait(520);
    await state.session.ensureModule(state.session.bodyModule);
    stage(`已连接 ${bodyName}，正在读取车辆配置…`);
    // VIN 仅用于日志/诊断；对齐状态不再依赖“在场位基线”
    if (!state.vin) {
      try {
        const rawVin = await state.uds.readDataByIdentifier(0xf190);
        const s = Array.from(rawVin).filter((b) => b >= 32 && b < 127).map((b) => String.fromCharCode(b)).join('').trim();
        if (s.length >= 11) { state.vin = s; log('VIN：' + s); }
      } catch (e) { log('VIN 读取失败：' + e.message); }
    }
    const d1 = await state.uds.readProxi();
    // DATA3 = CAN 配置块（80B）：对齐状态的“实际位图”来源，与 DATA1 配置位图比对
    let data3 = null;
    try {
      data3 = await state.uds.readDataByIdentifier(DID.DATA3);
    } catch (e) {
      log('DATA3 读取失败（对齐状态不可用）：' + e.message);
    }
    state.data3 = data3;
    state.block = new ProxiBlock(d1);
    state.baseline = state.block.clone();
    // 本车画像：发动机手动指定的记忆按 VIN 取（VIN 读不到时退化为全局键）
    state.engineOverride = loadEngineOverride();
    refreshVehicleProfile();
    applyAlignment(d1, data3, { log: true });
    renderAlign();                            // 按位图状态渲染（已对齐/待添加/待移除/未安装）
    state.readDone = true;
    state.namedPicks.clear();
    state.selected.clear();
    state.writeState.clear();   // 重读后旧的「已写入/写入失败」徽标必须清掉
    state.bitEditIndex = null;
    $('readState').textContent = `已读取 ${d1.length} 字节`;
    $('readState').className = 'pill online';
    const al = state.alignment;
    const statusNote = al && al.ok
      ? ` · 需对齐 ${al.counts.needs} 个（新增 ${al.counts.added} / 移除 ${al.counts.removed}）`
      : ' · 对齐状态不可用';
    stageDone(`配置读取完成：${d1.length} 字节，校验${state.block.verify().ok ? '自洽' : '异常'}${statusNote}`);
    renderNamed(); renderFeatures(); renderEditor();
  } catch (e) {
    stageFail('读取失败：' + e.message);
    alert('读取失败：' + e.message);
  } finally {
    if (state.busy === '读取配置') state.busy = null;
  }
}

$('btnConnect').addEventListener('click', async (e) => {
  if (operationBlocked()) return;
  await connect(e.ctrlKey || e.metaKey);
  if (state.connected) await readConfig();
});

/** 模拟模式：不连接车辆，浏览各模块的参数/测试/标定（对应 Ctrl+F10） */
$('btnSimulate').addEventListener('click', async () => {
  if (operationBlocked()) return;
  await connect(true);
  if (state.connected) await readConfig();
});

$('btnScanTop').addEventListener('click', () => {
  document.querySelector('[data-tab="diag"]').click();
  $('btnScan').click();
});

// 快捷键：Ctrl+F10 = 模拟模式，F11 = 扫描
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'F10') {
    e.preventDefault();
    $('btnSimulate').click();
  } else if (e.key === 'F11') {
    e.preventDefault();
    $('btnScanTop').click();
  }
});
$('platform').addEventListener('change', async () => {
  // 车型决定车身电脑（BODY33/BODY30）；已连接时切车型必须重连，
  // 否则 Session 仍停在旧车型的车身电脑上，界面却显示新车型。
  state.vin = null;
  state.data3 = null;
  state.alignment = null;
  state.profile = null;
  state.engineOverride = '';
  renderVehicleBar();
  if (!state.connected) { if (state.modules) { renderAlign(); refreshVehicleProfile(); } return; }
  await window.__apxDisconnect();
  alert('已切换车型并断开连接，请重新点「连接」。');
});
$('btnRead').addEventListener('click', readConfig);
$('cableOk').addEventListener('click', () => {
  hideCableHint();
  if (state.session) state.session.confirmCable();
});
$('cableCancel') && $('cableCancel').addEventListener('click', () => {
  hideCableHint();
  if (state.session) state.session.cancelCable();
  log('已取消换线确认');
});

/* ================= 命名配置项 ================= */
function namedCurrent(st) {
  if (!state.block) return null;
  return state.block.getByte(st.startByte) & st.mask;
}

function renderNamed() {
  const grid = $('namedGrid');
  if (!grid) return;
  const q = ($('featSearch') && $('featSearch').value) || '';
  const list = state.named.settings.filter((st) =>
    hit(q, st.name, t(st.name), `byte${st.startByte}`,
        ...st.options.map((o) => o.label + ' ' + t(o.label))));
  $('namedCount').textContent = list.length === state.named.settings.length
    ? state.named.settings.length
    : `${list.length} / ${state.named.settings.length}`;
  grid.innerHTML = list.length ? '' : '<div class="dim" style="padding:14px">没有匹配的配置项</div>';
  for (const st of list) {
    const cur = namedCurrent(st);
    const picked = state.namedPicks.get(st.name);
    // 写入结果徽标以 writeState 为准：写入后即使待写选择已清空也要显示「已写入/写入失败」
    const stt = state.writeState.get('named:' + st.name) || (picked ? 'pending' : null);
    const div = document.createElement('div');
    div.className = 'named' + stateClass(stt) + (state.readDone ? '' : ' unsupported');
    const curOpt = cur === null ? null : st.options.find((o) => o.value === cur);
    const curLabel = cur === null ? '未读取' : (curOpt ? t(curOpt.label) : `未知值 ${hex8(cur)}`);
    const opts = st.options.map((o) => {
      const active = picked ? picked.value === o.value : cur === o.value;
      return `<option value="${o.value}"${active ? ' selected' : ''}>${t(o.label)}</option>`;
    }).join('');
    div.innerHTML = `
      <div class="nm">${tSpan(st.name)}${stateTag(stt)}</div>
      <div class="meta">Byte${st.startByte} · 掩码 ${hex8(st.mask)}</div>
      <div class="cur">当前：<b>${curLabel}</b>${picked && stt === 'pending' ? '　→　待写入' : ''}${stt === 'written' ? '　✓ 已写入' : ''}${stt === 'failed' ? '　✗ 写入失败' : ''}</div>
      <select data-ns="${st.name}"${state.readDone ? '' : ' disabled'}>
        <option value="">— 不修改 —</option>${opts}
      </select>`;
    div.querySelector('select').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === '') {
        state.namedPicks.delete(st.name);
        setWriteState('named:' + st.name, null);
      } else {
        state.namedPicks.set(st.name, { byte: st.startByte, mask: st.mask, value: Number(v) });
        setWriteState('named:' + st.name, 'pending');   // 选中即「待写入」，与扩展项统一
      }
      renderNamed();
      detectConflicts();          // 命名项与扩展项同字节冲突同样要告警（P2-3）
    });
    grid.appendChild(div);
  }
  updateFloatBar();
}

/* ================= 扩展配置项 ================= */
function featurePatchText(f) {
  return (f.patches || []).map((p) => {
    const bits = Object.entries(p.bits || {}).map(([b, v]) => `bit${b}→${v}`).join(' ');
    if (p.fixed !== undefined && p.fixed !== null) {
      return `Byte${p.addr} 整字节设为 ${hex8(p.fixed)}`;
    }
    return `Byte${p.addr} ${bits}`.trim();
  }).join('　');
}

/** 该项在当前配置下是否已生效 */
function featureCurrentState(f) {
  if (!state.block || !f.patches || !f.patches.length) return null;
  try {
    for (const p of f.patches) {
      const cur = state.block.getByte(p.addr);
      if (p.fixed !== undefined && p.fixed !== null) {
        if (cur !== p.fixed) return false;
        continue;
      }
      for (const [b, v] of Object.entries(p.bits || {})) {
        if (state.block.getBit(p.addr, Number(b)) !== (v ? 1 : 0)) return false;
      }
    }
    return true;
  } catch { return null; }
}

function renderFeatures() {
  const grid = $('featGrid');
  const q = ($('featSearch') && $('featSearch').value) || '';
  const list = state.features.active.filter((f) =>
    hit(q, f.name, f.desc, f.notes, f.source, featurePatchText(f),
        ...Object.values((f.options || []).reduce((a, o) => (a.push(o.label), a), []))));
  grid.innerHTML = list.length ? '' : '<div class="dim" style="padding:14px">没有匹配的配置项</div>';
  for (const f of list) {
    const card = document.createElement('div');
    // 与命名项同一套反馈逻辑：writeState 优先，选中未写为「待写入」
    const stt = state.writeState.get('feat:' + f.id) || (state.selected.has(f.id) ? 'pending' : null);
    card.className = 'card' + (state.selected.has(f.id) ? ' on' : '') + stateClass(stt);
    card.dataset.id = f.id;
    // 与命名配置项统一交互：下拉框选择（— 不修改 — / 各选项或启用 / 不启用 / 恢复原状）
    const hasOpts = Array.isArray(f.options) && f.options.length > 0;
    const pickedIdx = state.selected.get(f.id);
    const mainOpts = hasOpts
      ? f.options.map((o, i) => `<option value="${i}"${pickedIdx === i ? ' selected' : ''}>${t(o.label)}</option>`).join('')
      : `<option value="on"${pickedIdx === null && state.selected.has(f.id) ? ' selected' : ''}>启用</option>`;
    const tailOpts =
      (featureHasOffOption(f) ? `<option value="off"${pickedIdx === 'off' ? ' selected' : ''}>不启用</option>` : '') +
      `<option value="revert"${pickedIdx === 'revert' ? ' selected' : ''}>恢复原状</option>`;
    const selHtml = `<select data-feat="${f.id}"${state.readDone ? '' : ' disabled'}>
        <option value="">— 不修改 —</option>${mainOpts}${tailOpts}</select>`;
    const cur = featureCurrentState(f);
    const curHtml = state.readDone && cur !== null
      ? `<div class="cur-state ${cur ? 'yes' : 'no'}">当前：${cur ? '已启用' : '未启用'}</div>`
      : '';
    card.innerHTML = `
      <h3>${tSpan(f.name)}${stateTag(stt)} <span class="tag ${f.status}">${((state.features && state.features.statusLegend) && (state.features && state.features.statusLegend)[f.status]) || f.status}</span></h3>
      <p>${f.desc || ''}</p>
      ${curHtml}
      <div class="bits">${featurePatchText(f)}</div>
      ${selHtml}
      <div class="src">来源：${f.source || '—'}</div>
      ${f.notes ? `<div class="src note">${f.notes}</div>` : ''}`;

    card.querySelector('select').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === '') {
        state.selected.delete(f.id);
        setWriteState('feat:' + f.id, null);
      } else if (v === 'on') {
        state.selected.set(f.id, null);
        setWriteState('feat:' + f.id, 'pending');
      } else if (v === 'off' || v === 'revert') {
        state.selected.set(f.id, v);
        setWriteState('feat:' + f.id, 'pending');   // 选中即「待写入」，与命名项统一
      } else {
        state.selected.set(f.id, Number(v));
        setWriteState('feat:' + f.id, 'pending');
      }
      renderFeatures();
      detectConflicts();
    });
    grid.appendChild(card);
  }
  detectConflicts();
  updateFloatBar();
}

function optionToPatch(f, idx) {
  const o = f.options[idx];
  return {
    bytes: (f.patches || []).map((p) => {
      const own = { ...(p.bits || {}) };
      const ob = o.bits || {};
      // 选项里的位只覆盖**同一字节上重叠的位**；多 patch 功能不会把同一组位写到别的字节
      // （此前无条件 `bits: {...o.bits}` 会把位写进所有 patch 字节 —— 目前数据恰好都是单 patch，
      //  属潜在雷；2026-10-18 审查 L5）
      const overlap = Object.keys(own).some((k) => k in ob);
      const out = { addr: p.addr, bits: overlap ? { ...own, ...ob } : own };
      if (o.fixed !== undefined && o.fixed !== null) out.fixed = o.fixed;
      return out;
    }),
  };
}

/**
 * 扩展项选择值 → 补丁。值域：
 *   number   = 选项索引（有选项项）
 *   null     = 启用（无选项项的默认补丁）
 *   'off'    = 不启用（有 offBits 时写 offBits；否则纯位启用型写 0）
 *   'revert' = 恢复原状（覆盖的位/字节写回基线读取值）
 */
function resolveFeaturePatch(f, selValue, baseline) {
  if (selValue === 'off') {
    // 有些位是低有效（如额外雨刮 bit5：0=启用、1=关闭），off 不能一律写 0。
    const offBits = f.offBits || null;
    return {
      bytes: (f.patches || []).map((p) => ({
        addr: p.addr,
        bits: offBits
          ? Object.fromEntries(Object.keys(offBits).map((b) => [b, Number(offBits[b]) ? 1 : 0]))
          : Object.fromEntries(Object.keys(p.bits || {}).map((b) => [b, 0])),
      })),
    };
  }
  if (selValue === 'revert') {
    return {
      bytes: (f.patches || []).map((p) => {
        const base = baseline ? baseline.getByte(p.addr) : 0;
        if (p.fixed !== undefined && p.fixed !== null) return { addr: p.addr, fixed: base };
        const bits = {};
        for (const b of Object.keys(p.bits || {})) bits[b] = (base >> Number(b)) & 1;
        return { addr: p.addr, bits };
      }),
    };
  }
  if (typeof selValue === 'number') return optionToPatch(f, selValue);
  return { bytes: f.patches };      // null → 启用（无选项项）
}

/** 纯位启用型补丁（无 fixed 字节）才提供「不启用」 */
function featureHasOffOption(f) {
  if (f && f.noOff) return false;
  return (f.patches || []).length > 0 && (f.patches || []).every((p) => p.fixed === undefined || p.fixed === null);
}

/** 冲突检测：命名项 + 扩展项统一按位比较（教程 §3.3「同字节冲突会红字告警」） */
function detectConflicts() {
  const map = new Map();          // 'byte:bit' -> [{id, val}]
  const addBit = (id, addr, bit, val) => {
    const k = `${addr}:${bit}`;
    map.set(k, [...(map.get(k) || []), { id, val: val ? 1 : 0 }]);
  };
  // 命名项：掩码内每一位都声明目标值
  for (const [name, pick] of state.namedPicks) {
    for (let b = 0; b < 8; b++) {
      if (pick.mask & (1 << b)) addBit(name, pick.byte, b, (pick.value >> b) & 1);
    }
  }
  // 扩展项：fixed 展开为 8 位；bits 直接登记
  for (const [fid, optIdx] of state.selected) {
    const f = state.features.active.find((x) => x.id === fid);
    if (!f) continue;
    const patch = resolveFeaturePatch(f, optIdx, state.baseline);
    for (const p of patch.bytes || []) {
      if (p.fixed !== undefined && p.fixed !== null) {
        for (let b = 0; b < 8; b++) addBit(f.name, p.addr, b, (p.fixed >> b) & 1);
      }
      for (const [b, v] of Object.entries(p.bits || {})) {
        addBit(f.name, p.addr, Number(b), v);
      }
    }
  }
  const conflicts = [];
  for (const [k, list] of map) {
    if (list.length < 2) continue;
    if (new Set(list.map((x) => String(x.val))).size > 1) {
      conflicts.push(`Byte${k.replace(':', ' 的 bit')} 被写成不同值：${list.map((x) => `${x.id}=${x.val}`).join(' / ')}`);
    }
  }
  $('conflictList').innerHTML = conflicts.map((c) => `<li>${c}</li>`).join('');
  $('conflictBox').classList.toggle('hidden', conflicts.length === 0);
}

/** 把待写选择合并进配置块并重算 CRC（幂等，重复调用安全）；返回字节变更列表 */
function applyPicksToBlock() {
  const changes = [];
  for (const [, pick] of state.namedPicks) {
    const before = state.block.getByte(pick.byte);
    const after = (before & ~pick.mask) | (pick.value & pick.mask);
    if (before !== after) {
      state.block.setByte(pick.byte, after);
      changes.push({ addr: pick.byte, before, after, kind: 'named' });
    }
  }
  for (const [fid, optIdx] of state.selected) {
    const f = state.features.active.find((x) => x.id === fid);
    const patch = resolveFeaturePatch(f, optIdx, state.baseline);
    changes.push(...state.block.applyPatch(patch));
  }
  state.block.seal();
  return changes;
}

$('btnApply').addEventListener('click', async () => {
  if (!(await ensureRead())) return;
  if (operationBlocked()) return;
  stopLiveForOperation('应用配置预览');
  if (state.session) state.session.resetCableAbort();
  const namedPicks = state.namedPicks;
  if (state.selected.size === 0 && namedPicks.size === 0) return alert('请先选择要修改的配置项');
  const bodyName = modLabel(state.session.bodyModule);
  try {
    stage(`正在连接模块：${bodyName}（${state.session.bodyModule}）…`);
    await stageWait(460);
    await state.session.ensureModule(state.session.bodyModule);
  } catch (e) {
    stageFail('连接失败：' + e.message);
    return alert('连接失败：' + e.message);
  }
  stage('正在计算字节变更…');

  const changes = applyPicksToBlock();
  const n = state.selected.size + namedPicks.size;
  // 标记为「待写入」，等写入 ECU 后再翻成已写入/失败
  for (const k of namedPicks.keys()) setWriteState('named:' + k, 'pending');
  for (const k of state.selected.keys()) setWriteState('feat:' + k, 'pending');
  stageDone(`已应用 ${n} 项配置：${changes.length} 处字节变更，校验已重算`);
  if (state.data3) applyAlignment(state.block.bytes, state.data3);
  renderNamed(); renderFeatures(); renderEditor(); detectConflicts(); renderAlign();
  alert(`已应用 ${n} 项配置（命名配置 ${namedPicks.size} 项 / 扩展配置 ${state.selected.size} 项）\n共变更 ${changes.length} 处字节\n\n请在「字节编辑器」核对后写入。`);
});

$('btnBackup').addEventListener('click', async () => {
  if (!state.block) return alert('请先读取车辆配置');
  const ok = await downloadFile(`proxi-backup-${Date.now()}.txt`, state.block.toHexText());
  if (ok) stageDone('配置备份已导出');
});

/** 一键恢复：载入之前导出的备份到字节编辑器（不自动写车，仍需点「写入 ECU」） */
$('btnRestore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';   // 清掉以便重复选同一文件
  if (!f) return;
  let blk;
  try {
    blk = ProxiBlock.fromHex(await f.text());
  } catch (err) {
    return alert('导入失败：不是有效的配置备份（' + err.message + '）');
  }
  if (blk.length < 32) return alert('导入失败：备份太短（' + blk.length + ' 字节），疑似文件不对');
  // 长度必须与车上读到的块一致：PROXI 是定长块，短块写下去会被 ECU 拒写（NRC 0x13），
  // 个别 ECU 还可能按请求长度截断存储 —— 直接拦在导入这一步，别等到写入/对齐时才发现
  if (state.baseline && blk.length !== state.baseline.length) {
    return alert(`导入失败：备份 ${blk.length} 字节，与车上读取的 ${state.baseline.length} 字节不一致。\n\n`
      + 'PROXI 配置块是定长的，长度不符的备份不能写入。请确认导出/导入的是同一车型的完整备份。');
  }
  // 基线保持车上读取值，这样编辑器能看出「备份 vs 车上」的差异；没读过车就以备份为基线
  if (!state.baseline) state.baseline = blk.clone();
  state.block = blk;
  state.namedPicks.clear();
  state.selected.clear();
  state.writeState.clear();
  state.bitEditIndex = null;
  const diffs = blk.diff(state.baseline).length;
  let v = blk.verify();
  let sealNote = '';
  if (!v.ok) {
    // 备份文件被手改过 / 来自别的工具导致校验不自洽：自动重算（写入前必须自洽），
    // 否则后面写入/对齐必被 ECU 拒（NRC 0x31）
    blk.seal();
    v = blk.verify();
    sealNote = '；备份校验值与内容不符，已自动重算 CRC';
  }
  if (state.data3) applyAlignment(state.block.bytes, state.data3);
  renderEditor(); renderNamed(); renderFeatures(); detectConflicts(); renderAlign();
  const msg = `已载入备份：${blk.length} 字节，校验${v.ok ? '自洽' : '仍异常'}，与车上基线差异 ${diffs} 处${sealNote}`;
  log(msg);
  alert(msg + '\n\n已在字节编辑器载入（未写车）。核对后点「写入 ECU」才会真正刷写。');
});

/* ================= 字节编辑器 ================= */
function renderEditor() {
  const b = state.block;
  if (!b) {
    $('blkLen').textContent = '—';
    $('blkHead').textContent = '未读取';
    $('crcInfo').textContent = '—';
    $('hexGrid').innerHTML = '<div class="dim" style="grid-column:1/-1;padding:22px">请先连接车辆并读取配置。</div>';
    $('bitPanel').classList.add('hidden');
    return;
  }
  $('blkLen').textContent = b.length;
  $('blkHead').textContent = b.headerAscii();
  const v = b.verify();
  $('crcInfo').textContent = v.ok ? `✓ 自洽（CRC ${hex16(v.computed)}）` : `✗ 不一致（存储 ${hex16(v.stored)} / 计算 ${hex16(v.computed)}）`;
  $('crcInfo').className = v.ok ? 'ok' : 'bad';

  const grid = $('hexGrid');
  grid.innerHTML = '';
  for (let i = 0; i < b.length; i++) {
    // 显示与访问都用社区编号（1-based，B1=首字节）——与命名项口径一致
    const no = i + 1;
    const cur = b.getByte(no);
    const orig = state.baseline ? state.baseline.getByte(no) : cur;
    // CRC 校验区（B7–B11，5 位十进制 ASCII）：任何配置改动都会让它自动重算
    const isCrc = no >= CRC_OFFSET + 1 && no <= CRC_OFFSET + CRC_DIGITS;
    const changed = cur !== orig;
    const el = document.createElement('div');
    el.className = 'hbyte'
      + (isCrc ? ' crc' : '')
      + (changed ? ' changed' : '')
      + (state.bitEditIndex === i ? ' active' : '');
    let bits = '';
    for (let k = 7; k >= 0; k--) bits += `<div class="b${(cur >> k) & 1 ? ' on' : ''}"></div>`;
    el.innerHTML = `<div class="addr">B${no}${isCrc ? ' ·CRC' : ''}</div><div class="val">${hex8(cur)}</div><div class="bits">${bits}</div>`;
    el.title = isCrc
      ? `Byte ${no} = ${hex8(cur)}\nCRC 校验区：改动配置后自动重算属正常，不必手动改`
      : `Byte ${no} = ${hex8(cur)}`;
    el.addEventListener('click', () => {
      state.bitEditIndex = state.bitEditIndex === i ? null : i;
      renderEditor();
    });
    grid.appendChild(el);
  }
  renderBitPanel();
}

function renderBitPanel() {
  const panel = $('bitPanel');
  const i = state.bitEditIndex;
  if (i === null || !state.block) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const cur = state.block.getByte(i + 1);
  const orig = state.baseline ? state.baseline.getByte(i + 1) : cur;
  let cells = '';
  for (let k = 7; k >= 0; k--) {
    const on = (cur >> k) & 1;
    const wasOn = (orig >> k) & 1;
    cells += `<div class="bit-cell${on ? ' on' : ''}${on !== wasOn ? ' changed' : ''}" data-bit="${k}" title="点击切换 bit${k}">
      <div class="bn">bit${k}</div><div class="bv">${on}</div></div>`;
  }
  panel.innerHTML = `
    <h4>Byte ${i + 1} 位编辑<span class="dim">点击方块直接翻转该位</span><button class="small close" id="bitClose">收起</button></h4>
    <div class="bit-row">${cells}</div>
    <div class="vals">
      <label>十六进制<input id="bitHex" value="${hex8(cur)}" maxlength="2" spellcheck="false"></label>
      <label>原始值<input value="${hex8(orig)}" disabled></label>
      <button class="small ghost" id="bitReset">还原此字节</button>
    </div>`;

  panel.querySelectorAll('.bit-cell').forEach((el) => {
    el.addEventListener('click', () => {
      const k = Number(el.dataset.bit);
      state.block.setBit(i + 1, k, state.block.getBit(i + 1, k) ? 0 : 1);
      afterByteEdit();
    });
  });
  $('bitClose').addEventListener('click', () => { state.bitEditIndex = null; renderEditor(); });
  $('bitReset').addEventListener('click', () => {
    if (state.baseline) state.block.setByte(i + 1, state.baseline.getByte(i + 1));
    afterByteEdit();
  });
  $('bitHex').addEventListener('change', (e) => {
    const raw = e.target.value.trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const v = raw === '' ? NaN : parseInt(raw, 16);
    if (Number.isNaN(v) || v < 0 || v > 255) return alert('输入无效：需要 00 – FF');
    state.block.setByte(i + 1, v);
    afterByteEdit();
  });
}

function afterByteEdit() {
  state.block.seal();
  if (state.data3) applyAlignment(state.block.bytes, state.data3);   // 静默重算，不重建对齐页 DOM（避免勾选被重置）
  renderEditor();
  renderNamed();
  renderFeatures();
}

$('btnSeal').addEventListener('click', () => {
  if (!state.block) return;
  state.block.seal();
  renderEditor();
  log('校验已重算');
});
$('btnRevert').addEventListener('click', () => {
  if (!state.baseline) return;
  state.block = state.baseline.clone();
  state.namedPicks.clear();
  state.selected.clear();
  state.writeState.clear();
  state.bitEditIndex = null;
  if (state.data3) applyAlignment(state.block.bytes, state.data3);
  renderEditor(); renderNamed(); renderFeatures(); detectConflicts(); renderAlign();
  log('已放弃全部改动');
});
async function writeToEcu() {
  if (!(await ensureRead())) return;
  if (operationBlocked()) return;
  // 定长块保护：导入的备份若与车上块长度不同，2E 请求长度就不对，必须拦在写之前
  if (state.baseline && state.block.length !== state.baseline.length) {
    return alert(`当前配置块 ${state.block.length} 字节，与车上读取的 ${state.baseline.length} 字节不一致。\n\n`
      + '已阻止写入。请重新「读取车辆配置」，或导入与本车一致的完整备份。');
  }
  if (!confirm('确认写入 ECU？写入前请确认已导出备份。')) return;
  stopLiveForOperation('写入配置');
  if (state.session) state.session.resetCableAbort();
  state.busy = '写入配置';
  try {
    stage(`正在连接模块：${modLabel(state.session.bodyModule)}…`);
    await stageWait(460);
    await state.session.ensureModule(state.session.bodyModule);
    // 选中即写：待写选择自动合并进配置块（与「写入所选项」同一套逻辑），再写入 ECU
    const changes = applyPicksToBlock();
    for (const k of state.namedPicks.keys()) setWriteState('named:' + k, 'pending');
    for (const k of state.selected.keys()) setWriteState('feat:' + k, 'pending');
    if (changes.length) renderEditor();
    stage('正在写入配置…');
    state.block.seal();
    // 注：PROXI 写入不需要 Security Access（实车流程已核实）
    await state.uds.writeProxi(state.block.bytes);
    // ⚠️ 标准序列写后必须接 `22 10 2A`（主判据）+ `22 40 AA`（收尾）。
    //    此前只有整块 diff，缺这两条 —— 与对齐路径不一致，也没跑主判据。
    //    （2026-10-16 复查 A3）
    stage('正在回读校验（22 10 2A 主判据 + 整块比对）…');
    const v = await state.uds.verifyProxi(state.block.bytes).catch((e) => {
      log('22 10 2A 校验失败：' + e.message, 'warn');
      return { ok: false, diffs: [], err: e.message };
    });
    const back = new ProxiBlock(await state.uds.readProxi());
    const diff = back.diff(state.block);
    const ok = v.ok && diff.length === 0;
    if (!v.ok) {
      log('22 10 2A 判定有差异：' + (v.diffs || []).map((d) => `Byte${d.byte}`).join('、'), 'warn');
    }
    // 按实际写入结果翻状态：成功→已写入，有差异→写入失败
    for (const k of state.namedPicks.keys()) setWriteState('named:' + k, ok ? 'written' : 'failed');
    for (const k of state.selected.keys()) setWriteState('feat:' + k, ok ? 'written' : 'failed');
    if (!ok) {
      alert('写入后校验发现差异，以下条目已标记为「写入失败」：\n' +
        diff.slice(0, 8).map((d) => `Byte${d.addr}: ${hex8(d.from)} → ${hex8(d.to)}`).join('\n'));
    } else {
      alert('写入完成，读回校验一致。所选项已标记为「已写入」。');
    }
    state.baseline = back.clone();
    state.block = back;
    // 写入后按新块重算对齐状态（DATA1 变了、DATA3 不变 → 新增/移除状态立即更新）
    if (ok) {
      applyAlignment(state.block.bytes, state.data3, { log: true });
      renderAlign();
    }
    // 清空待写选择，但保留状态徽标供查看
    state.namedPicks.clear();
    state.selected.clear();
    renderEditor(); renderNamed(); renderFeatures(); detectConflicts();
    if (ok) stageDone('配置已写入并校验通过'); else stageFail('写入完成，但读回校验发现差异');
  } catch (e) {
    for (const k of state.namedPicks.keys()) setWriteState('named:' + k, 'failed');
    for (const k of state.selected.keys()) setWriteState('feat:' + k, 'failed');
    renderNamed(); renderFeatures();
    stageFail('写入失败：' + e.message);
    alert('写入失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : '') + '\n\n所选项已标记为「写入失败」。');
  } finally {
    if (state.busy === '写入配置') state.busy = null;
  }
}
// 「写入 ECU」在三处等价：字节编辑器页 / 隐藏功能页 / 待写浮动条
for (const id of ['btnWrite', 'btnWriteFeatures', 'fwWrite']) $(id).addEventListener('click', writeToEcu);

/** 待写浮动条：有待写选择时提示并直达「写入 ECU」 */
function updateFloatBar() {
  const bar = $('floatWriteBar');
  if (!bar) return;
  const n = state.namedPicks.size + state.selected.size;
  const show = n > 0 && state.readDone;
  bar.classList.toggle('hidden', !show);
  // 移动端底部还有固定的标签栏：显示悬浮条时给正文补底部留白（见 mobile.css）
  document.body.classList.toggle('has-float-write', show);
  $('fwCount').textContent = n;
}
$('fwPreview').addEventListener('click', async () => {
  $('btnApply').click();                       // 先合入字节块
  await new Promise((r) => setTimeout(r, 350));
  document.querySelector('.tabs .tab[data-tab="editor"]')?.click();
});

/* ================= PROXI 对齐 ================= */
function nodeGroupOf(n) {
  return n.swapCable ? 'swap' : (n.baud === 125 ? 'comfort' : 'plain');
}

/**
 * 对齐状态（位图口径，2026-10-29 按实车行为重写）。
 *
 * 状态**不是**逐节点读 22 10 2A（那只是写入后的单节点回读校验，实车大量模块不应答），
 * 而是车身电脑的 DATA1/DATA3 位图比对：
 *   DATA1[25..40] = 配置位图（PROXI 里应该有哪些节点）
 *   DATA3[32..47] = 实际位图（车上实际有哪些节点）
 *   DATA3[48..63] / [64..79] = EOL 期望/完成位图
 * 节点 startByte 是位图索引（1..16），不是 PROXI 字节号 —— SGW 节点 startByte=2
 * 对应命名项「SGW」Byte40 已交叉验证。判定集中在 src/alignment.js。
 */
function nodeRow(node) {
  return (state.alignment && state.alignment.byName.get(node.name)) || null;
}

/** 该节点物理上是否在车上（实际位图）；未读 DATA3 时返回 null */
function nodePresent(node) {
  const row = nodeRow(node);
  return row ? row.actual : null;
}

/**
 * 该节点是否可写入对齐。
 * 只有「实际位图置位 + 有独立诊断地址」的节点才允许勾选/写入：
 * 待移除（配置里有、车上没有）与未安装节点都没有写入目标。
 */
function nodeAlignable(node) {
  return !!node && nodePresent(node) === true && nodeAddressable(node);
}

/** 该节点是否出现在配置或实际位图中（对齐页展示范围） */
function nodeListed(node) {
  const row = nodeRow(node);
  return row ? row.listed : null;
}

/** 用 DATA1/DATA3 重算对齐状态（纯计算，不写车） */
function applyAlignment(data1, data3, opts = {}) {
  const nodes = state.modules ? state.modules.alignmentNodes : [];
  state.alignment = computeAlignment(data1, data3, nodes);
  if (opts.log) {
    const c = state.alignment.counts;
    if (state.alignment.ok) {
      log(`对齐状态：${c.listed} 个节点 · 需对齐 ${c.needs} 个`
        + `（新增 ${c.added} / 移除 ${c.removed}）`
        + (c.eolFailed ? ` · EOL 未完成 ${c.eolFailed}` : ''));
    } else {
      log('对齐状态不可用：' + state.alignment.reason);
    }
  }
  return state.alignment;
}

/**
 * 读车身 DATA1 + DATA3 并重算对齐状态（只读，不写车）。
 * 「读取对齐状态」与对齐结束后的复检共用这一条链路。
 */
async function refreshAlignment(opts = {}) {
  await state.session.ensureModule(state.session.bodyModule);
  const d1a = await state.uds.readProxi();
  const data3 = await state.uds.readDataByIdentifier(DID.DATA3);
  // 双读一致性（车端流程同样会重读比对）：连续两次 DATA1 不一致 = 总线抖动，不用脏数据判状态
  const d1b = await state.uds.readProxi();
  const same = d1a.length === d1b.length && d1a.every((b, i) => b === d1b[i]);
  if (!same) throw new Error('连续两次读取 DATA1 不一致（总线抖动），请重试');
  state.data3 = data3;
  return applyAlignment(d1a, data3, { log: opts.log !== false });
}

/** 当前勾选的节点（按 DOM 顺序） */
function selectedNodes() {
  return [...document.querySelectorAll('.node')]
    .filter((el) => {
      const cb = el.querySelector('.pick');
      return cb && cb.checked && !cb.disabled;   // 「待移除」节点不可写，勾选也应无效
    })
    .map((el) => state.modules.alignmentNodes[Number(el.dataset.idx)]);
}
function forEachNodeEl(fn) {
  document.querySelectorAll('.node').forEach((el) => fn(el, state.modules.alignmentNodes[Number(el.dataset.idx)]));
}
function setSelection(pred) {
  forEachNodeEl((el, n) => {
    const cb = el.querySelector('.pick');
    if (!cb || cb.disabled) return;        // 无诊断地址的节点不可勾选
    cb.checked = pred(el, n);
  });
  updateAlignButtons();
}
function updateAlignButtons() {
  const n = selectedNodes().length;
  $('btnAlign').textContent = n ? `对齐所选节点（${n}）` : '对齐所选节点';
  $('btnAlign').disabled = n === 0;
}

/**
 * 该节点是否有独立诊断地址。addr=00 的节点在数据里只有共享的 22 20 23
 * 车身块读取，没有自己的 22/2E 命令；对齐时也没有写入目标，直接忽略。
 */
function nodeAddressable(n) {
  return !!n && !n.addrUnknown && String(n.addr).toUpperCase() !== '00';
}

/**
 * 加载时清理“不参与”的项，而不是渲染后再置灰：
 *  - PROXIX1 是 PROXI 对齐程序本身，不是可手动诊断的 ECU；从模块/实时/DTC/功能下拉移除；
 *  - alignmentNodes 只保留有独立诊断地址且非平台 excluded 的节点；addr=00 的节点
 *    只有车身块 presence 位、没有自己的读写命令，直接忽略；
 *  - 15 个其它平台专属 excluded 节点移除；
 *  - functions 里 PROXIX1 的 45 条对齐副本没有可执行意义（原本点击也会被拦），移除。
 * 源 JSON 保留完整数据供追溯/重建，这里只清理 UI 流程。
 */
function removeNonParticipating() {
  state.modules.modules = state.modules.modules.filter((m) => m.code !== 'PROXIX1');
  // 只保留可独立寻址的节点；addr=00 没有自己的读写命令，直接忽略
  state.modules.alignmentNodes = state.modules.alignmentNodes.filter((n) => !n.excluded && nodeAddressable(n));
  state.funcs.categories = state.funcs.categories
    .map((c) => ({
      ...c,
      items: c.items.filter((i) => i.module !== 'PROXIX1' && i.category !== 'PROXI 对齐'),
    }))
    .filter((c) => c.items.length)
    .map((c) => ({ ...c, count: c.items.length }));
  state.funcs.total = state.funcs.categories.reduce((n, c) => n + c.items.length, 0);
}

function renderAlign() {
  const wrap = $('alignGroups');
  wrap.innerHTML = '';
  const al = state.alignment;
  if (!state.block || !al || !al.ok) {
    const why = !state.block ? '请先读取车辆配置'
      : (al && al.reason ? al.reason : '对齐状态不可用');
    wrap.innerHTML = `<div class="dim" style="padding:16px">${why}；状态由车身电脑 DATA1/DATA3 位图比对得出。</div>`;
    ['stTotal', 'stDone', 'stFail', 'stPending'].forEach((id) => { if ($(id)) $(id).textContent = '0'; });
    if ($('stPresent')) $('stPresent').textContent = '—';
    if ($('stAligned')) $('stAligned').textContent = '—';
    if ($('stMisaligned')) $('stMisaligned').textContent = '—';
    $('alignVerdict').classList.add('hidden');
    return;
  }
  state.modules.alignmentNodes.forEach((n, i) => { n._idx = i; });
  const groups = { plain: [], comfort: [], swap: [] };
  for (const n of state.modules.alignmentNodes) {
    if (n.excluded || !nodeAddressable(n)) continue;   // addr=00 无独立读写命令，直接忽略
    groups[nodeGroupOf(n)].push(n);
  }

  const statusHtml = (row) => {
    if (!row || !row.listed) return '<b>未安装</b>';
    switch (row.status) {
      case 'ok': return '<b>✓ 已对齐</b>';
      case 'eol-ok': return '<b>✓ 已对齐</b><br><span class="reason">EOL Ok</span>';
      case 'added': return '<b>＋ 待添加</b><br><span class="reason">车上存在，配置里没有</span>';
      case 'removed': return '<b>－ 待移除</b><br><span class="reason">配置里有，车上不存在</span>';
      case 'eol-failed': return '<b>⚠ EOL 未完成</b>';
      default: return `<b>${ALIGN_STATUS_LABEL[row.status] || row.status}</b>`;
    }
  };
  const dataSt = (row) => {
    if (!row || !row.listed) return 'absent';
    if (row.status === 'ok' || row.status === 'eol-ok') return 'aligned';
    if (row.status === 'eol-only') return 'absent';   // 只在 EOL 位图里出现，车上没有 → 不计入需对齐
    return 'misaligned';
  };

  const c0 = al.counts;
  for (const key of ['plain', 'comfort', 'swap']) {
    const list = groups[key];
    if (!list.length) continue;
    const actualCount = list.filter((n) => nodePresent(n) === true).length;
    const listedCount = list.filter((n) => nodeListed(n)).length;
    const absentCount = list.length - listedCount;
    const removedCount = list.filter((n) => nodeRow(n)?.status === 'removed').length;
    // EOL 期望位图有数据时才标注「不在 EOL 位图」——量产车 E 可能全 0（无 EOL 数据），
    // 那时给每个节点都挂个标签纯属噪音。
    const eolKnown = c0.eolExpected > 0;
    const div = document.createElement('div');
    div.className = 'group collapsed-absent';
    div.innerHTML = `
      <header>
        <h3>${state.modules.busGroups[key].label}</h3>
        <span class="meta">${actualCount} 个在位可对齐${removedCount ? ` · ${removedCount} 个仅配置（不可写）` : ''}${absentCount ? ` · ${absentCount} 个未安装` : ''} · ${state.modules.busGroups[key].baud}kbit/s · ${
          state.modules.busGroups[key].cable === 'none' ? '无需换线' : state.modules.busGroups[key].cable
        }</span>
        ${absentCount ? `<button class="toggle-absent" data-group="${key}">显示未安装节点</button>` : ''}
      </header>
      <div class="nodes">${list.map((n) => {
        const row = nodeRow(n);
        const listed = !!(row && row.listed);
        const actual = !!(row && row.actual);
        const st = dataSt(row);
        const eolTag = (eolKnown && actual && row && !row.eol)
          ? ' <span class="tiny" title="该节点在实际位图中在位，但 EOL 期望位未置位。车端全量对齐按 EOL 位图取节点，通常不写它（多见于后加装件）；写入前会单独确认">EOL 位未置</span>'
          : '';
        return `
        <div class="node${listed ? '' : ' absent'}${row && row.status === 'removed' ? ' removed' : ''}" data-st="${st}" data-group="${key}" data-idx="${n._idx}">
          <input type="checkbox" class="pick"${actual ? ' checked' : ' disabled'}>
          <div class="nm">${tSpan(n.name)}${eolTag}</div>
          <div class="ad">地址 0x${n.addr} · ${n.baud}k</div>
          <div class="st">${statusHtml(row)}</div>
        </div>`;
      }).join('')}</div>`;
    wrap.appendChild(div);
  }

  const c = al.counts;
  $('stTotal').textContent = c.listed;
  $('stPresent').textContent = c.present;
  $('stAligned').textContent = c.ok + c.eolOk;
  $('stMisaligned').textContent = c.added + c.removed + c.eolFailed;
  $('stDone').textContent = 0;
  $('stFail').textContent = 0;
  $('stPending').textContent = 0;

  const verdict = $('alignVerdict');
  verdict.classList.remove('hidden', 'ok', 'bad');
  if (c.needs === 0 && c.eolFailed === 0) {
    verdict.classList.add('ok');
    // ⚠️ 位图只能证明「配置 ↔ 实际」一致，证明不了每个模块存储块都等于车身块。
    //    换过模块（存储块是旧的、位图却正常）时里程表照样闪，所以别把话说满。
    verdict.textContent = `✓ 配置位图一致（${c.present} 个在位节点，无新增/移除）；若里程表仍闪，点「全部对齐」重写全部在位节点`;
  } else {
    verdict.classList.add('bad');
    const parts = [];
    if (c.added) parts.push(`新增 ${c.added}`);
    if (c.removed) parts.push(`移除 ${c.removed}`);
    if (c.eolFailed) parts.push(`EOL 未完成 ${c.eolFailed}`);
    verdict.textContent = `⚠ ${c.needs + c.eolFailed} 个节点需要对齐（${parts.join(' / ')}）→ 里程表会闪烁`;
  }
  if (al.sgwPresent) log('检测到 SGW（安全网关）实际在位');

  forEachNodeEl((el) => el.querySelector('.pick')?.addEventListener('change', updateAlignButtons));
  wrap.querySelectorAll('.toggle-absent').forEach((b) => {
    b.addEventListener('click', () => {
      const g = b.closest('.group');
      const on = g.classList.toggle('collapsed-absent');
      b.textContent = on ? '显示未安装节点' : '隐藏未安装节点';
    });
  });
  updateAlignButtons();
}

/** 把视图定位到某类节点：滚动到第一个，并高亮闪烁 */
function focusNodes(pred) {
  const list = [...document.querySelectorAll('.node')].filter((el) => pred(el));
  if (!list.length) return 0;
  // 先取消折叠，确保目标可见
  list.forEach((el) => el.closest('.group')?.classList.remove('collapsed-absent'));
  document.querySelectorAll('.toggle-absent').forEach((b) => {
    if (!b.closest('.group').classList.contains('collapsed-absent')) b.textContent = '隐藏未安装节点';
  });
  list[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  list.forEach((el) => {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  });
  return list.length;
}

/** 顶部统计点击：只勾选该类节点并定位 */
function bindStatFilter(boxId, pred) {
  const box = $(boxId);
  if (!box) return;
  box.addEventListener('click', () => {
    const n = focusNodes(pred);
    setSelection(pred);
    log(n ? `已定位并勾选 ${n} 个节点` : '没有符合条件的节点');
  });
}

/**
 * 读取对齐状态 —— 与车端已验证流程同口径：只进车身电脑，读 DATA1 + DATA3 位图比对。
 *
 * ⚠️ **不再逐节点读 22 10 2A**：那是写入后的单节点回读校验；实车上大量模块对该 DID
 *    不应答，逐节点读会得到「全都读不到 / 未对齐」的假状态（2026-10-29 实车定论）。
 *    整车状态由 DATA1[25..40]（配置位图）与 DATA3[32..47]（实际位图）比对得出：
 *      只在实际 → 待添加；只在配置 → 待移除；两者都有 → 已对齐（EOL 位另判）。
 * 进入车身模块后一次读取即可，秒级完成，不需要换线，也不需要取消按钮。
 */
$('btnCheckAlign').addEventListener('click', async () => {
  if (!(await ensureRead())) return;
  if (state.aligning) return alert('正在执行 PROXI 对齐，请等它结束再读取状态。');
  if (state.busy) return alert(`正在执行「${state.busy}」，请等它结束。`);
  stopLiveForOperation('读取对齐状态');
  if (state.session) state.session.resetCableAbort();
  state.busy = '读取对齐状态';
  $('btnCheckAlign').disabled = true;
  try {
    stage('正在读取车身电脑 DATA1 / DATA3…');
    const res = await refreshAlignment({ log: true });
    if (!res.ok) throw new Error(res.reason || 'DATA1/DATA3 位图不足');
    renderAlign();
    const c = res.counts;
    if (c.needs === 0 && c.eolFailed === 0) {
      stageDone(`配置位图一致：${c.present} 个在位节点，无新增/移除`);
    } else {
      stageFail(`对齐状态：${c.listed} 个节点，需对齐 ${c.needs} 个`
        + `（新增 ${c.added} / 移除 ${c.removed}）`
        + (c.eolFailed ? ` / EOL 未完成 ${c.eolFailed}` : ''));
    }
  } catch (e) {
    stageFail('读取对齐状态失败：' + e.message);
    alert('读取对齐状态失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
  } finally {
    state.busy = null;
    $('btnCheckAlign').disabled = false;
  }
});

$('btnAlignAll').addEventListener('click', () => {
  // 全部对齐 = **只勾选实际在位（DATA3 实际位图）的节点**，待移除/未安装一律不可写
  setSelection((el, n) => nodeAlignable(n));
  $('btnAlign').click();
});
// 「重算对齐状态」：按当前块与 DATA3 重新比对位图（改过在场位配置后使用）
$('btnPresenceReset').addEventListener('click', () => {
  if (!state.block) return alert('请先读取车辆配置');
  if (!state.data3) return alert('还没有读到 DATA3（CAN 配置块）。\n请重新「读取车辆配置」后再重算。');
  if (!confirm('按当前配置块重新比对 DATA1 / DATA3 位图？\n\n用于：改过在场位配置 / 换过车 / 增删过模块。\n只重算状态，不会写车。')) return;
  const res = applyAlignment(state.block.bytes, state.data3, { log: true });
  renderAlign();
  if (!res.ok) return alert('重算失败：' + res.reason);
  stageDone(`对齐状态已重算：需对齐 ${res.counts.needs} 个`
    + `（新增 ${res.counts.added} / 移除 ${res.counts.removed}）`);
});
bindStatFilter('stMisalignedBox', (el) => el.dataset.st === 'misaligned');
bindStatFilter('stFailBox', (el) => el.dataset.st === 'fail');
bindStatFilter('stAlignedBox', (el) => el.dataset.st === 'aligned');
$('btnSelAll').addEventListener('click', () => setSelection((el, n) => nodeAlignable(n)));
$('btnSelNone').addEventListener('click', () => setSelection(() => false));
$('btnSelFail').addEventListener('click', () =>
  setSelection((el) => el.dataset.st === 'fail' || el.dataset.st === 'misaligned'));
$('btnSelMisalign').addEventListener('click', () =>
  setSelection((el) => el.dataset.st === 'misaligned' || el.dataset.st === 'fail'));

$('btnAlign').addEventListener('click', async () => {
  if (state.aligning) return;
  if (state.busy) return alert(`正在执行「${state.busy}」，请等它结束再开始对齐。`);
  if (!(await ensureRead())) return;
  stopLiveForOperation('PROXI 对齐');
  if (state.session) state.session.resetCableAbort();
  // 教程 §5.3 对齐前安全警告（ABS 复位/标定、勿中断、钥匙 ON）
  const warn = '开始 PROXI 对齐？该过程将逐节点写入配置。\n\n'
    + '⚠ 对齐会复位 ABS（Giulia/Stelvio），完成后需做转向角、加速度、胎压标定。\n'
    + '⚠ 一旦开始不要中断。钥匙 ON、发动机 OFF。\n\n'
    + '确认已了解上述注意事项并继续？';
  if (!confirm(warn)) return;
  const chosen = selectedNodes();
  if (!chosen.length) return alert('请先勾选要对齐的节点');
  // —— 硬闸：只允许写「实际在位（DATA3 实际位图）」的节点 ——
  // 正常路径下复选框已经 disabled，但状态可能刚被「重算」过、DOM 还留着旧勾选，
  // 写入前再按位图核一遍，避免把 2E 20 23 发给不存在的模块（逐节点超时，整轮白跑）。
  if (!state.alignment || !state.alignment.ok) {
    stageFail('对齐状态不可用，已中止');
    return alert('还没有可用的对齐状态（DATA1/DATA3 位图）。\n请先点「读取对齐状态」，确认哪些节点实际在位后再对齐。');
  }
  const notPresent = chosen.filter((n) => nodePresent(n) !== true);
  if (notPresent.length) {
    stageFail(`有 ${notPresent.length} 个节点不在实际位图中，已中止`);
    return alert(`以下 ${notPresent.length} 个节点不在 DATA3 实际位图中（车上没有），不能写入：\n\n`
      + notPresent.slice(0, 10).map((n) => '· ' + String(n.name)).join('\n')
      + (notPresent.length > 10 ? '\n…' : '')
      + '\n\n请重新「读取对齐状态」后再选。');
  }
  // —— 写前双重读一致性（标准流程）：连续两次读车身块必须一致，防读链路抖动把脏数据写下去 ——
  // ⚠️ 必须先切回车身电脑：用户可能刚从「实时数据/诊断」退出，session 还停在 ABS/EPS 上，
  //    那些模块也有一份 289 字节 PROXI 块，会返回"格式合法但内容不是车身电脑"的数据，
  //    双读一致性照样"通过"，却把错块当基准（2026-10-18 审查 H3）。
  let liveBlock = null;   // 车身电脑当前块 —— 判定「部分对齐是否安全」的基准
  try {
    stage(`正在连接模块：${modLabel(state.session.bodyModule)}…`);
    await state.session.ensureModule(state.session.bodyModule);
    stage('写前一致性校验：连续两次读取车身配置…');
    const r1 = await state.uds.readProxi();
    const r2 = await state.uds.readProxi();
    const eq = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
    if (!eq(r1, r2)) {
      stageFail('写前校验未过：连续两次读取不一致（总线抖动），已中止');
      alert('写前一致性校验未通过：连续两次读取车身配置结果不一致。\n为避免把脏数据写入节点，对齐已中止，请稍后重试。');
      return;
    }
    liveBlock = r1;
    // 定长块保护：写入的块必须与车身电脑当前块等长，否则 2E 长度不符（拒写/截断）
    if (state.block.length !== liveBlock.length) {
      stageFail(`配置块长度 ${state.block.length} 与车身电脑 ${liveBlock.length} 不一致，已中止对齐`);
      alert(`配置块长度不一致：待写 ${state.block.length} 字节 / 车上 ${liveBlock.length} 字节。\n\n`
        + 'PROXI 是定长块，长度不符不能写入。请重新读取车辆配置，或导入正确备份。对齐已中止。');
      return;
    }
    log('写前一致性校验通过（两次读取一致）');
  } catch (e) {
    stageFail('写前校验失败：' + e.message);
    alert('写前一致性校验失败：' + e.message + '\n对齐已中止。');
    return;
  }
  // —— 对齐前言（与标准流程步骤 0 逐条一致）：读 DATA1 + DATA1S + TesterPresent ——
  try {
    stage('对齐前言：读取 DATA1 / DATA1S + 保活…');
    const pre = await state.uds.alignPrelude();
    log(`对齐前言完成：DATA1 ${pre.data1?.length ?? 0} 字节 · `
      + `DATA1S ${pre.data1s ? pre.data1s.length + ' 字节' : '（不支持/未取到）'}`);
  } catch (e) {
    log('对齐前言失败（继续，但建议检查链路）：' + e.message);
  }
  // —— 对齐前置：merge DATA3 → 重算 CRC ——
  // 映射：PROXIX 家族 DATA1[25..56] = DATA3[32..63]（正序），SGW 在 Byte41 落在该区。
  try {
    stage('正在读取 DATA3 并合并 CAN 配置…');
    const { data3 } = await state.uds.readProxiAll();
    const m = state.block.mergeData3(data3);
    if (m.merged && m.changed > 0) {
      renderEditor();
      const go = confirm(
        `DATA3 的 CAN 配置与当前块不一致，已合并 ${m.changed} 处到 Byte26–57（含 SGW 状态等）。\n\n`
        + '这是对齐的标准步骤：用实际 CAN 配置刷新 PROXI 镜像区。\n'
        + '「字节编辑器」里这些字节会显示为变化，属正常。\n\n继续对齐？'
      );
      if (!go) return;
    } else if (!m.merged && m.reason) {
      log('DATA3 合并跳过：' + m.reason);
    } else {
      log('DATA3 与 DATA1[25..57] 已一致，无需合并');
    }
  } catch (e) {
    log('DATA3 读取失败（跳过合并，仍按当前块对齐）：' + e.message);
  }
  // 发 2E 20 23 前无条件重算 CRC（B7–B11）。
  // 手动改字节时 afterByteEdit 已 seal 过，mergeData3 内也会 seal——这里再兜一次底。
  state.block.seal();

  // ===== 部分对齐安全闸（2026-16-16）=====
  // 「单独对齐几个模块」要成立，前提是**写下去的块 == 未勾选节点当前持有的块**。
  // 只要块被改过（DATA3 合并 / 编辑器改过 / 与车身当前块不一致），只对齐子集就会出现
  // **分裂脑**：已对齐节点持新块、未勾选节点持旧块 → 里程表闪烁照样不停。
  // 标准流程的节点勾选框（CheckBox 列）只用于**选择要对齐谁**，不改变这个前提。
  const bytesEq = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  const blockDrifted = !bytesEq(state.block.bytes, liveBlock);
  const presentEls = [...document.querySelectorAll('.node')]
    .filter((el) => nodeAlignable(state.modules.alignmentNodes[Number(el.dataset.idx)]));
  const allIdx = new Set(presentEls.map((el) => Number(el.dataset.idx)));
  const chosenIdx = new Set(chosen.map((n) => n._idx));
  const isSubset = chosen.length > 0 && chosen.length < allIdx.size;

  if (blockDrifted && isSubset) {
    const auto = confirm(
      '⚠ 当前要写入的配置块与车身电脑当前块不一致（DATA3 合并或手动改过字节）。\n\n'
      + `此时只对齐选中的 ${chosen.length} 个节点，会让其余 ${allIdx.size - chosen.length} 个已安装节点`
      + '仍持有旧配置 —— **里程表闪烁不会停止**。\n\n'
      + '「单独对齐」只在「块没变、只有个别节点跑偏」时才成立。\n\n'
      + '点「确定」= 自动改为对齐全部已安装节点（推荐）\n'
      + '点「取消」= 仍只对齐选中节点（不推荐，会留下分裂脑）'
    );
    if (auto) {
      for (const el of presentEls) {
        const cb = el.querySelector('.pick');
        if (cb) cb.checked = true;
      }
      chosenIdx.clear();
      for (const i of allIdx) chosenIdx.add(i);
      log(`已自动改为对齐全部 ${allIdx.size} 个已安装节点（配置块已变化，部分对齐不安全）`);
    } else {
      log(`⚠ 用户选择在块已变化时只对齐 ${chosen.length} 个节点 —— 未选节点将持有旧块，闪烁可能不停`);
    }
  } else if (isSubset) {
    log(`部分对齐：${chosen.length}/${allIdx.size} 个节点（配置块与车身一致）`);
  }

  // ===== 第二道闸：漏选的「未对齐/失败」节点 =====
  // 上面只防了「块变了」的分裂脑。还有一个场景：checkAlign 查出 3 个未对齐，
  // 用户只勾了 2 个 → 对齐完第 3 个仍跑偏 → **里程表照样闪**。
  // 对齐完成后不会有任何提示说「还有没对齐的」——必须在开跑前问清楚。
  {
    const leftover = [...document.querySelectorAll('.node')]
      .filter((el) => {
        const cb = el.querySelector('.pick');
        const st = el.dataset.st;
        return cb && !cb.disabled && (st === 'misaligned' || st === 'fail')
          && !chosenIdx.has(Number(el.dataset.idx));
      });
    if (leftover.length) {
      const names = leftover.slice(0, 8).map((el) => {
        const nm = el.querySelector('.nm');
        return nm ? nm.textContent.trim() : '?';
      });
      const more = leftover.length > 8 ? `…等 ${leftover.length} 个` : '';
      const goOn = confirm(
        `⚠ 还有 ${leftover.length} 个节点**未对齐但没被选中**：\n\n${names.join('\n')}${more}\n\n`
        + '对齐只写入选中的节点 —— 这些仍然跑偏，**里程表会继续闪**。\n\n'
        + '点「确定」= 一并勾选它们（推荐）\n'
        + '点「取消」= 只对齐选中节点（里程表仍会闪）');
      if (goOn) {
        for (const el of leftover) {
          const cb = el.querySelector('.pick');
          if (cb) cb.checked = true;
        }
        chosenIdx.clear();
        for (const i of allIdx) {
          const el = [...document.querySelectorAll('.node')].find((x) => Number(x.dataset.idx) === i);
          const cb = el && el.querySelector('.pick');
          if (cb && cb.checked && !cb.disabled) chosenIdx.add(i);
        }
        log(`已补选 ${leftover.length} 个未对齐节点`);
      } else {
        log(`⚠ 用户选择跳过 ${leftover.length} 个未对齐节点 —— 对齐后里程表仍会闪`);
      }
    }
  }

  let chosenNodes = [...document.querySelectorAll('.node')]
    .filter((el) => chosenIdx.has(Number(el.dataset.idx)));

  // —— 与车端全量口径核对 ——
  // 车端写入循环对每个节点先查 EOL 期望位图（DATA3[48..63]），位为 0 直接跳过
  // 车端全量写入循环里就有这道过滤。量产车该位图可能全 0（无 EOL 数据），那时等价于不过滤；
  // 只有它确实有数据时，才把「实际在位但不在 EOL 位图」的节点单独确认，
  // 避免与官方全量口径悄悄分叉（多见于后加装件）。
  const eolKnown = state.alignment.counts.eolExpected > 0;
  if (eolKnown) {
    const extra = chosenNodes.filter((el) => {
      const row = nodeRow(state.modules.alignmentNodes[Number(el.dataset.idx)]);
      return !!(row && row.actual && !row.eol);
    });
    if (extra.length) {
      const names = extra.slice(0, 8).map((el) => '· ' + el.querySelector('.nm').textContent.trim());
      const more = extra.length > 8 ? `\n…等 ${extra.length} 个` : '';
      const goOn = confirm(
        `⚠ 有 ${extra.length} 个节点实际在位，但不在车端的 EOL 期望位图中：\n\n${names.join('\n')}${more}\n\n`
        + '车端全量对齐按 EOL 位图取节点，通常不写它们（多见于后加装件）。\n'
        + '写入的是同一份配置块，不会影响其它节点，只是比官方多写这一部分。\n\n'
        + '点「确定」= 照常写入（保证车上在位节点全部对齐）\n'
        + '点「取消」= 去掉这些节点，只写 EOL 位图内的节点'
      );
      if (!goOn) {
        for (const el of extra) { const cb = el.querySelector('.pick'); if (cb) cb.checked = false; }
        chosenNodes = chosenNodes.filter((el) => !extra.includes(el));
        log(`已去掉 ${extra.length} 个不在 EOL 期望位图中的节点`);
        if (!chosenNodes.length) return alert('没有剩余可写节点。');
      } else {
        log(`按实际在位写入：其中 ${extra.length} 个不在 EOL 期望位图中（官方全量通常不写）`);
      }
    }
  }

  // —— 车身电脑必须参与 ——
  // 写入块与车身当前块不同（DATA3 合并 / 手动改过字节）时，只写其它节点、不写车身，
  // 会变成「车身持旧块、节点持新块」——比不对齐更糟，必然继续闪。这里强制补进车身节点。
  if (blockDrifted) {
    const bodyTx = String((state.cables?.modules?.[state.session.bodyModule] || {}).tx || '40').toUpperCase();
    const bodyNode = state.modules.alignmentNodes.find((n) => String(n.addr).toUpperCase() === bodyTx);
    if (!bodyNode) {
      stageFail('找不到车身电脑节点，已中止对齐');
      return alert('找不到车身电脑（BCM）的对齐节点，无法保证车身与各节点写入同一份配置块。\n对齐已中止。');
    }
    if (!nodeAlignable(bodyNode)) {
      stageFail('车身电脑不在实际位图中，已中止对齐');
      return alert('车身电脑（BCM）不在 DATA3 实际位图中。\n\n'
        + '配置块与车上当前块不一致时必须同时写入车身电脑，否则车身持旧块、其它节点持新块，'
        + '反而会造成里程表闪烁。\n\n请重新「读取对齐状态」确认后再试。');
    }
    const bodyEl = [...document.querySelectorAll('.node')].find((el) => Number(el.dataset.idx) === bodyNode._idx);
    const bodyCb = bodyEl && bodyEl.querySelector('.pick');
    if (bodyCb && !bodyCb.checked) {
      bodyCb.checked = true;
      chosenIdx.add(bodyNode._idx);
      chosenNodes = [...document.querySelectorAll('.node')].filter((el) => chosenIdx.has(Number(el.dataset.idx)));
      log('配置块已变化：已自动加入车身电脑（BCM），避免车身与节点持不同块');
    }
  }

  state.aligning = true;
  // ⚠️ 进度分母必须用"最终真正要写的节点数"：上面两道闸可能自动补选了节点，
  //    用一开始的 chosen.length 会让进度显示成 1/1 却实际跑了 35 个（2026-10-18 审查）。
  const total = chosenNodes.filter((el) => {
    const cb = el.querySelector('.pick');
    return cb && cb.checked && !cb.disabled;
  }).length;
  const failed = [];
  let cableCancelled = false;   // 作用域必须在两个循环之外：旧写法在 for 块内声明，块外引用会 ReferenceError
  try {
    const nodes = chosenNodes;
    let done = 0, fail = 0, idx = 0;
    for (const key of ['plain', 'comfort', 'swap']) {
      const grp = state.modules.busGroups[key].label;
      for (const el of nodes.filter((n) => n.dataset.group === key)) {
        const cb = el.querySelector('.pick');
        if (!cb || !cb.checked || cb.disabled) continue;
        const nodeMeta = state.modules.alignmentNodes[Number(el.dataset.idx)];
        idx++;
        const nodeName = el.querySelector('.nm').textContent.trim();
        // —— 开始：明确告知正在对齐哪一个 ——
        el.dataset.st = 'work';
        el.querySelector('.st').innerHTML = '<b>● 对齐中…</b>';
        stage(`⟳ 正在对齐 ${idx}/${total} · ${nodeName}`);
        await stageWait(260);

        let ok = true, errMsg = '', verified = true;
        try {
          // 逐节点连接（跨总线分组会提示换适配线），再写入 + 回读校验
          const node = state.modules.alignmentNodes[Number(el.dataset.idx)];
          await state.session.connectNode(node);
          await state.uds.writeProxi(state.block.bytes);
          // 写后按节点读 22 10 2A：存储块与基准块（车身电脑 PROXI）比对。
          // 22 10 2A 只是回读校验：实车不少模块对该 DID 不应答（NO DATA），
          // 2E 已回 6E 就不能因为“读不到”把写入判成失败 —— 标成“已写入（未回读）”。
          const v = await state.uds.verifyProxi(state.block.bytes).catch((e) => {
            if (e && (e.code === 'NO_DATA' || e.code === 'TIMEOUT' || e.code === 'BAD_FRAME')) {
              return { ok: true, diffs: [], unverified: true, why: e.message };
            }
            throw e;
          });
          if (!v.ok) {
            ok = false;
            errMsg = '回读校验发现差异：' + v.diffs.map((d) => `Byte${d.byte}`).join('、');
          } else if (v.unverified) {
            verified = false;
          }
        } catch (e) {
          ok = false; errMsg = e.message;
        }

        // 用户取消换线 = 主动终止整轮对齐（否则每个节点都会再报一次「已取消」，看着像全线故障）
        cableCancelled = /已取消：未确认换线|连接已断开/.test(errMsg);

        // —— 结束：立刻给出结论 ——
        if (ok) {
          el.dataset.st = 'ok';
          el.querySelector('.st').innerHTML = verified
            ? '<b>✓ 对齐成功</b>'
            : '<b>✓ 已写入</b><br><span class="reason">该模块不支持 22 10 2A 回读，未做回读校验</span>';
          done++;
          stage(verified
            ? `✓ ${idx}/${total} · ${nodeName} 对齐成功`
            : `✓ ${idx}/${total} · ${nodeName} 已写入（未回读）`);
        } else {
          el.dataset.st = 'fail';
          el.querySelector('.st').innerHTML = `<b>✗ 对齐失败</b><br><span class="reason">${errMsg}</span>`;
          failed.push(nodeName + '：' + errMsg);
          fail++;
          stage(`✗ ${idx}/${total} · ${nodeName} 对齐失败：${errMsg}`);
        }
        $('stDone').textContent = done;
        $('stFail').textContent = fail;
        $('stPending').textContent = total - done - fail;
        if (cableCancelled) {
          log('已取消换线，终止本轮对齐（剩余节点未处理）');
          break;
        }
        // 每节点之间留 ECU 存储沉降时间（标准流程 2.5 秒）
        await stageWait(2500);
      }
      if (cableCancelled) break;
    }
    // 全部节点完成后留 ECU 收尾时间（标准流程 1 秒）
    await stageWait(1000);
    // 结论条改成“本次运行结果”，避免残留开跑前的“需对齐 N 个”造成误解
    const vd = $('alignVerdict');
    vd.classList.remove('hidden', 'ok', 'bad');
    if (failed.length) {
      vd.classList.add('bad');
      vd.textContent = `对齐结束：成功 ${done} / 失败 ${fail}（失败节点可重试）`;
      stageFail(`对齐结束：成功 ${done} / 失败 ${fail}`);
      alert(`PROXI 对齐结束\n\n成功 ${done} 个节点\n失败 ${fail} 个节点：\n\n${failed.slice(0, 10).join('\n')}${failed.length > 10 ? '\n…' : ''}\n\n失败节点可重试。`);
    } else {
      vd.classList.add('ok');
      vd.textContent = `✓ 对齐完成：${done} 个节点全部成功；可重新「读取对齐状态」确认`;
      stageDone(`对齐完成：${done} 个节点全部成功`);
      alert(`PROXI 对齐完成\n\n${done} 个节点全部对齐成功`);
    }

    // —— 对齐后自动复检：结论必须来自车身位图，而不是「本次勾选了谁」 ——
    // 逐节点写入成功 ≠ 整车已对齐（例如待移除节点的配置位仍在 DATA1 里）。
    if (!cableCancelled) {
      try {
        stage('对齐结束，正在重读车身 DATA1 / DATA3 复检…');
        const res = await refreshAlignment({ log: true });
        if (res.ok) {
          const keepDone = done, keepFail = fail;
          renderAlign();                       // 节点列表按最新位图重画
          $('stDone').textContent = keepDone;   // 保留「本次成功/失败」，别被重置成 0
          $('stFail').textContent = keepFail;
          const cc = res.counts;
          const left = cc.needs + cc.eolFailed;
          vd.classList.remove('hidden', 'ok', 'bad');
          vd.classList.add(left ? 'bad' : 'ok');
          vd.textContent = left
            ? `本次成功 ${done} / 失败 ${fail}；重读位图仍有 ${left} 个需对齐`
              + `（新增 ${cc.added} / 移除 ${cc.removed}${cc.eolFailed ? ` / EOL 未完成 ${cc.eolFailed}` : ''}）`
            : `✓ 本次成功 ${done} / 失败 ${fail}；重读位图：${cc.present} 个在位节点，无新增/移除`;
          if (left) log(`⚠ 对齐后复检：仍有 ${left} 个节点需对齐（新增 ${cc.added} / 移除 ${cc.removed}）`);
        }
      } catch (e) {
        log('对齐后重读状态失败（不影响已完成的写入）：' + e.message);
      }
    }
  } finally {
    state.aligning = false;
    if (state.session) state.session.resetCableAbort();
  }
});

/* ================= 输入对话框（按类型给单位/区间/选项） ================= */
function askInput(item) {
  return new Promise((resolve) => {
    const spec = item.input || { kind: 'number' };
    const box = $('inputModal'), ctrl = $('imControl'), hint = $('imHint');
    $('imTitle').textContent = t(item.name);

    // 提示：单位 / 区间 / 步进 / 可选值
    const parts = [];
    if (spec.kind === 'enum') {
      parts.push(`共 ${spec.options.length} 个可选值，请从列表中选择（不支持自由输入）`);
    } else if (spec.kind === 'number') {
      if (spec.unit) parts.push(`单位：${spec.unit}`);
      if (spec.min !== undefined) parts.push(`取值范围：${spec.min} ~ ${spec.max}`);
      if (spec.step) parts.push(`步进：${spec.step}`);
      if (spec.maxDigits) parts.push(`最多 ${spec.maxDigits} 位数字`);
      if (spec.scale && spec.scale !== 1) parts.push(`写入值 = 输入值 ÷ ${spec.scale}（内部按 ${spec.scale} 为一档）`);
    } else if (spec.kind === 'date') {
      parts.push('日期格式：年-月-日');
    } else if (spec.kind === 'hex') {
      parts.push('十六进制输入，按字节填写');
    }
    if (item.security && item.security.level === 'pin') parts.push('该项目需要 5 位 PIN 才能写入');
    hint.innerHTML = parts.join('<br>');
    // 功能自带的警告（如「新车型不能写更大值」）单独高亮
    const warnEl = $('imWarn');
    if (item.warning) {
      warnEl.innerHTML = `<strong>⚠ 注意：</strong>${t(item.warning)}`;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    if (spec.kind === 'enum') {
      const multiPos = spec.bytes > 4 && spec.options.length > 8;
      // 选项 label 可能为空（VIN 类字符盘的「空格」= 0x20），空标签在下拉里看不见 → 显式标注
      const optLabel = (o) => (t(o.label) || o.label || '(空格)');
      if (multiPos) {
        // 多位输入（RWUSERENTRY 29 族，如 VIN 逐位）：每位一个下拉，选项表是字符/字节盘
        ctrl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px">${Array.from({ length: spec.bytes }, (_, i) =>
          `<select class="imPos" data-i="${i}" style="min-width:62px">${spec.options.map((o, j) =>
            `<option value="${j}">${optLabel(o)}</option>`).join('')}</select>`).join('')}</div>`;
      } else {
        ctrl.innerHTML = `<select id="imValue">${spec.options.map((o, i) =>
          `<option value="${i}">${optLabel(o)}</option>`).join('')}</select>`;
      }
    } else if (spec.kind === 'number') {
      ctrl.innerHTML = `<input id="imValue" type="number" inputmode="decimal"
        ${spec.min !== undefined ? `min="${spec.min}"` : ''} ${spec.max !== undefined ? `max="${spec.max}"` : ''}
        ${spec.step ? `step="${spec.step}"` : ''} value="${spec.min ?? 0}">`;
    } else if (spec.kind === 'date') {
      ctrl.innerHTML = `<input id="imValue" type="date">`;
    } else {
      ctrl.innerHTML = `<input id="imValue" placeholder="十六进制值" spellcheck="false">`;
    }

    const done = (v) => {
      box.classList.add('hidden');
      $('imOk').onclick = $('imCancel').onclick = null;
      resolve(v);
    };
    $('imOk').onclick = () => {
      const posEls = [...document.querySelectorAll('.imPos')];
      if (spec.kind === 'enum' && posEls.length) {
        // 多位输入：收集每位的选择
        const positions = posEls.map((el) => spec.options[Number(el.value)]);
        return done({ multi: true, positions, label: positions.map((p) => (p && p.label) || '').join('') });
      }
      const el = $('imValue');
      if (spec.kind === 'enum') return done(spec.options[Number(el.value)]);
      const raw = el.value.trim();
      if (spec.kind === 'number') {
        const n = Number(raw);
        if (raw === '' || Number.isNaN(n)) return alert('请输入有效数值');
        if (spec.min !== undefined && n < spec.min) return alert(`不能小于 ${spec.min}${spec.unit || ''}`);
        if (spec.max !== undefined && n > spec.max) return alert(`不能大于 ${spec.max}${spec.unit || ''}`);
        return done({ value: n, label: `${n}${spec.unit ? ' ' + spec.unit : ''}` });
      }
      if (!raw) return alert('请输入内容');
      return done({ value: raw, label: raw });
    };
    $('imCancel').onclick = () => done(null);
    box.classList.remove('hidden');
    setTimeout(() => $('imValue') && $('imValue').focus(), 30);
  });
}

/* ================= 特殊功能 ================= */
/** 把命令串拆成 UDS 载荷逐帧下发 */
/**
 * 执行特殊功能命令串（命令模板格式：逗号分隔的 token，每个 `NN<data>`）。
 *
 * token 类型（2026-10-10 全量复查 functions.json 确认）：
 *   · NN=0x01–0x07   单帧 UDS：payload = data[0..NN]
 *   · NN=0x08–0x99   多帧 UDS：payload = data[0..NN]（如 VIN 写 0x14、喷油嘴 0x0C、PROXI 整块 0x99）
 *                    → 直接交 link.request，它内部 #sendMulti 已做 ISO-TP 多帧
 *   · NN=0xFE        脚本步骤/循环计数器（FE0002→FE0003…）：不发送，仅步进
 *   · NN=0xFF        延时（FFxxyy = (xx<<8|yy) **秒**，不是毫秒）：FF000A=10 秒
 *                    ⚠️ 曾误当毫秒（该等 10 秒的只等 10ms，执行器时序全乱），实现已按秒
 *   · NN=0x00        期望响应模板（00 71 03…/00 FF FF…）：不发送，校验用
 *
 * 早期版本误 `if (len > 7) continue` 把多帧 UDS + FE/FF 全静默丢弃（61 个功能条目受影响）——
 * 只对齐了主干写入，漏了功能层的命令模板分支，实测才暴露。
 */
/** 读改写字段合并（RWUSERENTRY 族语义）：基线=读回值，选择值按掩码并入字段 */
function mergeWriteField(field, base, picked, item) {
  const out = Uint8Array.from(field);
  const spec = item.input || {};
  const take = (i) => (base && i < base.length ? base[i] : out[i]);
  if (picked.multi && picked.positions) {
    for (let i = 0; i < out.length; i++) {
      const p = picked.positions[i];
      if (!p) continue;
      const m = (p.mask ?? 0xff) & 0xff;
      out[i] = (take(i) & ~m) | ((Number(p.value) & m) & 0xff);
    }
    return out;
  }
  if (spec.kind === 'hex') {
    const hex = String(picked.value ?? picked).replace(/[^0-9a-fA-F]/g, '');
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2) || '00', 16);
    return out;
  }
  if (picked && typeof picked === 'object' && typeof picked.value === 'number') {
    // 单选/数值：value+mask 按字段宽度大端展开（29W/H 族）；数值按 scale 换算成档位
    const w = out.length;
    let val = picked.value;
    if (spec.kind === 'number' && spec.scale && spec.scale !== 1) val = Math.round(val / spec.scale);
    const maskAll = (w === 1 ? 0xff : w === 2 ? 0xffff : (Math.pow(2, 8 * w) - 1));
    const mask = Number(picked.mask ?? maskAll);
    for (let i = 0; i < w; i++) {
      const sh = 8 * (w - 1 - i);
      const m = (mask >>> sh) & 0xff;
      const v = (val >>> sh) & 0xff;
      out[i] = (take(i) & ~m) | (v & m);
    }
  }
  return out;
}

/** 对「读+写」模板型条目做读改写：返回替换好数据区的新命令串（无法处理时返回 null 走原路径） */
async function mergeRwUserEntry(item, picked) {
  const parts = String(item.commands).split(',').map((s) => s.trim().replace(/\s/g, '')).filter(Boolean);
  // 喷油嘴编码等条目是「读 + 写 + 后续例程」5 段模板；旧实现只接受 2 段，
  // 导致选择值完全没写进写模板，执行的是全零编码（2026-10-18 复查）。
  if (parts.length < 2) return null;
  const rraw = hexToBytes(parts[0]);
  const wraw = hexToBytes(parts[1]);
  if (rraw.length < 4 || rraw[0] !== 3 || rraw[1] !== 0x22) return null;   // 首条=单帧读
  if (wraw.length < 4) return null;
  const wlen = wraw[0];
  const wpay = wraw.slice(1, 1 + wlen);
  if (wpay[0] !== 0x2e || wpay.length < 4) return null;                    // 次条=写模板
  const did = (wpay[1] << 8) | wpay[2];
  // 车端已验证的读改写流程在读回长度 <4 时直接失败，不会拿全零模板继续写。
  let base;
  try {
    base = await state.uds.readDataByIdentifier(did);
  } catch (e) {
    throw new Error('读改写前置读取失败：' + e.message);
  }
  const merged = mergeWriteField(wpay.slice(3), base, picked, item);
  const np = new Uint8Array(4 + merged.length);
  np[0] = 3 + merged.length;
  np[1] = 0x2e; np[2] = wpay[1]; np[3] = wpay[2];
  np.set(merged, 4);
  const hex = Array.from(np).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  // 车端已验证的读改写流程只读 commands[0] + 写 commands[1]；后面的 commands[2..] 不发送。
  return [parts[0], hex].join(',');
}

let fnAbort = false;   // 执行中取消标志（中止→发最后一条命令恢复，标准语义）

async function runCommandString(cmdStr, item) {
  const sent = [];
  const parts = cmdStr.split(',').map((p) => p.trim().replace(/\s/g, '')).filter(Boolean);
  // 延时 / 行为类旗标（已按车端实测行为定论）：
  //   NOWAIT=0 · 0.5SEC · 1SEC · 10SEC · 20SEC · 30SEC · 50SEC
  //   **EXECANY**  = 只放行「第一条命令无应答」；负响应仍失败（后续命令的 NRC 见下）
  //   **NOABORT**  = 中止时不发「最后一条恢复命令」        —— 9 条（灯光类执行器）
  //   WAITY / IORESULT / TD100 / FUNCW / SPEEDLIMIT：数据侧 0~1 行，属死路径，不实现
  const flags = String((item && item.resultFormat) || '').toUpperCase();
  const execAny = flags.includes('EXECANY');
  const noAbort = flags.includes('NOABORT');
  const funcPoll = /FUNC/.test(flags);
  // 基准间隔：默认 2s，0.5SEC→500ms，1SEC→1s。
  // 10/20/30/50SEC 在其它协议类的同一个链里（`:7647-7667`，tick 单位）。
  let interMs = 2000;
  if (flags.includes('0.5SEC')) interMs = 500;
  else if (flags.includes('1SEC')) interMs = 1000;
  else if (flags.includes('10SEC')) interMs = 10000;
  else if (flags.includes('20SEC')) interMs = 20000;
  else if (flags.includes('30SEC')) interMs = 30000;
  else if (flags.includes('50SEC')) interMs = 50000;
  if (flags.includes('NOWAIT')) interMs = 0;
  // 「结果沉降」不是替代基准，而是**在基准之上加倍数**（车端实测节奏）：
  //   1 条命令 → 基准 + 4×基准（2s → 10s）
  //   2 条命令 → 基准 + 3×基准（2s → 8s），加在两条之间
  //   ≥3 条    → 命令之间只等基准（2s）
  const rwUserEntry = flags.includes('RWUSERENTRY');
  const gapMs = rwUserEntry ? 1000 : (parts.length === 1 ? interMs * 5 : parts.length === 2 ? interMs * 4 : interMs);
  // RWUSERENTRY：车端已验证流程先在本地读一次、合并，然后 Sleep(1000) → 2E，
  // 成功后 Sleep(1000)；读帧已经由 mergeRwUserEntry 发出，这里从写帧开始。
  const startIndex = (item && item._rwReadDone) ? 1 : 0;
  if (item) item._rwReadDone = false;
  if (rwUserEntry && startIndex === 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  let realIndex = 0;      // 真实 UDS 命令序号（FE/FF/00 不算）
  let positive = 0;       // 正响应计数：至少一条正响应才算执行成功
  let funcPollStarted = false;

  // 中止/取消语义：下发最后一条真实 UDS 作恢复（回到安全态）
  let lastReal = null;
  for (const p of parts) {
    const r = hexToBytes(p);
    if (r.length && r[0] > 0 && r[0] < 0xF0) lastReal = r;
  }
  const restoreLast = async () => {
    if (noAbort) { sent.push('[NOABORT：按标准语义不发恢复命令]'); return; }
    if (!lastReal) return;
    try {
      await state.link.request(lastReal.slice(1, 1 + lastReal[0]));
      sent.push('[恢复命令已发]');
    } catch { sent.push('[恢复命令失败]'); }
  };
  const waitCancellable = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fnAbort) return false;
      await new Promise((r) => setTimeout(r, Math.min(120, Math.max(1, ms - (Date.now() - t0)))));
    }
    return true;
  };

  for (let i = startIndex; i < parts.length; i++) {
    if (fnAbort) {
      sent.push('[执行中止→恢复]');
      await restoreLast();
      return sent;
    }
    const h = parts[i];
    const raw = hexToBytes(h);
    if (raw.length < 1) continue;
    const tag = raw[0];
    // FE：脚本步进。raw[1]=0 显示步进文本、raw[1]=1 显示并等待操作者确认
    // 文本 = 选项表 raw[2] 项去掉 4 位掩码前缀（如 "0000Turn the steering wheel 90° left…"）
    if (tag === 0xFE) {
      const mode = raw[1] || 0;
      const idx = raw[2] || 0;
      const opts = (item && item.options) || [];
      const text = (opts[idx] ? opts[idx].slice(4) : '') || `步进 ${idx}`;
      sent.push(`[步进 ${idx}] ${text}`);
      if (mode === 1) {
        const go = confirm(`脚本步骤：\n\n${text}\n\n请完成上述操作后点「确定」继续。`);
        if (!go) {
          sent.push('[步进中止→恢复]');
          await restoreLast();
          return sent;
        }
      } else {
        stage(`步骤：${text}`);
      }
      continue;
    }
    // FF：延时。标准语义 (256×b1+b2) 秒
    if (tag === 0xFF) {
      const ms = raw.length >= 3 ? ((raw[1] << 8) | raw[2]) * 1000 : 10;
      sent.push(`[延时 ${Math.round(ms / 1000)}s]`);
      if (ms > 0 && !(await waitCancellable(Math.min(ms, 120000)))) {
        sent.push('[延时中止→恢复]');
        await restoreLast();
        return sent;
      }
      continue;
    }
    // 00：期望响应模板（显示/校验用），不发送
    if (tag === 0x00) { sent.push(`[响应模板 ${h.slice(2)}]`); continue; }
    // 真实 UDS：单帧或多帧，payload = raw[1..1+len]，交 link.request（内部处理 ISO-TP）
    const len = tag;
    if (len < 1 || raw.length < 1 + len) continue;
    const payload = raw.slice(1, 1 + len);
    // ⚠️ 必须看响应 —— 此前把结果丢掉，`7F` 负响应也计成功、弹「执行完成」。
    //    执行器/特殊功能场景下用户根本不知道失败了（2026-10-16 复查 A5）。
    // 超时：例程控制（31）/ 写入（2E）在真车上可能几十秒（DPF 再生、ABS 排空），
    // 用 5s 默认会把"还在跑"误判成失败；`7F xx 78` 仍由 elm327 层持续等待。
    const svc = payload[0];
    const firstReal = realIndex === 0;
    realIndex++;
    const timeoutMs = svc === 0x31 ? 30000 : svc === 0x2e ? 15000 : undefined;
    const hex = Array.from(payload).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      + (len > 7 ? '（多帧）' : '');
    let resp = null;
    // 注意：车端已验证的 CAN 命令执行器在这里不额外发 10 03；普通 2E 由调用方的会话负责，
    // PROXI 写入则由 writeDataByIdentifier 自己进扩展会话。不要在这里加“保险”，否则
    // 会多出一帧参考流程没有的 10 03，破坏逐帧对齐。
    try {
      resp = await state.link.request(payload, timeoutMs ? { timeoutMs } : undefined);
    } catch (e) {
      // 车端已验证行为（CAN 命令执行器）：
      //   第一条命令：空应答且无 EXECANY → 失败；NRC → 失败。
      //   后续命令：空应答 / NRC 只记录、不中止；最终以「是否至少一条正响应」判定。
      // 旧实现把后续命令的 NRC 也 throw，导致多段流程（喷油嘴编码等）在第一条读之后
      // 因某条例程被拒而整条中断，与车端已验证行为不一致。
      const empty = e && (e.code === 'NO_DATA' || e.code === 'BAD_FRAME');
      // 车端已验证的 FUNC 分支不看首条响应，直接进入 31 03 轮询；其它分支首条空应答才失败
      if (empty && (funcPoll || !firstReal || execAny)) {
        sent.push(`${hex} → （无应答，继续）`);
      } else {
        throw e;
      }
    }
    if (resp && resp[0] === 0x7f) {
      if (resp.length < 3) {
        sent.push(`${hex} → ✗ 负响应过短：${Array.from(resp).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
        throw new Error('命令被拒：负响应格式不完整');
      }
      const nrc = resp[2];
      sent.push(`${hex} → ✗ NRC 0x${nrc.toString(16).toUpperCase()}（${NRC[nrc] || '未知'}）`);
      // 车端已验证的 FUNC 分支不看首条 NRC，直接轮询；普通分支首条 NRC 仍失败。
      if (firstReal && !funcPoll) {
        throw new Error(`命令被拒：NRC 0x${nrc.toString(16).toUpperCase()}（${NRC[nrc] || '未知'}）`);
      }
    } else if (resp && resp.length > 1) {
      sent.push(hex + ' → ✓');
      positive++;
    }
    // FUNC：例程类（31 01 启动）按车端已验证行为**轮询 31 03** 直到 ECU 不再回「忙」
    // （：500ms 一次，NRC 0x21/0x23 继续，最多 1800 次）
    if (svc === 0x31 && funcPoll) {
      funcPollStarted = true;
      const id = payload.slice(2);                    // 例程号（2~3 字节，原样带回）
      const statusReq = new Uint8Array(2 + id.length);
      statusReq[0] = 0x31; statusReq[1] = 0x03; statusReq.set(id, 2);
      let polls = 0;
      for (let n = 0; n < 1800; n++) {
        if (!(await waitCancellable(500))) { sent.push('[例程轮询已中止]'); return sent; }
        let st = null;
        try {
          st = await state.link.request(statusReq, { timeoutMs: 5000 });
        } catch {
          sent.push('[例程状态读取失败，停止轮询]');
          break;
        }
        polls++;
        // 车端已验证行为的缓冲带 1 字节长度前缀（NRC 在 array[3]）；我们协议层已剥前缀，
        // 所以忙判定看 resp[2]（见 src/uds.js isRoutineBusy）。
        // 旧实现照搬 st[3]：`7F 31 21` 只有 3 字节 → 条件恒 false → 第一次忙就停止轮询。
        if (!isRoutineBusy(st)) {
          const isStatus = !!(st && st[0] === 0x71 && st[1] === 0x03);
          sent.push(`[例程状态：${st ? Array.from(st).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') : '空'}`
            + `${isStatus ? '' : '（非预期响应，停止轮询）'}（轮询 ${polls} 次）]`);
          break;
        }
      }
    }
    // 命令间沉降（FE/FF 节奏由 token 自带，真实命令之间按旗标等效等待）
    if (gapMs > 0 && (i < parts.length - 1 || parts.length === 1)) {
      if (!(await waitCancellable(gapMs))) {
        sent.push('[执行中止→恢复]');
        await restoreLast();
        return sent;
      }
    }
  }
  // 车端已验证的 FUNC 分支不按正响应数判失败；普通分支才按正响应数。
  if (rwUserEntry) await new Promise((r) => setTimeout(r, 1000));
  if (!funcPollStarted && realIndex > 0 && positive === 0) {
    throw new Error('执行失败：所有命令均未得到正响应');
  }
  return sent;
}

function renderFunctions() {
  const wrap = $('funcList');
  const all = state.funcs.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.category })));
  // ⚠️ 稳定唯一号：数据里有 3 组「同模块 + 同名」但命令完全不同的条目
  //    （LRBSS1 VIN lock 读/写、ZF8HP50 Self-adaptation reset 例程/IO、
  //      ABSMMKC1 Hydraulic unit bleed 两套序列）。此前按钮只带 name+module，
  //      `all.find(name && module)` 永远命中第一条 → 点第二行执行第一行（2026-10-18 审查 M5）。
  all.forEach((x, i) => { x._uid = i; });
  // 统计口径跟随本车画像：本车没装的模块，其功能既选不到也执行不了，不该算进「功能 N」
  const usable = all.filter((i) => moduleVisible(i.module));
  $('fnTotal').textContent = usable.length;
  $('fnOffline').textContent = usable.filter((i) => i.security.level === 'none').length;
  $('fnPin').textContent = usable.filter((i) => i.security.level === 'pin').length;
  $('fnServer').textContent = usable.filter((i) => i.security.level === 'server').length;
  const statsWrap = $('fnTotal').closest('.align-summary');
  if (statsWrap) statsWrap.title = usable.length === all.length
    ? `全部 ${all.length} 项功能`
    : `本车可用 ${usable.length} 项（全量 ${all.length} 项，含 ${all.length - usable.length} 项本车未装模块）`;

  const catSel = $('funcCat');
  const modSel = $('fnModule');
  if (!catSel.dataset.bound) {
    for (const c of state.funcs.categories) {
      const o = document.createElement('option');
      o.value = c.category;
      o.textContent = `${t(c.category) || c.category}（${c.count}）`;
      catSel.appendChild(o);
    }
    catSel.addEventListener('change', renderFunctions);
    modSel.addEventListener('change', renderFunctions);
    $('funcSec').addEventListener('change', renderFunctions);
    $('fnSearch').addEventListener('input', renderFunctions);
    catSel.dataset.bound = '1';
    // 模块下拉由 rebuildModuleSelects() 统一维护（本车画像变了要重铺）；
    // 首次进入时这里补一次，避免 renderFunctions 先于它跑时下拉是空的。
    if (modSel.options.length <= 1) rebuildModuleSelects();
  }

  const cat = catSel.value;
  const sec = $('funcSec').value;
  const mod = modSel.value;
  const q = $('fnSearch').value;
  // 进入模块并连接成功后才显示功能列表——避免未连接就看到按钮直接点、漏掉连接步骤
  if (!modSess.code) {
    wrap.innerHTML = '<div class="dim" style="padding:16px">请先在上方选择模块，点「进入模块」并确认连接成功后，这里显示该模块的功能</div>';
    return;
  }
  const list = all.filter((i) =>
    (!cat || i.category === cat) &&
    (!sec || i.security.level === sec) &&
    (!mod || i.module === mod) &&
    hit(q, i.name, t(i.name), i.desc, i.module, modLabel(i.module), i.commands, i.category, t(i.category),
        i.added ? '新增' : ''));
  wrap.innerHTML = list.slice(0, 260).map((i) => `
    <div class="mrow${i.added ? ' added' : ''}">
      <div class="grow">
        ${modChip(i.module)}
        <div class="name">${tSpan(i.name)}
          <span class="fn-sec ${i.security.level}">${
            { none: '离线可用', pin: '需 PIN', server: '需服务器密钥·不支持' }[i.security.level]
          }</span>
          <span class="tag pending">${(state.i18n.kinds && state.i18n.kinds[i.kind]) || i.kind}</span>
          ${i.input ? `<span class="tag verified">${
            { enum: '下拉选择', number: '数值输入' + (i.input.unit ? `（${i.input.unit}）` : ''), date: '日期', hex: '十六进制' }[i.input.kind] || ''
          }</span>` : ''}
        </div>
        <div class="sub">${t(i.category) || i.category}${i.desc ? ' · ' + tdesc(i.desc).split('⚠')[0].trim() : ''}</div>
        ${i.warning ? `<div class="pend-note">⚠ ${t(i.warning)}</div>` : ''}
        <div class="fn-cmds">${i.commands}</div>
      </div>
      <button class="small" data-run="${encodeURIComponent(i.name)}" data-uid="${i._uid}" data-mod="${i.module}"${
        i.security.level === 'server' ? ' disabled' : ''
      }>${i.kind === '执行器' ? '执行' : '运行'}</button>
    </div>`).join('') +
    (list.length > 260 ? `<div class="dim" style="padding:10px">仅显示前 260 条（共 ${list.length} 条），请用上方筛选缩小范围</div>` : '');

  wrap.querySelectorAll('button[data-run]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = decodeURIComponent(b.dataset.run);
      const mod = b.dataset.mod;
      // 按唯一号取条目（同名同模块的重复条目不能靠名字查）
      const item = all.find((x) => String(x._uid) === b.dataset.uid)
        || all.find((x) => x.name === name && x.module === mod);
      if (!item) return;
      if (!modSess.code) {
        alert('请先「进入模块」：在上方选择本功能所属模块，点「进入模块」并确认。');
        return;
      }
      if (modSess.code !== item.module) {
        alert(`当前已进入模块 ${modLabel(modSess.code)}（${modSess.code}）。\n此功能属于 ${modLabel(item.module)}（${item.module}）。\n请先「退出模块」，再进入该模块。`);
        return;
      }
      if (item.category === 'PROXI 对齐' || /,992E2023/.test(item.commands || '')) {
        // 这条一键命令会下发全零配置块（input 的掩码/值从未套用到块上），
        // 必须在询问输入之前就拦住，避免用户填完才被告知不能用。
        alert('「' + t(item.name) + '」已改走「隐藏功能 / 命名设置」路径。\n\n'
          + '原因：这条一键命令会下发全零配置块，有写坏 PROXI 配置区的风险。\n\n'
          + '请到「隐藏功能」页找同名设置项修改 —— 那条路径走的是'
          + '读块 → 按 startByte/mask/value 改位 → 写回真实块 → 回读校验。');
        return;
      }
      if (operationBlocked()) return;
      stopLiveForOperation('执行特殊功能');
      if (state.session) state.session.resetCableAbort();
      const mName = modLabel(item.module);
      const bOld = b.textContent;
      let picked = null;
      // READNOTES：执行前展示说明（标准语义）
      const fnFlags = String(item.resultFormat || '').toUpperCase();
      if (fnFlags.includes('READNOTES') && item.desc) {
        const okNotes = confirm(`执行说明（${t(item.name)}）\n\n${tdesc(item.desc).slice(0, 600)}\n\n确认已阅读并继续？`);
        if (!okNotes) return;
      }
      // 需 PIN 的项目：先安全访问（标准语义 SECURITY05xx）
      if (item.security && item.security.level === 'pin') {
        const pin = prompt('该项目需要安全访问\n\n请输入 5 位 PIN：', '');
        if (!pin) { stageDone('已取消（未输入 PIN）'); return; }
        try {
          stage('正在安全访问…');
          const sec = await state.uds.securityAccess(String(pin).trim());
          if (sec && sec.alreadyUnlocked) {
            stageDone('该模块已处于解锁状态（种子为 0），无需送密钥');
          }
        } catch (e) {
          stageFail('安全访问失败：' + e.message);
          alert('安全访问失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
          return;
        }
      }
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消执行';
      cancelBtn.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:118px;z-index:98;min-height:44px;padding:10px 22px;border-radius:12px;border:1px solid #b33;background:#2a1215;color:#f88;font-size:15px;';
      cancelBtn.onclick = () => { fnAbort = true; cancelBtn.textContent = '正在取消…'; };
      document.body.appendChild(cancelBtn);
      state.busy = '执行特殊功能';
      try {
        stage(`已连接 ${mName}（地址 0x${(state.cables.modules[item.module] || {}).tx || '??'}）`);
        fnAbort = false;
        const sent = await (async () => {
          b.disabled = true;
          b.textContent = '执行中…';
          stage(`执行中：${t(item.name)}…`);
          try {
            if (item.kind === '执行器') {
              const ok = confirm(`执行器测试安全须知\n\n「${t(item.name)}」会驱动真实执行器动作。\n请先按安全规范断开相关执行器并接入模拟电阻。\n\n确认已按规范操作并继续？`);
              if (!ok) return null;
            }
            if (item.needsUserInput || item.input) {
              picked = await askInput(item);
              if (picked === null) return null;
            }
            // 读改写合并（RWUSERENTRY 族）：选择值按掩码并进写模板——此前选择值从不落盘、
            // 模板零值直发（2026-10-17 审计：98 条读改写条目全中招）
            let cmdToSend = item.commands;
            if (picked && item.input && !item.workflow
                && /RWUSERENTRY/.test(String(item.resultFormat || ''))) {
              const merged = await mergeRwUserEntry(item, picked);
              if (merged) {
                cmdToSend = merged;
                item._rwReadDone = true;
                log(`读改写：按选择值合并字段后写入`);
              }
            }
            // 分步工作流：逐步下发并汇报（如「恢复保养提醒」）
            if (item.workflow) {
              const out = [];
              for (const st of item.workflow) {
                stage(`正在执行：${st.step}…`);
                let cmd = st.cmd;
                if (st.userValue === 'interval' && picked) {
                  const raw = Math.min(255, Math.max(0, Math.round(picked.value / 500)));  // 钳位 0..255，否则 toString(16) 出 3 位把模板切坏   // 单位 500km/步
                  cmd = cmd.slice(0, -2) + raw.toString(16).toUpperCase().padStart(2, '0');
                }
                await runCommandString(cmd, item);
                out.push(`${st.step}（${cmd}）`);
                await stageWait(360);
              }
              return out;
            }
            return await runCommandString(cmdToSend, item);
          } finally {
            b.disabled = false;
            b.textContent = bOld;
          }
        })();

        if (!sent) { stageDone('已取消'); return; }
        const aborted = sent.some((s) => String(s).includes('中止'));
        if (aborted) {
          stageDone(`已取消：${t(item.name)}（恢复命令已下发）`);
          return;
        }
        // EXECANY 类条目允许部分命令被拒（车端已验证行为继续执行），但结果必须让用户看见
        const rejected = sent.filter((s) => /✗ NRC 0x/.test(String(s))).length;
        const valLine = (picked && typeof picked === 'object') ? `\n设定值：${picked.label}` : '';
        if (rejected) {
          stageFail(`完成（有 ${rejected} 条命令被拒）：${t(item.name)}`);
          alert(`执行结束，但有 ${rejected} 条命令被 ECU 拒绝\n\n项目：${t(item.name)}\n模块：${m2label(item.module)}${valLine}\n下发帧：\n${sent.join('\n') || '（无）'}`);
        } else {
          stageDone(`完成：${t(item.name)}（下发 ${sent.length} 帧）`);
          alert(`执行完成\n\n项目：${t(item.name)}\n模块：${m2label(item.module)}${valLine}\n下发帧：\n${sent.join('\n') || '（无）'}`);
        }
        // DISCONNECTONSUCCESS：成功后自动退出模块（标准语义）
        if (fnFlags.includes('DISCONNECTONSUCCESS')) {
          await exitModule({ auto: true });
          stageDone('已按功能语义自动退出模块');
        }
      } catch (e) {
        stageFail(`失败：${e.message}`);
        alert('执行失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
      } finally {
        cancelBtn.remove();
        fnAbort = false;
        if (state.busy === '执行特殊功能') state.busy = null;
      }
    });
  });
}

/** 模块标识：中文名为主，代号为辅 */
function modLabel(code) {
  const d = state.i18n && state.i18n.modules[code];
  return d ? d.zh : code;
}
function modChip(code) {
  return `<div class="mcode"><span class="zh">${modLabel(code)}</span><span class="en">${code}</span></div>`;
}
function m2label(code) {
  return `${modLabel(code)}（${code}）`;
}

/* ================= 分段执行状态 ================= */
function stage(text, kind) {
  const bar = $('stageBar');
  bar.classList.remove('hidden', 'done', 'fail');
  if (kind) bar.classList.add(kind);
  $('stageText').textContent = text;
  log(text);
}
function stageDone(text) { stage(text, 'done'); setTimeout(() => $('stageBar').classList.add('hidden'), 1600); }
function stageFail(text) { stage(text, 'fail'); }
const stageWait = (ms) => new Promise((r) => setTimeout(r, ms));

$('btnScan').addEventListener('click', async () => {
  if (!(await ensureConnected())) return;
  if (operationBlocked()) return;
  stopLiveForOperation('扫描模块');
  if (state.session) state.session.resetCableAbort();
  state.busy = '扫描模块';
  $('btnScan').disabled = true;
  const list = state.modules.modules.filter((m) => moduleVisible(m.code));
  const skippedByProfile = state.modules.modules.length - list.length;
  stage(`正在扫描车辆支持的控制模块…${skippedByProfile ? `（已跳过本车未配置的 ${skippedByProfile} 个）` : ''}`);
  // 真实逐模块探测：对每个模块发 testerPresent，按应答标注（不再只是静态清单）
  let ok = 0, none = 0, skipped = 0;
  try {
    for (const m of list) {
      const grp = (state.cables.modules[m.code] || {}).group || 'none';
      // 不在这里弹换线提示：跨总线模块标记为「跳过」，等用户接好线后再扫；
      // 反过来从 swap/comfort 回主总线同样要跳过（旧判据会漏掉回主总线的换线）。
      const mustSwap = !!state.session && state.session.needsPhysicalSwap(grp);
      if (mustSwap) { m.scanState = 'skip'; skipped++; renderModules(); continue; }
      stage(`正在探测 ${m.code}（${modLabel(m.code)}）…`);
      try {
        // ✅ 不搞 Promise.race 弃单：被弃的 ensureModule 仍在跑，会和下一条模块
        //    的 ATSH/ATSPB 交错。直接 await 一个较短的 testerPresent 超时。
        await state.session.runOn(m.code, async () => { await state.uds.testerPresent(1500); });
        m.scanState = 'ok'; ok++;
      } catch {
        m.scanState = 'none'; none++;
      }
      renderModules();
    }
    renderModules();
    stageDone(`扫描完成：${ok} 个有应答${none ? ` / ${none} 个无应答` : ''}${skipped ? ` / ${skipped} 个跨总线未探测（需换适配线）` : ''}`);
  } catch (e) {
    stageFail('扫描失败：' + e.message);
  } finally {
    if (state.busy === '扫描模块') state.busy = null;
    $('btnScan').disabled = false;
  }
});

/** 手动连接指定模块（选模块→连接） */
async function connectModuleManual(code) {
  try {
    if (!(await ensureConnected())) return;
    if (modSess.code) {
      alert(`当前已进入模块 ${modLabel(modSess.code)}（${modSess.code}）。\n换模块必须先点「退出模块」并确认退出。`);
      return;
    }
    if (operationBlocked()) return;
    stopLiveForOperation('连接模块');
    if (state.session) state.session.resetCableAbort();
    stage('正在连接模块 ' + modLabel(code) + '…');
    await state.session.ensureModule(code);
    $('modState').textContent = '已连接模块：' + modLabel(code);
    $('modState').className = 'pill mod on';
    stageDone('已连接 ' + modLabel(code));
  } catch (e) {
    stageFail('连接失败：' + e.message);
    alert('连接失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
  }
  renderModules();
}

/** 手动断开当前模块 */
function disconnectModuleManual() {
  if (operationBlocked()) return;
  stopLiveForOperation('断开模块');
  if (state.session) state.session.disconnectModule();
  if (modSess.code) {
    modSess.code = null;
    renderModuleSessionUI();
  }
  $('modState').textContent = '未连接模块';
  $('modState').className = 'pill mod';
  renderModules();
}

$('moduleList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mod]');
  if (!b) return;
  const code = b.getAttribute('data-mod');
  const currentCode = state.session && state.session.current ? state.session.current.code : null;
  if (code === currentCode) disconnectModuleManual();
  else connectModuleManual(code);
});

/* ================= 本车识别（模块清单按车过滤） ================= */
/**
 * 发动机手动指定：按 VIN 记住。
 * 自动识别（ECM2 → 2.9 / SCR → 2.2 / 单 ECM → 2.0）在绝大多数车上够用，
 * 但 2.0 与 2.2 共用地址 0x10、PROXI 里也没有发动机排量字段，只能靠 SCR 位间接判断；
 * 万一判断错（例如无 AdBlue 的柴油车），用户改一次就永久生效，不用每次重选。
 */
function engineOverrideKey() {
  return 'apx.engine.' + (state.vin || 'no-vin');
}
function loadEngineOverride() {
  try { return localStorage.getItem(engineOverrideKey()) || ''; } catch { return ''; }
}
function saveEngineOverride(v) {
  try {
    if (v) localStorage.setItem(engineOverrideKey(), v);
    else localStorage.removeItem(engineOverrideKey());
  } catch { /* 隐私模式/无存储：仅本次生效 */ }
}

/** 重新计算本车画像并刷新所有依赖它的界面 */
function refreshVehicleProfile() {
  const platform = ($('platform') && $('platform').value) || '952';
  state.profile = (state.modules && state.modules.modules && state.block)
    ? buildVehicleProfile({
      platform,
      data1: state.block.bytes,
      data3: state.data3,
      modules: state.modules.modules,
      nodes: state.modules.alignmentNodes,
      engineOverride: state.engineOverride,
    })
    : null;
  renderVehicleBar();
  renderModules();
  rebuildModuleSelects();
}

function renderVehicleBar() {
  const bar = $('vehBar');
  if (!bar) return;
  const p = state.profile;
  if (!p) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const plat = (state.modules.platforms || {})[p.platform] || {};
  const eng = p.engine ? ENGINE_LABELS[p.engine] : '发动机未识别';
  $('vehName').textContent = `${plat.name || '?'}（${p.platform}）· ${eng}`;
  $('vehEngine').value = state.engineOverride || '';
  $('vehEngine').className = state.engineOverride ? 'manual' : '';

  const src = {
    ecm2: '按 V6 副 ECU（ECM2）判定',
    scr: '按 AdBlue/SCR 模块判定',
    'single-ecm': '单 ECM 平台推断为 2.0（若实际是 2.2 柴油，请在上方改正）',
    user: '已手动指定',
    unknown: '位图中没有发动机节点，未能判定',
  }[p.engineSource] || '';
  $('vehNote').textContent = `${src} · 本车 ${p.counts.visible}/${p.counts.total} 个模块`;
  $('vehNote').title = p.notes && p.notes.length ? p.notes.join('\n') : src;

  const btn = $('vehToggle');
  btn.textContent = state.showAllModules
    ? '只看本车模块'
    : `显示未配置（${p.counts.hidden}）`;
  btn.classList.toggle('primary', state.showAllModules);
}

/** 模块是否应出现在清单/下拉里 */
function moduleVisible(code) {
  const p = state.profile;
  if (!p || state.showAllModules) return true;
  const row = p.rowByCode.get(code);
  if (!row) return true;
  if (row.visible) return true;
  // 当前已连接的模块永远保留在清单里（否则连接中突然消失）
  const cur = state.session && state.session.current ? state.session.current.code : null;
  return code === cur || code === modSess.code;
}

/** 隐藏原因 → 行尾标签 */
const PROFILE_TAG = {
  platform: '其它平台',
  engine: '其它动力',
  absent: '未配置',
  unmapped: '未映射',
};

function renderModules() {
  const q = ($('modSearch') && $('modSearch').value) || '';
  const all = state.modules.modules;
  const shown = all.filter((m) => moduleVisible(m.code));
  const list = shown.filter((m) => hit(q, m.code, m.name, modLabel(m.code), m.bus, m.tx));
  const p = state.profile;
  const head = p && !state.showAllModules
    ? `<div class="dim" style="padding:10px 14px 4px">已按本车配置过滤：显示 ${shown.length}/${all.length} 个模块
        <button class="link" id="modShowAll">显示未配置的 ${all.length - shown.length} 个</button></div>`
    : p
      ? `<div class="dim" style="padding:10px 14px 4px">显示全部 ${all.length} 个模块（未配置项带标签）</div>`
      : `<div class="dim" style="padding:10px 14px 4px">未读取车辆配置，暂显示全部 ${all.length} 个模块
          <span class="dim">（连接后自动按本车配置过滤）</span></div>`;

  $('moduleList').innerHTML = head
    + (list.length ? list.map((m) => {
      const row = p && p.rowByCode.get(m.code);
      const tag = row && !row.visible ? `<span class="state-tag pending">${PROFILE_TAG[row.reason] || '未配置'}</span>` : '';
      const cur = state.session && state.session.current ? state.session.current.code : null;
      return `
    <div class="mrow">
      <div class="code">${m.code}</div>
      <div class="grow">
        <div class="name">${modLabel(m.code)}${{
          ok: '<span class="state-tag written">有应答</span>',
          none: '<span class="state-tag failed">无应答</span>',
          skip: '<span class="state-tag pending">跨总线未探测</span>',
        }[m.scanState || ''] || ''}${tag}</div>
        <div class="sub">${m.code} · ${m.bus} · 地址 0x${m.tx} ← 0x${m.rx} · ${m.platforms.join('/')} · ${
          { none: '无需换线', comfort: '5 号蓝色适配线', swap: '6 号灰色适配线' }[(state.cables.modules[m.code] || {}).group || 'none']
        }${row && row.node ? ` · 节点 ${row.node}` : ''}</div>
      </div>
      <button class="small ${m.code === cur ? 'primary' : 'ghost'}" data-mod="${m.code}">${m.code === cur ? '断开' : '连接'}</button>
    </div>`;
    }).join('') : '<div class="dim" style="padding:14px">没有匹配的模块</div>');

  const showAll = $('modShowAll');
  if (showAll) showAll.addEventListener('click', () => toggleShowAllModules(true));
}

function toggleShowAllModules(v) {
  state.showAllModules = typeof v === 'boolean' ? v : !state.showAllModules;
  renderVehicleBar();
  renderModules();
  rebuildModuleSelects();
  log(state.showAllModules ? '模块清单：显示全部（含本车未配置）' : '模块清单：只看本车已配置模块');
}

$('vehEngine') && $('vehEngine').addEventListener('change', () => {
  state.engineOverride = $('vehEngine').value || '';
  saveEngineOverride(state.engineOverride);       // 按 VIN 记住，下次连同一台车不用再改
  refreshVehicleProfile();
  const p = state.profile;
  if (p) {
    log(`发动机：${p.engine ? ENGINE_LABELS[p.engine] : '未识别'}`
      + `（${state.engineOverride ? '手动指定' : '自动识别'}）`
      + ` · 显示 ${p.counts.visible}/${p.counts.total} 个模块`);
  }
});
$('vehToggle') && $('vehToggle').addEventListener('click', () => toggleShowAllModules());

/** 重建所有"选择模块"下拉：特殊功能 / 故障码 / 实时数据 */
function rebuildModuleSelects() {
  if (!state.modules) return;
  // —— 特殊功能的模块筛选（带功能条数，按数量降序） ——
  const fnSel = $('fnModule');
  if (fnSel && state.funcs) {
    const keep = fnSel.value;
    const perMod = {};
    for (const c of state.funcs.categories) {
      for (const i of c.items) perMod[i.module] = (perMod[i.module] || 0) + 1;
    }
    const codes = Object.keys(perMod)
      .filter((c) => moduleVisible(c))
      .sort((a, b) => perMod[b] - perMod[a]);
    fnSel.innerHTML = '<option value="">全部模块</option>' + codes.map((c) =>
      `<option value="${c}">${modLabel(c)}（${perMod[c]}）</option>`).join('');
    if (keep && (codes.includes(keep) || keep === modSess.code)) fnSel.value = keep;
    else if (keep) fnSel.value = '';
  }
  // —— 故障码 / 实时数据的模块下拉 ——
  for (const id of ['dtcModule', 'liveModule']) {
    const sel = $(id);
    if (!sel) continue;
    const keep = sel.value;
    const codes = state.modules.modules.filter((m) => moduleVisible(m.code)).map((m) => m.code);
    sel.innerHTML = '<option value="">选择模块</option>' + codes.map((c) =>
      `<option value="${c}">${modLabel(c)}（${c}）</option>`).join('');
    sel.value = codes.includes(keep) ? keep : '';
  }
  if (state.funcs) renderFunctions();
}


function renderPending() {
  $('pendingCount').textContent = state.features.pending.length;
  $('pendingList').innerHTML = state.features.pending.map((f) => `
    <div class="mrow">
      <div class="code">${(f.patches || []).map((p) => `B${p.addr}`).join(' ')}</div>
      <div class="grow">
        <div class="name">${f.name} <span class="tag ${f.status}">${
          ((state.features && state.features.statusLegend) && (state.features && state.features.statusLegend)[f.status]) || f.status
        }</span></div>
        <div class="sub">${featurePatchText(f)}</div>
        <div class="pend-note">${f.heldBecause || '来源待确认'}</div>
      </div>
    </div>`).join('');
}


/* ================= 故障码（DTC） ================= */
function dtcLookup(mod, code) {
  const m = state.dtc && state.dtc.modules && state.dtc.modules[mod];
  return (m && m[code]) || null;
}

function renderDtcModuleOptions() {
  // 首次进入时按当前画像（可能为空 = 全量）铺选项；连接/读取配置后由
  // refreshVehicleProfile() → rebuildModuleSelects() 重铺，把本车没有的模块去掉。
  rebuildModuleSelects();
}

$('btnReadDtc').addEventListener('click', async () => {
  const code = $('dtcModule').value;
  if (!code) return alert('请先选择模块');
  if (!(await ensureConnected())) return;
  if (state.aligning) return alert('正在执行 PROXI 对齐，请等它结束。');
  if (state.busy) return alert(`正在执行「${state.busy}」，请等它结束。`);
  stopLiveForOperation('读取故障码');
  if (state.session) state.session.resetCableAbort();
  state.busy = '读取故障码';
  $('btnReadDtc').disabled = true;
  try {
    stage(`正在连接模块：${modLabel(code)}…`);
    await stageWait(420);
    await state.session.runOn(code, async () => {
      stage('正在读取故障码…');
      const list = await state.uds.readDtc();
      const wrap = $('dtcList');
      if (!list.length) {
        wrap.innerHTML = '<div class="dim" style="padding:14px">未读到故障码（该模块无故障或不支持此服务）</div>';
        stageDone('读取完成：无故障码');
        return;
      }
      // 按状态分组：active = 当前活跃故障（testFailed / pendingDTC）；
      // history = 已存储但当前不活跃（confirmedDTC / 本周期失败过）；
      // 其余（如仅 0x40 = 本周期自检未运行）不是故障，不展示 —— 健康车 ECU 会把
      // 全部定义项按 FF 掩码带回来，全是这种（2026-10-29 实车日志实证）。
      const active = list.filter((d) => d.active);
      const history = list.filter((d) => !d.active && d.stored);
      const untested = list.length - active.length - history.length;
      const renderDtc = (d) => {
        const rawHex = d.raw.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
        const hit = dtcLookup(code, rawHex);
        return `<div class="mrow">
          <div class="dtc-code">${d.code}</div>
          <div class="grow">
            <div class="name">${hit ? hit.name : '未知故障'}${d.confirmed ? '<span class="state-tag failed">已确认</span>' : ''}${d.pending ? '<span class="state-tag pending">待定</span>' : ''}${d.testFailed ? '<span class="state-tag failed">当前故障</span>' : ''}</div>
            ${hit && hit.desc ? `<div class="sub">${hit.desc}</div>` : ''}
            <div class="sub">原始码 ${rawHex} · 状态 0x${d.status.toString(16).toUpperCase().padStart(2, '0')}</div>
          </div>
        </div>`;
      };
      let html = '';
      if (active.length) {
        html += `<div style="padding:8px 12px;font-weight:600;color:#e74c3c">⚠ 当前故障（${active.length} 条）</div>`;
        html += active.map(renderDtc).join('');
      } else if (history.length) {
        html += '<div style="padding:8px 12px;color:#27ae60;font-weight:600">✓ 无当前活跃故障</div>';
      } else {
        html += '<div style="padding:8px 12px;color:#27ae60;font-weight:600">✓ 无故障码</div>';
        if (untested > 0) {
          html += `<div class="dim" style="padding:0 12px 8px;font-size:12px">另有 ${untested} 项定义的自检本周期尚未运行（状态 0x40），不是故障。</div>`;
        }
      }
      if (history.length) {
        html += `<details style="margin-top:8px"><summary style="padding:8px 12px;cursor:pointer;color:#888;font-size:13px">📋 历史/已存储故障（${history.length} 条）— 点击展开</summary>`;
        html += history.map(renderDtc).join('');
        html += '</details>';
      }
      wrap.innerHTML = html;
      stageDone(`读取完成：${active.length} 条当前故障${history.length ? ` / ${history.length} 条历史` : '，无历史'}`
        + (untested ? `（另有 ${untested} 项自检未运行，非故障）` : ''));
    });
  } catch (e) {
    stageFail('读取失败：' + e.message);
    alert('读取失败：' + e.message);
  } finally {
    state.busy = null;
    $('btnReadDtc').disabled = false;
  }
});

/**
 * 冻结帧快照（19 04）。
 *
 * ⚠️ 请求与车端已验证行为**逐字节一致**：`19 04 00 00 00 00`（DTC 全 0 + 记录号 0）。
 *    车端已验证行为的同一模块内所有快照参数表都用这一条命令 —— 它读的是 ECU 当前保存的
 *    那份快照，而不是"某个 DTC 专属的那份"。此前我们按点击的 DTC 拼 hi/lo，
 *    那是没有实证的自创路径（2026-10-18 修正）。
 *
 * 取值口径（实证链）：
 *   1. 车端已验证行为 `qv()`：`P_2++; value = buffer[StartByte+1]` —— StartByte 是
 *      **1-based、相对数据区**（实时参数 03220885 StartByte=1 取到第 1 字节，实车已验证）。
 *   2. 冻结帧参数表与实时参数表**用同一套 StartByte 口径**（ABSMMKC1 转向角在两张表里
 *      StartByte 都是 1、NumOfBytes 都是 2、格式都是 nums,2,6.25）。
 *   3. `19 04` 应答头 = `59 04` + DTC(3) + 记录号(1) = **6 字节**，数据区从这里开始。
 *   3b. 表里带第二个 token 的（如 `…,0885,02`）表示**按 DID 定位**：在数据区里找到该 DID，
 *       跳过 2 字节 DID，再按 StartByte-1 取 NumOfBytes 字节。
 */
/**
 * 模拟模式下的冻结帧合成数据区：按该模块的参数表把 DID/绝对偏移都填上，
 * 让「冻结帧快照」页在演示时每项都有值（真机走 ECU 应答，不用这个）。
 */
function synthSnapshotData(items) {
    const DATA = 64;
    const data = new Uint8Array(DATA);
    const putVal = (off, n) => {
        for (let i = 0; i < n && off + i < DATA; i++) data[off + i] = i === n - 1 ? 0x64 : 0x00;
    };
    let off = 0;
    const seen = new Set();
    for (const s of items) {
        if (!s.did) continue;
        if (seen.has(s.did)) continue;
        seen.add(s.did);
        const did = parseInt(s.did, 16);
        if (off + 2 + s.bytes > DATA) break;
        data[off] = (did >> 8) & 0xff; data[off + 1] = did & 0xff;
        putVal(off + 2, s.bytes);
        off += 2 + s.bytes;
    }
    for (const s of items) {
        if (s.did) continue;
        putVal(Math.max(0, (s.start || 1) - 1), s.bytes);
    }
    return Uint8Array.from([0x59, 0x04, 0x00, 0x00, 0x00, 0x01, ...data]);
}

$('btnDtcSnap').addEventListener('click', async () => {
  const code = $('dtcModule').value;
  if (!code) return alert('请先选择模块');
  if (!(await ensureConnected())) return;
  if (state.aligning) return alert('正在执行 PROXI 对齐，请等它结束。');
  if (state.busy) return alert(`正在执行「${state.busy}」，请等它结束。`);
  stopLiveForOperation('读取冻结帧');
  if (state.session) state.session.resetCableAbort();
  state.busy = '读取冻结帧';
  $('btnDtcSnap').disabled = true;
  const box = $('dtcSnap');
  try {
    stage(`正在读取 ${modLabel(code)} 的冻结帧快照…`);
    await state.session.runOn(code, async () => {
      const real = await state.uds.readDtcSnapshot();
      // 模拟模式：演示链路不模拟快照内容，用参数表合成一份，避免整页都是「—」
      const resp = state.simMode ? synthSnapshotData(
        (state.snapshots && state.snapshots.modules && state.snapshots.modules[code]) || []) : real;
      const items = (state.snapshots && state.snapshots.modules && state.snapshots.modules[code]) || [];
      if (!items.length) {
        box.innerHTML = '<div class="dim" style="padding:14px">该模块没有冻结帧参数表</div>';
        stageDone('该模块无冻结帧参数表');
        return;
      }
      const rows = items.map((s) => {
        const v = snapshotValue(resp, s);
        const shown = v === null || v === undefined ? '—' : v;
        return `<div class="mrow">
          <div class="grow"><div class="name">${tSpan(s.name)}</div></div>
          <div class="live-val">${shown}<span style="color:var(--dim);font-size:12px"> ${s.unit || ''}</span></div>
        </div>`;
      }).join('');
      const got = items.filter((s) => snapshotValue(resp, s) !== null).length;
      box.innerHTML = `<div class="sec-head" style="margin:0 0 8px"><h3 style="font-size:14px">冻结帧快照</h3>
        <p class="dim">ECU 保存的快照（19 04）· ${got}/${items.length} 项有值 · 应答 ${resp.length} 字节</p></div>${rows}`;
      stageDone(`冻结帧：${got}/${items.length} 项有值`);
    });
  } catch (e) {
    box.innerHTML = '';
    stageFail('冻结帧读取失败：' + e.message);
    alert('冻结帧读取失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
  } finally {
    state.busy = null;
    $('btnDtcSnap').disabled = false;
  }
});

$('btnClearDtc').addEventListener('click', async () => {
  const code = $('dtcModule').value;
  if (!code) return alert('请先选择模块');
  if (!confirm(`确认清除 ${modLabel(code)} 的故障码？\n\n清除后历史故障记录将丢失，需重新读取才能显示。`)) return;
  if (!(await ensureConnected())) return;
  if (state.aligning) return alert('正在执行 PROXI 对齐，请等它结束。');
  if (state.busy) return alert(`正在执行「${state.busy}」，请等它结束。`);
  stopLiveForOperation('清除故障码');
  if (state.session) state.session.resetCableAbort();
  state.busy = '清除故障码';
  $('btnClearDtc').disabled = true;
  try {
    await state.session.runOn(code, async () => {
      stage('正在清除故障码…');
      await state.uds.clearDtc();
    });
    stageDone('故障码已清除');
    $('dtcList').innerHTML = '<div class="dim" style="padding:14px">已清除，请重新读取确认。</div>';
  } catch (e) {
    stageFail('清除失败：' + e.message);
    alert('清除失败：' + e.message);
  } finally {
    state.busy = null;
    $('btnClearDtc').disabled = false;
  }
});

/* ================= 模块会话（实时数据 / 特殊功能共用） =================
 * 流程：进入模块（确认）→ 勾选即读 / 执行功能 → 退出模块（确认）→ 才能换模块。
 * 与刷隐藏解耦：不读车身编码、不写入，只连目标模块。
 */
const modSess = { code: null };

function cableBrief(code) {
  const g = ((state.cables.modules[code] || {}).group) || 'none';
  return g === 'swap' ? '需 6 号灰色适配线总线（vLinker 等多通道适配器免换线）'
    : g === 'comfort' ? '需 5 号蓝色适配线总线（vLinker 等多通道适配器免换线）'
      : '主总线（无需换线）';
}

async function enterModule(code) {
  if (!code) { alert('请先选择模块'); return false; }
  if (modSess.code) {
    if (modSess.code === code) return true;
    alert(`当前已进入模块 ${modLabel(modSess.code)}（${modSess.code}）。\n换模块必须先点「退出模块」并确认退出。`);
    return false;
  }
  if (!(await ensureConnected())) return false;
  if (operationBlocked()) return false;
  if (state.session) state.session.resetCableAbort();
  const m = state.cables.modules[code] || {};
  // 非免换线适配器：连接前提醒接对应适配线，确认后再连（与通用诊断流程一致）
  const wantGroup = m.group || 'none';
  const mustSwap = !!state.session && state.session.needsPhysicalSwap(wantGroup);
  const lines = [
    `进入模块：${modLabel(code)}（${code}）`,
    `地址 0x${m.tx || '??'} · ${m.baud || '?'}k`,
  ];
  if (mustSwap) {
    const hint = m.hint || (wantGroup === 'swap' ? '请更换为 6 号灰色适配线'
      : wantGroup === 'comfort' ? '请接 5 号蓝色适配线'
        : '请换回主总线（6/14 脚，无需适配线）');
    lines.push('', `⚠ 请先接好适配线：${hint}`, '接好后点「确定」，App 再连接模块。');
  } else {
    lines.push('', cableBrief(code), '', '确认进入该模块？');
  }
  if (!confirm(lines.join('\n'))) return false;
  try {
    stage(`正在进入模块 ${modLabel(code)}…`);
    await state.session.ensureModule(code, { cableConfirmed: mustSwap });
    modSess.code = code;
    $('modState').textContent = `已进入模块：${modLabel(code)}`;
    $('modState').className = 'pill mod on';
    stageDone(`已进入模块 ${modLabel(code)}，可勾选参数或执行功能`);
    renderModuleSessionUI();
    return true;
  } catch (e) {
    stageFail('进入模块失败：' + e.message);
    alert('进入模块失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
    return false;
  }
}

async function exitModule(opts = {}) {
  if (!modSess.code) return;
  // 用户手动退出时，不能从正在执行的功能/对齐中间抽走模块；自动退出（DISCONNECTONSUCCESS）放行
  if (!opts.auto && operationBlocked()) return;
  if (!opts.auto && !confirm(`确认退出模块 ${modLabel(modSess.code)}（${modSess.code}）？\n退出后才能选择其他模块。`)) return;
  stopLiveLoop();
  if (state.session) {
    state.session.disconnectModule();
    state.session.resetCableAbort();
  }
  const name = modLabel(modSess.code);
  modSess.code = null;
  $('modState').textContent = '未连接模块';
  $('modState').className = 'pill mod';
  stageDone(`已退出模块 ${name}`);
  renderModuleSessionUI();
}

function renderModuleSessionUI() {
  const inMod = !!modSess.code;
  // 实时数据：未进入可选模块，进入后锁定并启用勾选
  if ($('liveModule')) {
    $('liveModule').disabled = inMod;
    $('btnLiveEnter').classList.toggle('hidden', inMod);
    $('btnLiveExit').classList.toggle('hidden', !inMod);
    document.querySelectorAll('.live-pick').forEach((el) => { el.disabled = !inMod; });
  }
  // 特殊功能：进入后锁定模块筛选并只显示该模块
  if ($('fnModule')) {
    $('fnModule').disabled = inMod;
    $('fnEnter').classList.toggle('hidden', inMod);
    $('fnExit').classList.toggle('hidden', !inMod);
    if (inMod) {
      // 模块可能被本车画像过滤掉了（例如已进入的模块随后被判定为未配置）：
      // 先确保选项里还有它，再选中，否则 value 赋不上 → 列表会退回「全部模块」
      if (!$('fnModule').querySelector(`option[value="${modSess.code}"]`)) rebuildModuleSelects();
      $('fnModule').value = modSess.code;
    }
  }
  renderFunctions();
  renderLiveParams();
}

/* ================= 实时数据 ================= */
const live = { running: false, samples: [], lastItems: [], items: [], picks: [] };

/**
 * 任何会切模块 / 写车 / 长扫的操作开始前，先停掉实时轮询。
 * 实时循环是一个独立的异步 while，和 setAddress/对齐写共享半双工串口；
 * 不先停会出现「轮询请求插进节点切换之后、拿上一个模块的地址读数据」。
 */
function stopLiveForOperation(reason) {
  if (!live.running) return;
  stopLiveLoop();
  live.running = false;
  live.picks = [];
  live.items = [];
  [...document.querySelectorAll('.live-pick:checked')].forEach((el) => {
    el.checked = false;
    const cell = document.getElementById('liveVal-' + el.dataset.idx);
    if (cell) { cell.textContent = '—'; cell.classList.remove('live-val-hot'); }
  });
  if ($('liveParams')) renderLiveParams();
  log(`已自动停止实时数据（${reason}）`);
}

/** 长任务/写车/换模块的统一并发闸：返回 true 表示可以继续 */
function operationBlocked() {
  if (state.aligning) {
    alert('正在执行 PROXI 对齐，请等它结束。');
    return true;
  }
  if (state.busy) {
    alert(`正在执行「${state.busy}」，请等它结束。`);
    return true;
  }
  return false;
}

function renderLive(items) {
  live.lastItems = items;
  // 数值直接刷新在勾选卡片的值槽上（不用再拉到底部）
  const last = live.samples.length ? live.samples[live.samples.length - 1] : null;
  (live.picks || []).forEach((p, i) => {
    const el = document.getElementById('liveVal-' + p.idx);
    if (!el) return;
    const v = last ? last.v[i] : null;
    if (v === null || v === undefined) {
      el.textContent = '—';
      el.classList.remove('live-val-hot');
      return;
    }
    // 数值按参数的小数位显示（如转向角 2 位：-1.06），非数值原样
    const dec = (p.it && p.it.spec && p.it.spec.decimals) || 0;
    el.textContent = (typeof v === 'number') ? v.toFixed(dec) : String(v);
    el.classList.add('live-val-hot');
  });
}

function renderLiveParams() {
  const code = $('liveModule').value;
  const wrap = $('liveParams');
  if (!code) {
    // 展开态（双屏）时这块在右屏，给一句引导比空白好
    wrap.innerHTML = '<div class="dim" style="padding:16px">选择模块并「进入模块」后，参数会显示在这里</div>';
    return;
  }
  // 进入模块并连接成功后才显示参数列表——避免未连接就勾选、漏掉连接步骤
  if (!modSess.code || modSess.code !== code) {
    state.liveItems = [];
    $('liveCount').textContent = '0';
    wrap.innerHTML = '<div class="dim" style="padding:16px">点「进入模块」并确认连接成功后，这里显示该模块可读参数</div>';
    return;
  }
  const all = (state.params && state.params.modules && state.params.modules[code]) || [];
  // DATA1/DATA2/DATA3 是整块原始 hex（NumOfBytes=512）：不是"实时参数"，
  // 勾上会把 289 字节 hex（578 字符）塞进值槽撑爆一行，而且每 120ms 轮询一次整块毫无意义。
  const isRawBlock = (i) => (i.spec && i.spec.bytes >= 100)
    || /^DATA\d[S]?$/i.test(String(i.name || '').trim());
  const q = ($('liveSearch') && $('liveSearch').value) || '';
  const items = all.filter((i) => !isRawBlock(i) && hit(q, i.name, t(i.name), i.did, i.spec && i.spec.unit));
  state.liveItems = items;
  $('liveCount').textContent = items.length === all.filter((i) => !isRawBlock(i)).length
    ? items.length
    : `${items.length} / ${all.filter((i) => !isRawBlock(i)).length}`;
  const CAP = 400;
  wrap.innerHTML = items.slice(0, CAP).map((i, idx) => `
    <div class="mrow">
      <input type="checkbox" class="live-pick" data-idx="${idx}" ${modSess.code ? '' : 'disabled'} style="accent-color:var(--accent)">
      <div class="grow">
        <div class="name">${tSpan(i.name)}</div>
        <div class="sub">DID ${i.did} · ${i.spec && i.spec.unit ? '单位 ' + i.spec.unit + ' · ' : ''}${i.spec && i.spec.scale && i.spec.scale !== 1 ? '换算 ×' + i.spec.scale : ''}</div>
      </div>
      <div class="live-val" id="liveVal-${idx}">—</div>
    </div>`).join('') + (items.length > CAP
    ? `<div class="dim" style="padding:10px">仅显示前 ${CAP} 条（共 ${items.length} 条），请用上方搜索缩小范围</div>`
    : '') || '<div class="dim" style="padding:14px">该模块无可读参数</div>';
}
$('liveModule') && $('liveModule').addEventListener('change', renderLiveParams);
$('liveSearch') && $('liveSearch').addEventListener('input', () => {
  // 重新渲染会重建勾选框，轮询中的监控项会失配 → 先停掉轮询再过滤
  if (live.running) {
    stopLiveLoop();
    live.running = false; live.picks = []; live.items = [];
  }
  renderLiveParams();
});

$('btnLiveEnter') && $('btnLiveEnter').addEventListener('click', async () => {
  const code = $('liveModule').value;
  if (await enterModule(code)) syncLiveAuto();
});

$('btnLiveExit') && $('btnLiveExit').addEventListener('click', exitModule);

/** 勾选即读：勾上自动开始轮询，取消勾选到 0 项自动停止 */
function pickedLiveItems() {
  return [...document.querySelectorAll('.live-pick:checked')]
    .map((el) => ({ idx: Number(el.dataset.idx), it: state.liveItems[Number(el.dataset.idx)] }))
    .filter((p) => p.it);
}

async function syncLiveAuto() {
  if (!modSess.code) return;
  // 长任务期间不允许从实时页重新开轮询（读配置/写车/对齐/扫描共享半双工串口）
  if (state.busy || state.aligning) {
    [...document.querySelectorAll('.live-pick:checked')].forEach((el) => {
      el.checked = false;
      const cell = document.getElementById('liveVal-' + el.dataset.idx);
      if (cell) { cell.textContent = '—'; cell.classList.remove('live-val-hot'); }
    });
    log(`正在执行「${state.busy || 'PROXI 对齐'}」，实时数据已取消`);
    return;
  }
  const picked = pickedLiveItems();
  if (picked.length > 8) {
    alert('最多同时监控 8 项参数，已保留前 8 项');
    [...document.querySelectorAll('.live-pick:checked')].slice(8).forEach((el) => {
      el.checked = false;
      const cell = document.getElementById('liveVal-' + el.dataset.idx);
      if (cell) { cell.textContent = '—'; cell.classList.remove('live-val-hot'); }
    });
    return syncLiveAuto();
  }
  if (!picked.length) {
    stopLiveLoop();
    live.picks = [];
    live.items = [];
    return;
  }
  live.picks = picked;
  live.lastItems = picked.map((p) => p.it);
  if (live.running) { live.items = live.lastItems; return; }   // 已在轮询：热更新监控项
  live.running = true;
  live.items = live.lastItems;
  stage(`正在读取实时数据（${picked.length} 项）…`);
  const t0 = Date.now();
  let n = 0;
  try {
    while (live.running) {
      const items = live.items;
      const row = { t: new Date().toISOString(), v: [] };
      for (const it of items) {
        try { row.v.push(applyScale(await state.uds.readDataByIdentifier(parseInt(it.did, 16)), it)); }
        catch { row.v.push(null); }
      }
      live.samples.push(row);
      n++;
      $('liveSamples').textContent = live.samples.length;
      $('liveRate').textContent = Math.round(n / Math.max(1, (Date.now() - t0) / 60000));
      renderLive(items);
      // 轮询节奏对齐：滚动连续读（间隔只留总线呼吸口），不整轮大睡
      await new Promise((r) => setTimeout(r, 120));
    }
    stageDone(`实时数据结束，共 ${live.samples.length} 个采样点`);
  } catch (e) {
    stageFail('实时读取失败：' + e.message);
    live.running = false;
  }
}

function stopLiveLoop() { live.running = false; }

$('liveParams') && $('liveParams').addEventListener('change', (e) => {
  if (!e.target.classList.contains('live-pick')) return;
  if (!e.target.checked) {
    const cell = document.getElementById('liveVal-' + e.target.dataset.idx);
    if (cell) { cell.textContent = '—'; cell.classList.remove('live-val-hot'); }
  }
  syncLiveAuto();
});

$('fnEnter') && $('fnEnter').addEventListener('click', async () => {
  const code = $('fnModule').value;
  if (!code) { alert('请先在模块下拉里选择要进入的模块'); return; }
  await enterModule(code);
});

$('fnExit') && $('fnExit').addEventListener('click', exitModule);

$('btnLiveCsv').addEventListener('click', () => {
  if (!live.samples.length) return alert('暂无采样数据');
  const items = live.lastItems || [];
  const head = ['时间', ...items.map((i) => i.name + (i.spec && i.spec.unit ? `(${i.spec.unit})` : ''))];
  const lines = [head.join(',')];
  for (const r of live.samples) lines.push([r.t, ...r.v.map((x) => x ?? '')].join(','));
  downloadFile(`live-${Date.now()}.csv`, lines.join('\n'), 'text/csv');
  log('实时数据已导出 CSV');
});

/* ================= 启动 ================= */
async function load() {
  const [f, m, ns, fn, cables, i18n, i18nDesc, ifaceData, dtc, params, snapshots] = await Promise.all([
    fetch('../src/data/features.json').then((r) => r.json()),
    fetch('../src/data/modules.json').then((r) => r.json()),
    fetch('../src/data/named-settings.json').then((r) => r.json()),
    fetch('../src/data/functions.json').then((r) => r.json()),
    fetch('../src/data/cables.json').then((r) => r.json()),
    fetch('../src/data/i18n.json').then((r) => r.json()),
    fetch('../src/data/i18n-desc.json').then((r) => r.json()).catch(() => ({ desc: {} })),
    fetch('../src/data/interfaces.json').then((r) => r.json()),
    fetch('../src/data/dtc.json').then((r) => r.json()),
    fetch('../src/data/params.json').then((r) => r.json()),
    fetch('../src/data/dtc-snapshots.json').then((r) => r.json()).catch(() => ({ modules: {} })),
  ]);
  Object.assign(state, { features: f, modules: m, named: ns, funcs: fn, cables, i18n, i18nDesc, ifaces: ifaceData.interfaces, dtc, params, snapshots });
  removeNonParticipating();
  renderIfaceTypes();
  renderDtcModuleOptions();
  renderNamed();
  renderFeatures();
  renderFunctions();
  renderPending();
  renderModules();
  renderAlign();
  renderEditor();
  bindSearch();
}

$('todoHide') && $('todoHide').addEventListener('click', () => {
  document.querySelector('.todo-bar')?.classList.add('hidden');
});

// 开发用面板（待办提醒 / 待验证）默认隐藏，?dev=1 才显示（P3-5：成品界面不暴露开发待办）
if (new URLSearchParams(location.search).get('dev') === '1') {
  $('todoBar') && $('todoBar').classList.remove('hidden');
  document.querySelector('.tab[data-tab="pending"]')?.classList.remove('hidden');
  $('tab-pending') && $('tab-pending').classList.remove('hidden');
}

function bindSearch() {
  for (const [id, fn] of [
    ['featSearch', () => { renderNamed(); renderFeatures(); }],
    ['modSearch', renderModules],
    ['fnSearch', null],           // 特殊功能在 renderFunctions 内绑定
  ]) {
    const el = $(id);
    if (el && fn) el.addEventListener('input', fn);
  }
}

load().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;background:#5a1e1e;color:#fff">数据加载失败：${e.message}<br>
     请通过本地服务访问：<code>npm run app</code> → <a style="color:#fff" href="http://localhost:8848/app/">http://localhost:8848/app/</a></div>`);
});
