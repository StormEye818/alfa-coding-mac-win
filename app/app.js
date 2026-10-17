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
import { Elm327, hexToBytes } from '../src/elm327.js';
import { Uds, NRC } from '../src/uds.js';
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
  aligning: false,
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
  try { await disconnectBridge(); } catch {}
  state.connected = false;
  state.readDone = false;
  if (state.session) state.session.current = null;
  $('connState').textContent = '未连接';
  $('connState').className = 'pill offline';
  $('modState').textContent = '未连接模块';
  $('modState').className = 'pill mod';
  $('readState').textContent = '未读取配置';
  $('readState').className = 'pill offline';
  log('已断开连接并复位');
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
      state.link = new DemoLink({ log: (m) => log(m) });
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
  try {
    const bodyName = modLabel(state.session.bodyModule);
    stage(`正在连接模块：${bodyName}（${state.session.bodyModule}）…`);
    await stageWait(520);
    await state.session.ensureModule(state.session.bodyModule);
    stage(`已连接 ${bodyName}，正在读取车辆配置…`);
    const d1 = await state.uds.readProxi();
    state.block = new ProxiBlock(d1);
    state.baseline = state.block.clone();
    freezePresenceBaseline(state.block);      // 首读冻结在场位基线（P1-1：防 CRC 区漂移）
    state.readDone = true;
    state.namedPicks.clear();
    state.selected.clear();
    state.bitEditIndex = null;
    $('readState').textContent = `已读取 ${d1.length} 字节`;
    $('readState').className = 'pill online';
    stageDone(`配置读取完成：${d1.length} 字节，校验${state.block.verify().ok ? '自洽' : '异常'}`);
    renderNamed(); renderFeatures(); renderEditor();
  } catch (e) {
    stageFail('读取失败：' + e.message);
    alert('读取失败：' + e.message);
  }
}

$('btnConnect').addEventListener('click', async (e) => {
  await connect(e.ctrlKey || e.metaKey);
  if (state.connected) await readConfig();
});

/** 模拟模式：不连接车辆，浏览各模块的参数/测试/标定（对应 Ctrl+F10） */
$('btnSimulate').addEventListener('click', async () => {
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
$('btnRead').addEventListener('click', readConfig);
$('cableOk').addEventListener('click', () => {
  hideCableHint();
  if (state.session) state.session.confirmCable();
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
    const curLabel = cur === null ? '未读取' : (curOpt ? t(curOpt.label) : `未知值 ${hex16(cur)}`);
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
      const out = { addr: p.addr, bits: { ...(o.bits || {}) } };
      if (o.fixed !== undefined && o.fixed !== null) out.fixed = o.fixed;
      return out;
    }),
  };
}

/**
 * 扩展项选择值 → 补丁。值域：
 *   number   = 选项索引（有选项项）
 *   null     = 启用（无选项项的默认补丁）
 *   'off'    = 不启用（纯位启用型：对应位写 0）
 *   'revert' = 恢复原状（覆盖的位/字节写回基线读取值）
 */
function resolveFeaturePatch(f, selValue, baseline) {
  if (selValue === 'off') {
    return {
      bytes: (f.patches || []).map((p) => ({
        addr: p.addr,
        bits: Object.fromEntries(Object.keys(p.bits || {}).map((b) => [b, 0])),
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
  renderNamed(); renderFeatures(); renderEditor(); detectConflicts();
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
  renderEditor(); renderNamed(); renderFeatures(); detectConflicts();
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
      + (changed ? (isCrc ? ' changed' : ' changed') : '')
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
  renderEditor(); renderNamed(); renderFeatures(); detectConflicts();
  log('已放弃全部改动');
});
async function writeToEcu() {
  if (!(await ensureRead())) return;
  if (!confirm('确认写入 ECU？写入前请确认已导出备份。')) return;
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
  }
}
// 「写入 ECU」在三处等价：字节编辑器页 / 隐藏功能页 / 待写浮动条
for (const id of ['btnWrite', 'btnWriteFeatures', 'fwWrite']) $(id).addEventListener('click', writeToEcu);

/** 待写浮动条：有待写选择时提示并直达「写入 ECU」 */
function updateFloatBar() {
  const bar = $('floatWriteBar');
  if (!bar) return;
  const n = state.namedPicks.size + state.selected.size;
  bar.classList.toggle('hidden', n === 0 || !state.readDone);
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

/** 解析 诊断数据的在场位编码，如 "0101Present|0100Not present" → 掩码 0x01，安装=1 */
function presenceInfo(node) {
  let mask = 0, presentVal = null, absentVal = null;
  for (const part of String(node.presence || '').split('|')) {
    const m = /^([0-9A-Fa-f]{4})(.*)$/.exec(part.trim());
    if (!m) continue;
    const maskByte = parseInt(m[1].slice(0, 2), 16);
    const val = parseInt(m[1].slice(2, 4), 16);
    mask |= maskByte;
    const label = m[2].trim();
    if (/^not\s/i.test(label)) absentVal = val; else presentVal = val;
  }
  return { mask, presentVal, absentVal };
}

/**
 * 在场位与 CRC 校验区（DATA1[6..10]）重叠的节点：
 * seal() 每次重算 CRC 都会改写这几个字节，按当前块动态判装/卸会随 CRC 漂移。
 * 这些节点的判定一律以「在场位基线」为准，并在界面上明确标注。
 */
function presenceOverlapsCrc(node) {
  // ⚠️ 字节号是 **1-based 社区口径**，CRC 区是 **0-based [6..10] = 社区 Byte7..11**。
  //    三方互证（2026-10-16 审计 ★1）：proxi.js `#toIdx(no)=no-1`、
  //    白名单「写 DATA1[6..10]」、实车照片头部 `406200232331OUTPUT-SIT %` 逐段咬合。
  //    此前判 6..10 差一位：startByte=6 假阳性、startByte=11 的 AMP/CDM/RLCM/SRM/SCRM/VPAM 漏标。
  return node.startByte >= 7 && node.startByte <= 11;
}

/** 在场位基线：首次读取时判定并记住（localStorage 跨会话保持） */
function presenceBaselineKey() {
  return `alfaproxi.presenceBaseline.${(document.getElementById('platform') || {}).value || '952'}`;
}
function loadPresenceBaseline() {
  try { return JSON.parse(localStorage.getItem(presenceBaselineKey()) || 'null'); } catch { return null; }
}
function savePresenceBaseline(map) {
  try { localStorage.setItem(presenceBaselineKey(), JSON.stringify(map)); } catch { /* 隐私模式等忽略 */ }
}

/** 该节点是否安装；未读取时返回 null。以基线为准，不再随 CRC 字符漂移 */
function nodePresent(node) {
  if (state.presenceMap && node.name in state.presenceMap) return state.presenceMap[node.name];
  if (!state.block) return null;
  const { mask, presentVal } = presenceInfo(node);
  if (presentVal === null || mask === 0) return null;
  return (state.block.getByte(node.startByte) & mask) === presentVal;
}

/** 读取后冻结在场位基线（仅第一次；后续读取/写入/seal 均不影响） */
function freezePresenceBaseline(block) {
  if (state.presenceMap) return;
  const saved = loadPresenceBaseline();
  state.presenceMap = {};
  for (const n of state.modules.alignmentNodes) {
    if (saved && n.name in saved) { state.presenceMap[n.name] = saved[n.name]; continue; }
    const { mask, presentVal } = presenceInfo(n);
    state.presenceMap[n.name] = (presentVal === null || mask === 0)
      ? null
      : (block.getByte(n.startByte) & mask) === presentVal;
  }
  if (!saved) savePresenceBaseline(state.presenceMap);
}

/** 对齐写入结果反哺基线：车上拒写「无已安装节点」→ 学到未安装 */
function learnPresence(node, installed) {
  if (!state.presenceMap || state.presenceMap[node.name] === installed) return;
  state.presenceMap[node.name] = installed;
  savePresenceBaseline(state.presenceMap);
}

/** 当前勾选的节点（按 DOM 顺序） */
function selectedNodes() {
  return [...document.querySelectorAll('.node')]
    .filter((el) => el.querySelector('.pick')?.checked)
    .map((el) => state.modules.alignmentNodes[Number(el.dataset.idx)]);
}
function forEachNodeEl(fn) {
  document.querySelectorAll('.node').forEach((el) => fn(el, state.modules.alignmentNodes[Number(el.dataset.idx)]));
}
function setSelection(pred) {
  forEachNodeEl((el, n) => {
    const cb = el.querySelector('.pick');
    if (cb) cb.checked = pred(el, n);
  });
  updateAlignButtons();
}
function updateAlignButtons() {
  const n = selectedNodes().length;
  $('btnAlign').textContent = n ? `对齐所选节点（${n}）` : '对齐所选节点';
  $('btnAlign').disabled = n === 0;
}

function renderAlign() {
  const wrap = $('alignGroups');
  wrap.innerHTML = '';
  state.modules.alignmentNodes.forEach((n, i) => { n._idx = i; });
  const groups = { plain: [], comfort: [], swap: [] };
  for (const n of state.modules.alignmentNodes) {
    if (n.excluded) continue;                 // 其它平台专属节点，952/949 不装配
    groups[nodeGroupOf(n)].push(n);
  }

  for (const key of ['plain', 'comfort', 'swap']) {
    const list = groups[key];
    if (!list.length) continue;
    const div = document.createElement('div');
    div.className = 'group collapsed-absent';
    div.innerHTML = `
      <header>
        <h3>${state.modules.busGroups[key].label}</h3>
        <span class="meta">${list.length} 个节点 · ${state.modules.busGroups[key].baud}kbit/s · ${
          state.modules.busGroups[key].cable === 'none' ? '无需换线' : state.modules.busGroups[key].cable
        }</span>
        <button class="toggle-absent" data-group="${key}">显示未安装节点</button>
      </header>
      <div class="nodes">${list.map((n) => `
        <div class="node" data-st="wait" data-group="${key}" data-idx="${n._idx}">
          <input type="checkbox" class="pick" checked>
          <div class="nm">${tSpan(n.name)}${presenceOverlapsCrc(n) ? '<span class="tiny" title="该节点在场位字节落在 CRC 校验区（DATA1[6..10]）内，装/卸判定以首次读取的在场位基线为准，不随 CRC 重算漂移"> 在场位与 CRC 区重叠</span>' : ''}</div>
          <div class="ad">地址 0x${n.addr} · ${n.baud}k</div>
          <div class="st">○ 待检查</div>
        </div>`).join('')}</div>`;
    wrap.appendChild(div);
  }
  $('stTotal').textContent = state.modules.alignmentNodes.filter((n) => !n.excluded).length;
  $('stDone').textContent = 0;
  $('stFail').textContent = 0;
  $('stPending').textContent = state.modules.alignmentNodes.length;
  $('stPresent').textContent = '—';
  $('stAligned').textContent = '—';
  $('stMisaligned').textContent = '—';
  $('alignVerdict').classList.add('hidden');
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
 * 逐模块读取对齐状态（教程 §5.1）。
 * 主判据：逐节点 22 10 2A 回读校验（基准 = 车身电脑当前 PROXI 块）——有差异即未对齐；
 * 辅助：0x292E 写入计数与车身电脑比对（不一致同样按未对齐计）。
 */
$('btnCheckAlign').addEventListener('click', async () => {
  if (!(await ensureRead())) return;
  const nodes = [...document.querySelectorAll('.node')];
  const total = nodes.length;
  let present = 0, aligned = 0, mis = 0, skipped = 0, failed = 0;
  stage('正在读取各模块对齐状态…');
  await stageWait(320);

  // 1) 车身电脑为基准：基准块（22 10 2A 比对参照）+ 写入计数（辅助）
  await state.session.ensureModule(state.session.bodyModule);
  const refBytes = await state.uds.readProxi();
  const ref = await state.uds.readProxiWriteCounter();
  stage(`基准：${modLabel(state.session.bodyModule)} PROXI 块 ${refBytes.length} 字节 · 写入计数 ${ref}`);
  await stageWait(300);

  // 2) 逐节点 22 10 2A 回读校验
  let i = 0;
  for (const el of nodes) {
    i++;
    const n = state.modules.alignmentNodes[Number(el.dataset.idx)];
    const nm = el.querySelector('.nm').textContent.trim();
    const inst = nodePresent(n);

    if (inst === false) {
      el.dataset.st = 'absent';
      el.classList.add('absent');
      el.querySelector('.st').innerHTML = '<b>未安装</b>';
      el.querySelector('.pick').checked = false;
      skipped++;
      continue;
    }
    present++;
    el.querySelector('.st').innerHTML = `<b>○ 正在读取 ${i}/${total}…</b>`;
    stage(`正在读取对齐状态 ${i}/${total} · ${nm}`);

    try {
      // 通过会话连接该节点所属模块（换线提示走正常流程）
      await state.session.connectNode(n);
      const v = await state.uds.verifyProxi(refBytes);       // 22 10 2A：主判据
      const c = await state.uds.readProxiWriteCounter();     // 0x292E：辅助
      const ok = v.ok && c === ref;
      const reason = !v.ok
        ? `22 10 2A 差异：Byte${v.diffs.map((d) => d.byte).join('、Byte')}`
        : `计数 ${c} / 车身 ${ref}`;
      if (ok) {
        el.dataset.st = 'aligned';
        el.classList.remove('absent');
        el.querySelector('.st').innerHTML = `<b>✓ 已对齐</b><br><span class="reason">${reason}</span>`;
        aligned++;
      } else {
        el.dataset.st = 'misaligned';
        el.classList.remove('absent');
        el.querySelector('.st').innerHTML = `<b>⚠ 未对齐</b><br><span class="reason">${reason}</span>`;
        mis++;
      }
    } catch (e) {
      el.dataset.st = 'fail';
      el.querySelector('.st').innerHTML = `<b>✗ 读取失败</b><br><span class="reason">${e.message}</span>`;
      failed++;
    }
  }

  $('stPresent').textContent = present;
  $('stAligned').textContent = aligned;
  $('stMisaligned').textContent = mis + failed;

  const v = $('alignVerdict');
  v.classList.remove('hidden', 'ok', 'bad');
  if (mis === 0 && failed === 0 && present > 0) {
    v.classList.add('ok');
    v.textContent = '✓ 整车对齐正常，无里程表闪烁';
    stageDone(`对齐状态检查完成：${aligned} 个已对齐`);
  } else {
    v.classList.add('bad');
    v.textContent = `⚠ 有 ${mis + failed} 个模块未对齐 → 里程表会闪烁`;
    stageFail(`对齐状态检查完成：${aligned} 已对齐 / ${mis} 未对齐${failed ? ` / ${failed} 读取失败` : ''}`);
  }
});

$('btnAlignAll').addEventListener('click', () => {
  setSelection((el) => !el.classList.contains('absent'));
  $('btnAlign').click();
});
bindStatFilter('stMisalignedBox', (el) => el.dataset.st === 'misaligned');
bindStatFilter('stFailBox', (el) => el.dataset.st === 'fail');
bindStatFilter('stAlignedBox', (el) => el.dataset.st === 'aligned');
$('btnSelAll').addEventListener('click', () => setSelection((el) => !el.classList.contains('absent')));
$('btnSelNone').addEventListener('click', () => setSelection(() => false));
$('btnSelFail').addEventListener('click', () =>
  setSelection((el) => el.dataset.st === 'fail' || el.dataset.st === 'misaligned'));
$('btnSelMisalign').addEventListener('click', () =>
  setSelection((el) => el.dataset.st === 'misaligned' || el.dataset.st === 'fail'));

$('btnAlign').addEventListener('click', async () => {
  if (state.aligning) return;
  if (!(await ensureRead())) return;
  // 教程 §5.3 对齐前安全警告（ABS 复位/标定、勿中断、钥匙 ON）
  const warn = '开始 PROXI 对齐？该过程将逐节点写入配置。\n\n'
    + '⚠ 对齐会复位 ABS（Giulia/Stelvio），完成后需做转向角、加速度、胎压标定。\n'
    + '⚠ 一旦开始不要中断。钥匙 ON、发动机 OFF。\n\n'
    + '确认已了解上述注意事项并继续？';
  if (!confirm(warn)) return;
  const chosen = selectedNodes();
  if (!chosen.length) return alert('请先勾选要对齐的节点');
  // —— 写前双重读一致性（标准流程）：连续两次读车身块必须一致，防读链路抖动把脏数据写下去 ——
  let liveBlock = null;   // 车身电脑当前块 —— 判定「部分对齐是否安全」的基准
  try {
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
    .filter((el) => nodePresent(state.modules.alignmentNodes[Number(el.dataset.idx)]) !== false);
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
        const st = el.dataset.st;
        return (st === 'misaligned' || st === 'fail') && !chosenIdx.has(Number(el.dataset.idx));
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
          if (el && el.querySelector('.pick')?.checked) chosenIdx.add(i);
        }
        log(`已补选 ${leftover.length} 个未对齐节点`);
      } else {
        log(`⚠ 用户选择跳过 ${leftover.length} 个未对齐节点 —— 对齐后里程表仍会闪`);
      }
    }
  }

  const chosenNodes = [...document.querySelectorAll('.node')]
    .filter((el) => chosenIdx.has(Number(el.dataset.idx)));
  state.aligning = true;
  const total = chosen.length;
  const failed = [];
  try {
    const nodes = chosenNodes;
    let done = 0, fail = 0, idx = 0;
    for (const key of ['plain', 'comfort', 'swap']) {
      const grp = state.modules.busGroups[key].label;
      for (const el of nodes.filter((n) => n.dataset.group === key)) {
        if (!el.querySelector('.pick')?.checked) continue;
        idx++;
        const nodeName = el.querySelector('.nm').textContent.trim();
        // —— 开始：明确告知正在对齐哪一个 ——
        el.dataset.st = 'work';
        el.querySelector('.st').innerHTML = '<b>● 对齐中…</b>';
        stage(`⟳ 正在对齐 ${idx}/${total} · ${nodeName}`);
        await stageWait(260);

        let ok = true, errMsg = '';
        try {
          // 逐节点连接（跨总线分组会提示换适配线），再写入 + 回读校验
          const node = state.modules.alignmentNodes[Number(el.dataset.idx)];
          await state.session.connectNode(node);
          await state.uds.writeProxi(state.block.bytes);
          learnPresence(node, true);
          // 写后按节点读 22 10 2A：存储块与基准块（车身电脑 PROXI）比对
          const v = await state.uds.verifyProxi(state.block.bytes);
          if (!v.ok) {
            ok = false;
            errMsg = '回读校验发现差异：' + v.diffs.map((d) => `Byte${d.byte}`).join('、');
          }
        } catch (e) {
          ok = false; errMsg = e.message;
          if (e && e.nrc === 0x31) learnPresence(state.modules.alignmentNodes[Number(el.dataset.idx)], false);
        }

        // —— 结束：立刻给出结论 ——
        if (ok) {
          el.dataset.st = 'ok';
          el.querySelector('.st').innerHTML = '<b>✓ 对齐成功</b>';
          done++;
          stage(`✓ ${idx}/${total} · ${nodeName} 对齐成功`);
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
        // 每节点之间留 ECU 存储沉降时间（标准流程 2.5 秒）
        await stageWait(2500);
      }
    }
    // 全部节点完成后留 ECU 收尾时间（标准流程 1 秒）
    await stageWait(1000);
    if (failed.length) {
      stageFail(`对齐结束：成功 ${done} / 失败 ${fail}`);
      alert(`PROXI 对齐结束\n\n成功 ${done} 个节点\n失败 ${fail} 个节点：\n\n${failed.slice(0, 10).join('\n')}${failed.length > 10 ? '\n…' : ''}\n\n失败节点可重试。`);
    } else {
      stageDone(`对齐完成：${done} 个节点全部成功`);
      alert(`PROXI 对齐完成\n\n${done} 个节点全部对齐成功`);
    }
  } finally {
    state.aligning = false;
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
      if (multiPos) {
        // 多位输入（RWUSERENTRY 29 族，如 VIN 逐位）：每位一个下拉，选项表是字符/字节盘
        ctrl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px">${Array.from({ length: spec.bytes }, (_, i) =>
          `<select class="imPos" data-i="${i}" style="min-width:62px">${spec.options.map((o, j) =>
            `<option value="${j}">${t(o.label) || o.label}</option>`).join('')}</select>`).join('')}</div>`;
      } else {
        ctrl.innerHTML = `<select id="imValue">${spec.options.map((o, i) =>
          `<option value="${i}">${t(o.label) || o.label}</option>`).join('')}</select>`;
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
  if (parts.length !== 2) return null;
  const rraw = hexToBytes(parts[0]);
  const wraw = hexToBytes(parts[1]);
  if (rraw.length < 4 || rraw[0] !== 3 || rraw[1] !== 0x22) return null;   // 首条=单帧读
  if (wraw.length < 4) return null;
  const wlen = wraw[0];
  const wpay = wraw.slice(1, 1 + wlen);
  if (wpay[0] !== 0x2e || wpay.length < 4) return null;                    // 次条=写模板
  const did = (wpay[1] << 8) | wpay[2];
  let base = null;
  try { base = await state.uds.readDataByIdentifier(did); } catch { /* 读不回就以模板为基线 */ }
  const merged = mergeWriteField(wpay.slice(3), base, picked, item);
  const np = new Uint8Array(4 + merged.length);
  np[0] = 3 + merged.length;
  np[1] = 0x2e; np[2] = wpay[1]; np[3] = wpay[2];
  np.set(merged, 4);
  const hex = Array.from(np).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  return parts[0] + ',' + hex;
}

let fnAbort = false;   // 执行中取消标志（中止→发最后一条命令恢复，标准语义）

async function runCommandString(cmdStr, item) {
  const sent = [];
  const parts = cmdStr.split(',').map((p) => p.trim().replace(/\s/g, '')).filter(Boolean);
  // 命令间隔（标准执行器语义）：默认 2s；无旗标时 1 条命令=8s、2 条=6s（结果沉降）。
  //
  // ⚠️ 延时旗标必须与标准流程**全量对齐** —— 库里是 7 个，我们此前只实现了 5 个：
  //   NOWAIT=0 · 0.5SEC · 1SEC · **10SEC** · 20SEC · **30SEC** · 50SEC
  //   （10SEC / 30SEC 是 2026-10-16 补的，此前漏了 → 用到这两个的执行器会等错时间）
  // 另有行为类旗标（语义待深挖，暂不拦截）：EXECANY / NOABORT / WAITY / TD100 /
  //   IORESULT / RWUSERENTRY / SPEEDLIMIT / bitw
  const flags = String((item && item.resultFormat) || '').toUpperCase();
  let interMs = 2000;
  if (flags.includes('NOWAIT')) interMs = 0;
  else if (flags.includes('0.5SEC')) interMs = 500;
  else if (flags.includes('1SEC') && !flags.includes('10SEC')) interMs = 1000;
  else if (flags.includes('10SEC')) interMs = 10000;
  else if (flags.includes('20SEC')) interMs = 20000;
  else if (flags.includes('30SEC')) interMs = 30000;
  else if (flags.includes('50SEC')) interMs = 50000;
  else if (parts.length === 2) interMs = 6000;
  else if (parts.length === 1) interMs = 8000;

  // 中止/取消语义：下发最后一条真实 UDS 作恢复（回到安全态）
  let lastReal = null;
  for (const p of parts) {
    const r = hexToBytes(p);
    if (r.length && r[0] > 0 && r[0] < 0xF0) lastReal = r;
  }
  const restoreLast = async () => {
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

  for (let i = 0; i < parts.length; i++) {
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
    const resp = await state.link.request(payload);
    const hex = Array.from(payload).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      + (len > 7 ? '（多帧）' : '');
    if (resp && resp[0] === 0x7f) {
      const nrc = resp[2];
      sent.push(`${hex} → ✗ NRC 0x${nrc.toString(16).toUpperCase()}（${NRC[nrc] || '未知'}）`);
      throw new Error(`命令被拒：NRC 0x${nrc.toString(16).toUpperCase()}（${NRC[nrc] || '未知'}）`);
    }
    sent.push(hex + ' → ✓');
    // 命令间沉降（FE/FF 节奏由 token 自带，真实命令之间按旗标等效等待）
    if (interMs > 0 && (i < parts.length - 1 || parts.length === 1)) {
      if (!(await waitCancellable(interMs))) {
        sent.push('[执行中止→恢复]');
        await restoreLast();
        return sent;
      }
    }
  }
  return sent;
}

function renderFunctions() {
  const wrap = $('funcList');
  const all = state.funcs.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.category })));
  $('fnTotal').textContent = all.length;
  $('fnOffline').textContent = all.filter((i) => i.security.level === 'none').length;
  $('fnPin').textContent = all.filter((i) => i.security.level === 'pin').length;
  $('fnServer').textContent = all.filter((i) => i.security.level === 'server').length;

  const catSel = $('funcCat');
  const modSel = $('fnModule');
  if (catSel.options.length <= 1) {
    for (const c of state.funcs.categories) {
      const o = document.createElement('option');
      o.value = c.category;
      o.textContent = `${t(c.category) || c.category}（${c.count}）`;
      catSel.appendChild(o);
    }
    // 分模块筛选：按功能数量降序
    const perMod = {};
    for (const i of all) perMod[i.module] = (perMod[i.module] || 0) + 1;
    for (const [code, n] of Object.entries(perMod).sort((a, b) => b[1] - a[1])) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = `${modLabel(code)}（${n}）`;
      modSel.appendChild(o);
    }
    catSel.addEventListener('change', renderFunctions);
    modSel.addEventListener('change', renderFunctions);
    $('funcSec').addEventListener('change', renderFunctions);
    $('fnSearch').addEventListener('input', renderFunctions);
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
      <button class="small" data-run="${encodeURIComponent(i.name)}" data-mod="${i.module}"${
        i.security.level === 'server' ? ' disabled' : ''
      }>${i.kind === '执行器' ? '执行' : '运行'}</button>
    </div>`).join('') +
    (list.length > 260 ? `<div class="dim" style="padding:10px">仅显示前 260 条（共 ${list.length} 条），请用上方筛选缩小范围</div>` : '');

  wrap.querySelectorAll('button[data-run]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = decodeURIComponent(b.dataset.run);
      const mod = b.dataset.mod;
      const item = all.find((x) => x.name === name && x.module === mod);
      if (!item) return;
      if (!modSess.code) {
        alert('请先「进入模块」：在上方选择本功能所属模块，点「进入模块」并确认。');
        return;
      }
      if (modSess.code !== item.module) {
        alert(`当前已进入模块 ${modLabel(modSess.code)}（${modSess.code}）。\n此功能属于 ${modLabel(item.module)}（${item.module}）。\n请先「退出模块」，再进入该模块。`);
        return;
      }
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
          await state.uds.securityAccess(String(pin).trim());
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
            if (picked && item.input && !item.workflow) {
              const merged = await mergeRwUserEntry(item, picked);
              if (merged) {
                cmdToSend = merged;
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
            // ⛔ PROXI 对齐类目的一键执行已禁用（2026-10-16 审计 ★4）。
            // 原因：commands 里的 `992E2023` + 全零模板，`input.options` 的 mask/value
            // **从不套用到块上**（askInput 结果只用于显示）→ 会把 PROXI 配置区写成全零。
            // 正确路径是 named-settings：{startByte, mask, value} → applyPatch → writeProxi(真实 289 字节块)。
            // 而且 functions.json 里这 45 项与 named-settings 的 44 项是同名副本（named-settings 有 startByte）。
            if (item.category === 'PROXI 对齐' || /,992E2023/.test(item.commands || '')) {
              alert('「' + t(item.name) + '」已改走「隐藏功能 / 命名设置」路径。\n\n'
                + '原因：这条一键命令会下发**全零配置块**（输入项的掩码/值从未套用到块上），'
                + '有写坏 PROXI 配置区的风险。\n\n'
                + '请到「隐藏功能」页找同名设置项修改 —— 那条路径走的是'
                + '读块 → 按 startByte/mask/value 改位 → 写回真实块 → 回读校验。');
              return null;
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
        stageDone(`完成：${t(item.name)}（下发 ${sent.length} 帧）`);
        const valLine = (picked && typeof picked === 'object') ? `\n设定值：${picked.label}` : '';
        alert(`执行完成\n\n项目：${t(item.name)}\n模块：${m2label(item.module)}${valLine}\n下发帧：\n${sent.join('\n') || '（无）'}`);
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
  const list = state.modules.modules;
  stage(`正在扫描车辆支持的控制模块…`);
  // 真实逐模块探测：对每个模块发 testerPresent，按应答标注（不再只是静态清单）
  let ok = 0, none = 0, skipped = 0;
  for (const m of list) {
    const grp = (state.cables.modules[m.code] || {}).group || 'none';
    const mustSwap = !(state.link && state.link.autoSwitchesBus) && grp !== 'none'
      && state.session.currentGroup !== grp;
    if (mustSwap) { m.scanState = 'skip'; skipped++; renderModules(); continue; }
    stage(`正在探测 ${m.code}（${modLabel(m.code)}）…`);
    try {
      await Promise.race([
        state.session.runOn(m.code, async () => { await state.uds.testerPresent(); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 1500)),
      ]);
      m.scanState = 'ok'; ok++;
    } catch {
      m.scanState = 'none'; none++;
    }
    renderModules();
  }
  renderModules();
  stageDone(`扫描完成：${ok} 个有应答${none ? ` / ${none} 个无应答` : ''}${skipped ? ` / ${skipped} 个跨总线未探测（需换适配线）` : ''}`);
});

/** 手动连接指定模块（选模块→连接） */
async function connectModuleManual(code) {
  try {
    if (!(await ensureConnected())) return;
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
  if (state.session) state.session.current = null;
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

function renderModules() {
  const q = ($('modSearch') && $('modSearch').value) || '';
  const list = state.modules.modules.filter((m) =>
    hit(q, m.code, m.name, modLabel(m.code), m.bus, m.tx));
  $('moduleList').innerHTML = list.length ? '' : '<div class="dim" style="padding:14px">没有匹配的模块</div>';
  const currentCode = state.session && state.session.current ? state.session.current.code : null;
  $('moduleList').innerHTML += list.map((m) => `
    <div class="mrow">
      <div class="code">${m.code}</div>
      <div class="grow">
        <div class="name">${modLabel(m.code)}${{
          ok: '<span class="state-tag written">有应答</span>',
          none: '<span class="state-tag failed">无应答</span>',
          skip: '<span class="state-tag pending">跨总线未探测</span>',
        }[m.scanState || ''] || ''}</div>
        <div class="sub">${m.code} · ${m.bus} · 地址 0x${m.tx} ← 0x${m.rx} · ${m.platforms.join('/')} · ${
          { none: '无需换线', comfort: '5 号蓝色适配线', swap: '6 号灰色适配线' }[(state.cables.modules[m.code] || {}).group || 'none']
        }</div>
      </div>
      <button class="small ${m.code === currentCode ? 'primary' : 'ghost'}" data-mod="${m.code}">${m.code === currentCode ? '断开' : '连接'}</button>
    </div>`).join('');
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
  const sel = $('dtcModule');
  if (sel.options.length > 1) return;
  for (const m of state.modules.modules) {
    const o = document.createElement('option');
    o.value = m.code;
    o.textContent = `${modLabel(m.code)}（${m.code}）`;
    sel.appendChild(o);
  }
  const lv = $('liveModule');
  if (lv && lv.options.length <= 1) {
    for (const m of state.modules.modules) {
      const o = document.createElement('option');
      o.value = m.code;
      o.textContent = `${modLabel(m.code)}（${m.code}）`;
      lv.appendChild(o);
    }
  }
}

$('btnReadDtc').addEventListener('click', async () => {
  const code = $('dtcModule').value;
  if (!code) return alert('请先选择模块');
  if (!(await ensureConnected())) return;
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
      wrap.innerHTML = list.map((d) => {
        const rawHex = d.raw.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
        const hit = dtcLookup(code, rawHex);
        return `<div class="mrow">
          <div class="dtc-code">${d.code}</div>
          <div class="grow">
            <div class="name">${hit ? hit.name : '未知故障'}${d.confirmed ? '<span class="state-tag failed">已确认</span>' : ''}${d.pending ? '<span class="state-tag pending">待定</span>' : ''}</div>
            ${hit && hit.desc ? `<div class="sub">${hit.desc}</div>` : ''}
            <div class="sub">原始码 ${rawHex} · 状态 0x${d.status.toString(16).toUpperCase().padStart(2, '0')}</div>
          </div>
          <button class="small ghost" data-snap="${rawHex}">冻结帧</button>
        </div>`;
      }).join('');
      // 冻结帧（19 04）：故障发生瞬间的车速/水温等快照——排障关键数据
      wrap.onclick = async (e) => {
        const btn = e.target.closest('[data-snap]');
        if (!btn) return;
        const rawHex = btn.dataset.snap;
        const panelId = 'snap-' + rawHex;
        const old = document.getElementById(panelId);
        if (old) { old.remove(); return; }
        const hi = parseInt(rawHex.substr(0, 2), 16);
        const lo = parseInt(rawHex.substr(2, 2), 16);
        try {
          stage(`正在读取 ${rawHex} 的冻结帧…`);
          await state.session.runOn(code, async () => {
            const resp = await state.uds.readDtcSnapshot(hi, lo);
            const items = (state.snapshots && state.snapshots.modules && state.snapshots.modules[code]) || [];
            const rows = items.map((s) => {
              const v = applyScale(resp, { spec: s });
              return `<div class="mrow"><div class="grow"><div class="name">${tSpan(s.name)}</div></div>`
                + `<div class="live-val">${v ?? '—'}<span style="color:var(--dim);font-size:12px"> ${s.unit || ''}</span></div></div>`;
            }).join('');
            btn.closest('.mrow').insertAdjacentHTML('afterend',
              `<div id="${panelId}" style="grid-column:1/-1">${rows || '<div class="dim" style="padding:10px">该模块无冻结帧参数表</div>'}</div>`);
            stageDone(`冻结帧：${items.length} 项`);
          });
        } catch (err) {
          stageFail('冻结帧读取失败：' + err.message);
          alert('冻结帧读取失败：' + err.message);
        }
      };
      stageDone(`读取完成：${list.length} 条故障码`);
    });
  } catch (e) {
    stageFail('读取失败：' + e.message);
    alert('读取失败：' + e.message);
  }
});

$('btnClearDtc').addEventListener('click', async () => {
  const code = $('dtcModule').value;
  if (!code) return alert('请先选择模块');
  if (!confirm(`确认清除 ${modLabel(code)} 的故障码？\n\n清除后历史故障记录将丢失，需重新读取才能显示。`)) return;
  if (!(await ensureConnected())) return;
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
  const m = state.cables.modules[code] || {};
  // 非免换线适配器：连接前提醒接对应适配线，确认后再连（与通用诊断流程一致）
  const wantGroup = m.group || 'none';
  const autoBus = state.link && state.link.autoSwitchesBus;
  const mustSwap = !autoBus && wantGroup !== 'none'
    && (!state.session || state.session.currentGroup !== wantGroup);
  const lines = [
    `进入模块：${modLabel(code)}（${code}）`,
    `地址 0x${m.tx || '??'} · ${m.baud || '?'}k`,
  ];
  if (mustSwap) {
    lines.push('', `⚠ 请先接好适配线：${m.hint || cableBrief(code)}`, '接好后点「确定」，App 再连接模块。');
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
  if (!opts.auto && !confirm(`确认退出模块 ${modLabel(modSess.code)}（${modSess.code}）？\n退出后才能选择其他模块。`)) return;
  stopLiveLoop();
  if (state.session) state.session.disconnectModule();
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
    if (inMod) $('fnModule').value = modSess.code;
  }
  renderFunctions();
  renderLiveParams();
}

/* ================= 实时数据 ================= */
const live = { running: false, samples: [], lastItems: [], items: [], picks: [] };

function applyScale(raw, item) {
  if (!raw || !raw.length) return null;
  const spec = item.spec || {};
  const nb = spec.bytes || 1;
  const st = spec.start || 0;                       // 参数在应答里的起始偏移（0-based）
  const fmt = spec.format || '';
  const slice = raw.slice(st, Math.min(raw.length, st + nb));
  if (!slice.length) return null;

  // 非数值格式：按格式族分支
  if (fmt === 'str') return slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').replace(/\0+$/, '');
  if (fmt === 'hex') return Array.from(slice).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  if (fmt === 'hex2') return Array.from(slice).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  if (fmt === 'bits' || fmt === 'bitw' || fmt === 'bitchars' || /^\d{3,5}$/.test(fmt)) {
    // bit 族语义（2026-10-17 审计）：选项表 = `MMVV标签`（bits 首字节）/
    // `MMVVMMVV标签`（bitw 双字节配对）/ bitchars 逐字节拼字符；末项为兜底。
    const opts = spec.options;
    const hx = (s, i) => parseInt(s.substr(i, 2), 16);
    if (!opts || !opts.length) {
      return Array.from(slice).map((b) => b.toString(2).padStart(8, '0')).join(' ');
    }
    const match1 = (b, e) => (b & hx(e, 0)) === hx(e, 2);
    if (fmt === 'bitw' && slice.length >= 2) {
      for (let k = 0; k < opts.length; k++) {
        const e = opts[k];
        if (((slice[0] & hx(e, 0)) === hx(e, 2) && (slice[1] & hx(e, 4)) === hx(e, 6)) || k === opts.length - 1) {
          return e.slice(8);
        }
      }
    }
    if (fmt === 'bitchars') {
      let out = '';
      for (const b of slice) {
        for (let k = 0; k < opts.length; k++) {
          if (match1(b, opts[k]) || k === opts.length - 1) { out += opts[k].slice(4); break; }
        }
      }
      return out;
    }
    for (let k = 0; k < opts.length; k++) {
      if (match1(slice[0], opts[k]) || k === opts.length - 1) return opts[k].slice(4);
    }
  }
  // nm 族：nm,小数位,系数,偏移,掩码 —— 先按掩码截位再线性换算（如节气门开度 %）
  if (fmt.startsWith('nm')) {
    const p = fmt.split(',');
    const mask = p[4] ? (parseInt(p[4], 16) >>> 0) : 0xff;
    let n = 0;
    for (const b of slice) n = n * 256 + b;
    n &= mask;
    n = n * (spec.scale ?? (p[2] ? Number(p[2]) : 1)) + (spec.offset ?? (p[3] ? Number(p[3]) : 0));
    const dec = spec.decimals ?? (p[1] ? Number(p[1]) : 0);
    return Number((n / Math.pow(10, dec)).toFixed(dec));
  }
  if (fmt === 'date' || fmt === 'datehalf' || fmt.startsWith('eq3') || fmt.startsWith('equ')) {
    // 日期/多项式：数据侧未导入换算参数，退化为 hex
    return Array.from(slice).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }

  // 数值格式：大端装配 + nums 族按字节宽两位补码 + (raw*scale+offset)/10^decimals
  let n = 0;
  for (const b of slice) n = n * 256 + b;
  const signed = spec.signed === true || fmt.startsWith('nums');
  if (signed && n >= Math.pow(2, 8 * slice.length - 1)) n -= Math.pow(2, 8 * slice.length);
  n = n * (spec.scale ?? 1) + (spec.offset ?? 0);
  const dec = spec.decimals ?? 0;
  n = n / Math.pow(10, dec);
  return Number(n.toFixed(dec));
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
  if (!code) { wrap.innerHTML = ''; return; }
  // 进入模块并连接成功后才显示参数列表——避免未连接就勾选、漏掉连接步骤
  if (!modSess.code || modSess.code !== code) {
    state.liveItems = [];
    $('liveCount').textContent = '0';
    wrap.innerHTML = '<div class="dim" style="padding:16px">点「进入模块」并确认连接成功后，这里显示该模块可读参数</div>';
    return;
  }
  const items = (state.params && state.params.modules && state.params.modules[code]) || [];
  state.liveItems = items;
  $('liveCount').textContent = items.length;
  wrap.innerHTML = items.slice(0, 150).map((i, idx) => `
    <div class="mrow">
      <input type="checkbox" class="live-pick" data-idx="${idx}" ${modSess.code ? '' : 'disabled'} style="accent-color:var(--accent)">
      <div class="grow">
        <div class="name">${tSpan(i.name)}</div>
        <div class="sub">DID ${i.did} · ${i.spec && i.spec.unit ? '单位 ' + i.spec.unit + ' · ' : ''}${i.spec && i.spec.scale && i.spec.scale !== 1 ? '换算 ×' + i.spec.scale : ''}</div>
      </div>
      <div class="live-val" id="liveVal-${idx}">—</div>
    </div>`).join('') || '<div class="dim" style="padding:14px">该模块无可读参数</div>';
}
$('liveModule') && $('liveModule').addEventListener('change', renderLiveParams);

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
