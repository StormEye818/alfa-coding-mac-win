/**
 * 移动端传输层（Capacitor）：
 *   MobileBridge  —— 复刻 src/serial/bridge-client.js 的公开形状，
 *                     使 app.js 的接线与 InterfaceTester 零改动复用
 *   MobileTcpPort —— WiFi 适配器 TCP 直连（@deedarb/capacitor-tcp-socket，base64 in/out）
 *   MobileBlePort —— BLE 串口透传（@capacitor-community/bluetooth-le）  [待真机]
 *   MobileSppPort —— Android 经典蓝牙 SPP（@ascentio-it/capacitor-bluetooth-serial） [待真机]
 *
 * PortLike 契约（src/elm327.js:34-38）：write(data) + on('data')。
 * Elm327 按 '>' 提示符流式切分应答，因此 BLE MTU 分片 / TCP 分包都无影响。
 */
import { TcpSocket } from '@deedarb/capacitor-tcp-socket';
import { BleClient, dataViewToHexString, hexStringToDataView } from '@capacitor-community/bluetooth-le';
import { BluetoothSerial } from '@ascentio-it/capacitor-bluetooth-serial';
import { registerPlugin, Capacitor } from '@capacitor/core';

// iOS MFi External Accessory 通道（vLinker MS 等 MFi 认证适配器，见 ios/App/App/MfiSerialPlugin.swift）
// 注意：ExternalAccessory 是 iOS 专有框架——Android/桌面无 MFi，仅 iOS 注册与调用
const MfiSerial = Capacitor.getPlatform() === 'ios' ? registerPlugin('MfiSerial') : null;

const log = (...a) => console.log('[mobile-bridge]', ...a);

/** 字符串→Uint8Array（latin1，ELM327 命令与 hex 字符都是 ASCII） */
function strToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const hexToBytes = (hex) => {
  const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
};
const bytesToHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/* ================= TCP（WiFi 适配器） ================= */
class MobileTcpPort {
  constructor() {
    this.client = null;
    this.onDataCb = null;
    this.onClosedCb = null;
    this.onErrorCb = null;
    this.reading = false;
    this.closed = false;
  }

  async connect(host, port, timeoutSec = 4) {
    const r = await TcpSocket.connect({ ipAddress: host, port, timeout: timeoutSec });
    this.client = r.client;
    log('TCP 已连接', host + ':' + port, 'client=' + this.client);
    this.reading = true;
    this.#readLoop();
    return this;
  }

  /** PortLike: write(string|Uint8Array) */
  write(data) {
    if (this.client === null || this.closed) return;
    const bytes = typeof data === 'string' ? strToBytes(data) : Uint8Array.from(data);
    TcpSocket.send({ client: this.client, data: bytesToBase64(bytes) })
      .catch((e) => this.onErrorCb && this.onErrorCb('TCP 发送失败: ' + e.message));
  }

  on(event, cb) {
    if (event === 'data') this.onDataCb = cb;
    else if (event === 'closed') this.onClosedCb = cb;
    else if (event === 'error') this.onErrorCb = cb;
    return this;
  }

  async close() {
    this.reading = false;
    if (this.client !== null && !this.closed) {
      this.closed = true;
      try { await TcpSocket.disconnect({ client: this.client }); } catch {}
      this.client = null;
    }
  }

  async #readLoop() {
    // 轮询式 read（插件为 base64 pull 模型）：timeout 1s 阻塞式拉取，到达即推给 Elm327
    while (this.reading && this.client !== null) {
      try {
        const r = await TcpSocket.read({ client: this.client, expectLen: 4096, timeout: 1 });
        if (r && r.result && r.result.length) {
          const bytes = base64ToBytes(r.result);
          if (this.onDataCb) this.onDataCb(bytes);
        }
      } catch (e) {
        if (!this.closed) {
          log('TCP 读循环结束:', e.message);
          this.closed = true;
          this.reading = false;
          if (this.onClosedCb) this.onClosedCb();
        }
        return;
      }
    }
  }
}

/* ================= BLE（iOS/Android） [待真机验证] ================= */
class MobileBlePort {
  /**
   * @param {{deviceId:string, service?:string, tx?:string, rx?:string}} opts
   *   tx/rx 可不给：连接后自动发现（找可写特征 + 可通知特征，适配 HM-10/FFF0、
   *   Nordic UART 及各类 ELM327 BLE 克隆）。显式 UUID 仍然优先。
   */
  constructor(opts) {
    this.opts = opts;
    this.onDataCb = null; this.onClosedCb = null; this.onErrorCb = null;
  }

  async connect() {
    await BleClient.initialize();
    await BleClient.connect({ deviceId: this.opts.deviceId, timeout: 10000 }, () => {
      this.onClosedCb && this.onClosedCb();
    });
    // 自动发现服务/特征（未显式指定 UUID 时）
    let { service, tx, rx } = this.opts;
    if (!tx || !rx) {
      const services = await BleClient.getServices({ deviceId: this.opts.deviceId });
      for (const s of services) {
        for (const c of (s.characteristics || [])) {
          const props = c.properties || {};
          if (!tx && (props.write || props.writeWithoutResponse)) {
            tx = c.uuid; service = s.uuid;
          }
          if (!rx && props.notify) {
            rx = c.uuid;
            if (!service) service = s.uuid;
            // 优先同服务的可写+可通知组合（ELM327 BLE 惯例）
            if (tx && service === s.uuid) break;
          }
        }
      }
      if (!tx || !rx) throw new Error('BLE 设备无可写/可通知特征（发现到 ' + services.length + ' 个服务）');
      this.opts = { deviceId: this.opts.deviceId, service, tx, rx };
    }
    // 收流：rx 特征 notify
    await BleClient.startNotifications(
      { deviceId: this.opts.deviceId, service: this.opts.service, characteristic: this.opts.rx },
      (v) => this.onDataCb && this.onDataCb(Uint8Array.from(v.buffer ? new Uint8Array(v.buffer) : [])),
    );
    return this;
  }

  write(data) {
    const bytes = typeof data === 'string' ? strToBytes(data) : Uint8Array.from(data);
    // MTU 分片（写无响应窗口）；Elm327 流式解析，分片无影响
    const MTU = 20;
    for (let i = 0; i < bytes.length; i += MTU) {
      const chunk = bytes.slice(i, i + MTU);
      BleClient.writeWithoutResponse({
        deviceId: this.opts.deviceId,
        service: this.opts.service,
        characteristic: this.opts.tx,
        value: hexStringToDataView(bytesToHex(chunk)),
      }).catch((e) => this.onErrorCb && this.onErrorCb('BLE 写失败: ' + e.message));
    }
  }

  on(event, cb) {
    if (event === 'data') this.onDataCb = cb;
    else if (event === 'closed') this.onClosedCb = cb;
    else if (event === 'error') this.onErrorCb = cb;
    return this;
  }

  async close() {
    try { await BleClient.stopNotifications({ deviceId: this.opts.deviceId, service: this.opts.service, characteristic: this.opts.rx }); } catch {}
    try { await BleClient.disconnect({ deviceId: this.opts.deviceId }); } catch {}
  }
}

/* ================= SPP（Android 经典蓝牙） ================= */
class MobileSppPort {
  constructor(opts) {
    this.opts = opts;              // { address, name }
    this.onDataCb = null; this.onClosedCb = null; this.onErrorCb = null;
    this.reading = false; this.closed = false;
  }

  async connect() {
    await BluetoothSerial.checkBluetoothPermissions();
    await BluetoothSerial.connect({ address: this.opts.address });
    this.reading = true;
    this.#readLoop();
    return this;
  }

  write(data) {
    const bytes = typeof data === 'string' ? strToBytes(data) : Uint8Array.from(data);
    // 插件 write 收 latin1 字符串（不是 buffer）
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    BluetoothSerial.write({ address: this.opts.address, value: s })
      .catch((e) => this.onErrorCb && this.onErrorCb('SPP 写失败: ' + e.message));
  }

  on(event, cb) {
    if (event === 'data') this.onDataCb = cb;
    else if (event === 'closed') this.onClosedCb = cb;
    else if (event === 'error') this.onErrorCb = cb;
    return this;
  }

  async close() {
    this.reading = false;
    if (!this.closed) {
      this.closed = true;
      try { await BluetoothSerial.disconnect({ address: this.opts.address }); } catch {}
    }
  }

  async #readLoop() {
    // 轮询 read（返回 {value: latin1 字符串}），到达即推——与 TCP/MFi 读循环同构
    while (this.reading && !this.closed) {
      try {
        const r = await BluetoothSerial.read({ address: this.opts.address });
        if (r && r.value && r.value.length) {
          if (this.onDataCb) this.onDataCb(strToBytes(r.value));
        } else {
          await new Promise((res) => setTimeout(res, 30));
        }
      } catch (e) {
        if (!this.closed) {
          this.closed = true;
          this.reading = false;
          log('SPP 读循环结束:', (e && e.message) || e);
          if (this.onClosedCb) this.onClosedCb();
        }
        return;
      }
    }
  }
}

/* ================= MFi External Accessory（iOS） ================= */
class MfiPort {
  constructor(opts) {
    this.opts = opts;              // { connectionId, protocol?, name? }
    this.onDataCb = null; this.onClosedCb = null; this.onErrorCb = null;
    this.subs = [];                // 监听句柄，close 时注销
    this.closed = false;
  }

  async connect() {
    // 监听器只注册一次——泄漏会导致每个应答被投递 N 次（实车日志：OK>OK> 应答风暴）
    if (this.subs.length === 0) {
      const s1 = await MfiSerial.addListener('data', (ev) => {
        const bytes = base64ToBytes(ev.data || '');
        if (bytes.length && this.onDataCb) this.onDataCb(bytes);
      });
      const s2 = await MfiSerial.addListener('closed', () => {
        if (!this.closed && this.onClosedCb) this.onClosedCb();
      });
      this.subs.push(s1, s2);
    }
    await MfiSerial.open({ connectionId: this.opts.connectionId, protocol: this.opts.protocol || null });
    return this;
  }

  write(data) {
    const bytes = typeof data === 'string' ? strToBytes(data) : Uint8Array.from(data);
    MfiSerial.write({ data: bytesToBase64(bytes) })
      .catch((e) => this.onErrorCb && this.onErrorCb('MFi 写失败: ' + e.message));
  }

  on(event, cb) {
    if (event === 'data') this.onDataCb = cb;
    else if (event === 'closed') this.onClosedCb = cb;
    else if (event === 'error') this.onErrorCb = cb;
    return this;
  }

  async close() {
    this.closed = true;
    // 先注销监听（防止幽灵监听器继续投递），再关会话
    for (const s of this.subs) {
      try { await s.remove(); } catch {}
    }
    this.subs = [];
    try { await MfiSerial.close(); } catch {}
  }
}

/* ================= MobileBridge（BridgeClient 同形） ================= */
class MobileBridge {
  constructor() {
    this.onData = null;      // (hex: string) => void   —— BridgeClient 约定
    this.onClosed = null;
    this.onError = null;
    this.port = null;
  }

  /** no-op：连接在 tcpOpen/open 内完成 */
  async connect() { return this; }

  /** WiFi 适配器：TCP 直连 */
  async tcpOpen(host, port) {
    await this.close();
    const p = new MobileTcpPort();
    p.on('data', (bytes) => this.onData && this.onData(bytesToHex(bytes)));
    p.on('closed', () => this.onClosed && this.onClosed());
    p.on('error', (m) => this.onError && this.onError(m));
    this.port = await p.connect(host, port);
    log('tcpOpen 完成');
    return { ok: true, host, port };
  }

  /**
   * 无线蓝牙设备：
   *  - 'ble:<deviceId>[|<service>|<tx>|<rx>]' → BLE 串口透传（UUID 不给则自动发现；
   *    注意 deviceId 可能含冒号（安卓 MAC），所以附加段用 | 分隔）
   *  - 'spp:<address>'                      → Android 经典蓝牙 SPP
   */
  async open(deviceId, _baud) {
    await this.close();
    let p;
    if (deviceId.startsWith('ea:')) {
      // 'ea:<connectionId>[|<protocol>]' —— iOS MFi External Accessory
      const [connId, protocol] = deviceId.slice(3).split('|');
      p = new MfiPort({ connectionId: Number(connId), protocol: protocol || null });
    } else if (deviceId.startsWith('ble:')) {
      const [dev, service, tx, rx] = deviceId.slice(4).split('|');
      p = new MobileBlePort({ deviceId: dev, service, tx, rx });
    } else if (deviceId.startsWith('spp:')) {
      p = new MobileSppPort({ address: deviceId.slice(4) });
    } else {
      throw new Error('未知设备标识: ' + deviceId);
    }
    p.on('data', (bytes) => this.onData && this.onData(bytesToHex(bytes)));
    p.on('closed', () => this.onClosed && this.onClosed());
    p.on('error', (m) => this.onError && this.onError(m));
    this.port = await p.connect();
    log('open 完成', deviceId.slice(0, 12));
    return { ok: true };
  }

  /**
   * 蓝牙设备清单（供串口下拉与「扫描接口」按钮）：
   *   - SPP（Android）：已配对设备 → 'spp:<address>'
   *   - BLE（iOS/Android）：广播扫描 4 秒 → 'ble:<deviceId>'（服务/特征连接时自动发现）
   * 列表做过滤与排序：OBD 类设备置顶（★），其余按信号强度从强到弱；
   * 弱信号且无名的信标/外设直接滤掉（真机反馈：周围设备太多名字太乱）。
   */
  async listPorts() {
    const out = [];
    const OBD = /vlinker|vl-?link|elm|obd|vgate|veepeak|obdlink|carista|autel|thinkdiag|carplay|mdi|golo|teltonika/i;
    // --- MFi External Accessory（仅 iOS）：系统已连接的 MFi 适配器，无需扫描，永远置顶 ---
    if (MfiSerial) try {
      const r = await MfiSerial.list();
      const devs = r.devices || [];
      globalThis.__apxLastScan = Object.assign(globalThis.__apxLastScan || {}, {
        mfi: { count: devs.length, error: null, names: devs.map((d) => d.name + '/' + (d.protocolStrings || []).join(',')) },
      });
      for (const d of devs) {
        out.push({
          path: 'ea:' + d.connectionId + (d.protocolStrings && d.protocolStrings.length ? '|' + d.protocolStrings[0] : ''),
          manufacturer: '★ ' + (d.name || 'MFi 配件'),
          friendly: d.name || '', vid: '', pid: '', serial: d.serial || '',
          rssi: -1,
        });
      }
    } catch (e) {
      globalThis.__apxLastScan = Object.assign(globalThis.__apxLastScan || {}, {
        mfi: { count: 0, error: String((e && e.message) || e), names: [] },
      });
    }
    // --- SPP 已配对（Android，永远置顶） ---
    try {
      await BluetoothSerial.checkBluetoothPermissions();
      const r = await BluetoothSerial.getPairedDevices();
      for (const d of (r.devices || [])) {
        const nm = d.name || d.address;
        out.push({ path: 'spp:' + d.address, manufacturer: (OBD.test(nm) ? '★ ' : '') + nm, friendly: nm, vid: '', pid: '', serial: d.address, rssi: -1 });
      }
    } catch { /* iOS / 无 SPP：忽略 */ }
    // --- BLE 扫描（双平台） ---
    try {
      await BleClient.initialize();
      const found = new Map();
      await BleClient.requestLEScan({ allowDuplicates: true }, (res) => {
        const d = res && res.device;
        if (!d || !d.deviceId) return;
        const prev = found.get(d.deviceId) || {};
        found.set(d.deviceId, {
          deviceId: d.deviceId,
          name: res.localName || d.name || prev.name || '',
          rssi: Math.max(res.rssi ?? -999, prev.rssi ?? -999),
        });
      });
      await new Promise((r) => setTimeout(r, 4000));
      await BleClient.stopLEScan().catch(() => {});
      const seen = new Set(out.map((x) => x.path));
      const cands = [];
      for (const d of found.values()) {
        const path = 'ble:' + d.deviceId;
        if (seen.has(path)) continue;
        // 过滤：有名设备全要；无名设备只留强信号（-70dBm 以内，近场才可能是目标适配器）
        if (!d.name && d.rssi < -70) continue;
        cands.push({ d, path, obd: OBD.test(d.name) });
      }
      // 排序：OBD 类优先，其次信号强的在前
      cands.sort((a, b) => (b.obd - a.obd) || (b.d.rssi - a.d.rssi));
      for (const c of cands.slice(0, 12)) {
        const label = (c.obd ? '★ ' : '') + (c.d.name || '未知设备');
        out.push({ path: c.path, manufacturer: label, friendly: c.d.name, vid: '', pid: '', serial: c.d.deviceId, rssi: c.d.rssi });
      }
      // 诊断信息（合并写入，勿整体覆盖——MFi 结果先前已写入）
      globalThis.__apxLastScan = Object.assign(globalThis.__apxLastScan || {}, { ok: true, raw: found.size, shown: cands.length, error: null });
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('BLE 扫描失败:', msg);
      globalThis.__apxLastScan = Object.assign(globalThis.__apxLastScan || {}, { ok: false, raw: 0, shown: 0, error: msg });
    }
    log('listPorts →', out.length, '个蓝牙设备');
    return out;
  }

  /** 无线适配器无主机侧波特率概念 */
  async setBaud() { return { ok: true }; }

  writeHex(hex) {
    if (!this.port) return Promise.reject(new Error('未连接'));
    this.port.write(hexToBytes(hex));
    return Promise.resolve({ ok: true });
  }

  writeText(text) {
    if (!this.port) return Promise.reject(new Error('未连接'));
    this.port.write(text);
    return Promise.resolve({ ok: true });
  }

  async close() {
    if (this.port) {
      const p = this.port; this.port = null;
      await p.close().catch(() => {});
    }
    return { ok: true };
  }
}

export { MobileBridge, MobileTcpPort, MobileBlePort, MobileSppPort };
