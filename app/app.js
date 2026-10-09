/**
 * AlfaProxi 界面逻辑。
 *
 * 流程（与诊断软件一致）：
 *   连接适配器 → 连接目标 ECU（必要时提示换适配线）→ 读取配置 → 显示当前值
 *   → 修改 → 写入 → 读回校验
 *
 * 模拟模式下适配器为 MockAdapter，同样走完整链路，便于验证流程与交互。
 */
import { ProxiBlock } from '../src/proxi.js';
import { Elm327, hexToBytes } from '../src/elm327.js';
import { Uds } from '../src/uds.js';
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

/** 导出文件：桌面 Blob 下载；移动端走系统分享/保存（iOS WebView 对 download 支持弱） */
async function downloadFile(name, text, mime = 'text/plain') {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform()) {
    try {
      const b64 = btoa(unescape(encodeURIComponent(text)));
      await Cap.Plugins.FileSharer.shareFile({ filename: name, base64Data: b64, contentType: mime });
      return;
    } catch (e) {
      log('分享失败，回退下载: ' + (e && e.message));
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
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
      state.link = new Elm327(new BridgePort(state.bridge), {
        adapter: spec.kind === 'vlinker' ? 'vlinker-ms' : 'elm327',
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
      <h3>${tSpan(f.name)}${stateTag(stt)} <span class="tag ${f.status}">${(state.i18n.statusLegend && state.i18n.statusLegend[f.status]) || f.status}</span></h3>
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

$('btnBackup').addEventListener('click', () => {
  if (!state.block) return alert('请先读取车辆配置');
  downloadFile(`proxi-backup-${Date.now()}.txt`, state.block.toHexText());
  stageDone('配置备份已导出');
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
    const cur = b.getByte(i);
    const orig = state.baseline ? state.baseline.getByte(i) : cur;
    const el = document.createElement('div');
    el.className = 'hbyte' + (cur !== orig ? ' changed' : '') + (state.bitEditIndex === i ? ' active' : '');
    let bits = '';
    for (let k = 7; k >= 0; k--) bits += `<div class="b${(cur >> k) & 1 ? ' on' : ''}"></div>`;
    el.innerHTML = `<div class="addr">B${i}</div><div class="val">${hex8(cur)}</div><div class="bits">${bits}</div>`;
    el.title = `Byte ${i} = ${hex8(cur)}`;
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
  const cur = state.block.getByte(i);
  const orig = state.baseline ? state.baseline.getByte(i) : cur;
  let cells = '';
  for (let k = 7; k >= 0; k--) {
    const on = (cur >> k) & 1;
    const wasOn = (orig >> k) & 1;
    cells += `<div class="bit-cell${on ? ' on' : ''}${on !== wasOn ? ' changed' : ''}" data-bit="${k}" title="点击切换 bit${k}">
      <div class="bn">bit${k}</div><div class="bv">${on}</div></div>`;
  }
  panel.innerHTML = `
    <h4>Byte ${i} 位编辑<span class="dim">点击方块直接翻转该位</span><button class="small close" id="bitClose">收起</button></h4>
    <div class="bit-row">${cells}</div>
    <div class="vals">
      <label>十六进制<input id="bitHex" value="${hex8(cur)}" maxlength="2" spellcheck="false"></label>
      <label>原始值<input value="${hex8(orig)}" disabled></label>
      <button class="small ghost" id="bitReset">还原此字节</button>
    </div>`;

  panel.querySelectorAll('.bit-cell').forEach((el) => {
    el.addEventListener('click', () => {
      const k = Number(el.dataset.bit);
      state.block.setBit(i, k, state.block.getBit(i, k) ? 0 : 1);
      afterByteEdit();
    });
  });
  $('bitClose').addEventListener('click', () => { state.bitEditIndex = null; renderEditor(); });
  $('bitReset').addEventListener('click', () => {
    if (state.baseline) state.block.setByte(i, state.baseline.getByte(i));
    afterByteEdit();
  });
  $('bitHex').addEventListener('change', (e) => {
    const raw = e.target.value.trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const v = raw === '' ? NaN : parseInt(raw, 16);
    if (Number.isNaN(v) || v < 0 || v > 255) return alert('输入无效：需要 00 – FF');
    state.block.setByte(i, v);
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
    await state.uds.writeProxi(state.block.bytes);
    stage('正在读回校验…');
    const back = new ProxiBlock(await state.uds.readProxi());
    const diff = back.diff(state.block);
    const ok = diff.length === 0;
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
  return node.startByte >= 6 && node.startByte <= 10;
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
  const chosenIdx = new Set(chosen.map((n) => n._idx));
  state.aligning = true;
  const total = chosen.length;
  const failed = [];
  try {
    const nodes = [...document.querySelectorAll('.node')].filter((el) => chosenIdx.has(Number(el.dataset.idx)));
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
        await stageWait(240);
      }
    }
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
      ctrl.innerHTML = `<select id="imValue">${spec.options.map((o, i) =>
        `<option value="${i}">${t(o.label) || o.label}</option>`).join('')}</select>`;
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
async function runCommandString(cmdStr) {
  const sent = [];
  for (const part of cmdStr.split(',')) {
    const raw = hexToBytes(part.trim());
    if (raw.length < 2) continue;
    const len = raw[0];
    if (len > 7) continue;          // 多帧模板由专用流程处理
    const payload = raw.slice(1, 1 + len);
    await state.link.request(payload);
    sent.push(Array.from(payload).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
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
      if (!(await ensureConnected())) return;
      const mName = modLabel(item.module);
      const bOld = b.textContent;
      try {
        // 分段：连接模块中 → 已连接 → 执行中 → 完成（教程 §6 字面）
        stage(`连接模块中：${mName}（${item.module}）…`);
        await stageWait(520);

        const sent = await state.session.runOn(item.module, async () => {
          stage(`已连接 ${mName}（地址 0x${(state.cables.modules[item.module] || {}).tx || '??'}）`);
          await stageWait(460);

          b.disabled = true;
          b.textContent = '执行中…';
          stage(`执行中：${t(item.name)}…`);
          try {
            if (item.kind === '执行器') {
              const ok = confirm(`执行器测试安全须知\n\n「${t(item.name)}」会驱动真实执行器动作。\n请先按安全规范断开相关执行器并接入模拟电阻。\n\n确认已按规范操作并继续？`);
              if (!ok) return null;
            }
            let picked = null;
            if (item.needsUserInput || item.input) {
              picked = await askInput(item);
              if (picked === null) return null;
            }
            // 分步工作流：逐步下发并汇报（如「恢复保养提醒」）
            if (item.workflow) {
              const out = [];
              for (const st of item.workflow) {
                stage(`正在执行：${st.step}…`);
                let cmd = st.cmd;
                if (st.userValue === 'interval' && picked) {
                  const raw = Math.round(picked.value / 500);   // 单位 500km/步
                  cmd = cmd.slice(0, -2) + raw.toString(16).toUpperCase().padStart(2, '0');
                }
                await runCommandString(cmd);
                out.push(`${st.step}（${cmd}）`);
                await stageWait(360);
              }
              return out;
            }
            return await runCommandString(item.commands);
          } finally {
            b.disabled = false;
            b.textContent = bOld;
          }
        });

        if (!sent) { stageDone('已取消'); return; }
        stageDone(`完成：${t(item.name)}（下发 ${sent.length} 帧）`);
        const valLine = (typeof picked === 'object' && picked) ? `\n设定值：${picked.label}` : '';
        alert(`执行完成\n\n项目：${t(item.name)}\n模块：${m2label(item.module)}${valLine}\n下发帧：\n${sent.join('\n') || '（无）'}`);
      } catch (e) {
        stageFail(`失败：${e.message}`);
        alert('执行失败：' + e.message + (e.nrcText ? '（' + e.nrcText + '）' : ''));
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

/** 手动连接指定模块（像 MES：选模块→连接） */
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
          (state.i18n.statusLegend && state.i18n.statusLegend[f.status]) || f.status
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
        </div>`;
      }).join('');
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

/* ================= 实时数据 ================= */
const live = { running: false, samples: [], lastItems: [] };

function applyScale(raw, item) {
  if (!raw || !raw.length) return null;
  const spec = item.spec || {};
  const nb = spec.bytes || 1;
  let n = 0;
  for (let i = 0; i < Math.min(raw.length, nb); i++) n |= raw[i] << (8 * i);
  if (spec.scale !== undefined) n = n * spec.scale + (spec.offset || 0);
  return spec.decimals !== undefined ? Number(n.toFixed(spec.decimals)) : n;
}

function renderLive(items) {
  live.lastItems = items;
  $('liveChart').innerHTML = items.map((it, i) => {
    const last = live.samples.length ? live.samples[live.samples.length - 1].v[i] : '—';
    return `<div style="margin:6px 0"><span style="color:var(--dim)">${it.name}</span>　<span class="live-val">${last ?? '—'}</span><span style="color:var(--dim)"> ${it.spec && it.spec.unit ? it.spec.unit : ''}</span></div>`;
  }).join('');
}

function renderLiveParams() {
  const code = $('liveModule').value;
  const wrap = $('liveParams');
  if (!code) { wrap.innerHTML = ''; return; }
  const items = (state.params && state.params.modules && state.params.modules[code]) || [];
  state.liveItems = items;
  $('liveCount').textContent = items.length;
  wrap.innerHTML = items.slice(0, 150).map((i, idx) => `
    <div class="mrow">
      <input type="checkbox" class="live-pick" data-idx="${idx}" style="accent-color:var(--accent)">
      <div class="grow">
        <div class="name">${tSpan(i.name)}</div>
        <div class="sub">DID ${i.did} · ${i.spec && i.spec.unit ? '单位 ' + i.spec.unit + ' · ' : ''}${i.spec && i.spec.scale && i.spec.scale !== 1 ? '换算 ×' + i.spec.scale : ''}</div>
      </div>
    </div>`).join('') || '<div class="dim" style="padding:14px">该模块无可读参数</div>';
}
$('liveModule') && $('liveModule').addEventListener('change', renderLiveParams);

$('btnLiveStart').addEventListener('click', async () => {
  const code = $('liveModule').value;
  if (!code) return alert('请先选择模块');
  const chosen = [...document.querySelectorAll('.live-pick:checked')].map((el) => el.dataset.idx);
  if (!chosen.length) return alert('请先勾选要监控的参数（最多 8 项）');
  if (chosen.length > 8) return alert('最多同时监控 8 项参数');
  if (!(await ensureConnected())) return;
  const items = chosen.map((i) => state.liveItems[Number(i)]);
  live.running = true;
  live.samples = [];
  try {
    await state.session.runOn(code, async () => {
      stage(`正在读取实时数据（${items.length} 项）…`);
      const t0 = Date.now();
      let n = 0;
      while (live.running) {
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
        await new Promise((r) => setTimeout(r, 900));
      }
    });
    stageDone(`实时数据结束，共 ${live.samples.length} 个采样点`);
  } catch (e) {
    stageFail('实时读取失败：' + e.message);
    live.running = false;
  }
});

$('btnLiveStop').addEventListener('click', () => {
  live.running = false;
  log('已停止实时读取');
});

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
  const [f, m, ns, fn, cables, i18n, i18nDesc, ifaceData, dtc, params] = await Promise.all([
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
  ]);
  Object.assign(state, { features: f, modules: m, named: ns, funcs: fn, cables, i18n, i18nDesc, ifaces: ifaceData.interfaces, dtc, params });
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
