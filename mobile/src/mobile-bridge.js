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
   * @param {{deviceId:string, service:string, tx:string, rx:string}} opts
   *   tx=写入特征（write/writeWithoutResponse），rx=通知特征（notify）；
   *   UUID 可配（廉价 ELM327 BLE 多为 HM-10/FFF0 与 Nordic UART 并存）
   */
  constructor(opts) {
    this.opts = opts;
    this.onDataCb = null; this.onClosedCb = null; this.onErrorCb = null;
  }

  async connect() {
    await BleClient.initialize();
    await BleClient.connect({ deviceId: this.opts.deviceId, timeout: 10000 }, () => {
      // TODO(真机): 断线回调验证
      this.onClosedCb && this.onClosedCb();
    });
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

/* ================= SPP（Android 经典蓝牙） [待真机验证] ================= */
class MobileSppPort {
  constructor(opts) {
    this.opts = opts;              // { address, name }
    this.onDataCb = null; this.onClosedCb = null; this.onErrorCb = null;
  }

  async connect() {
    await BluetoothSerial.connect({ address: this.opts.address });
    // TODO(真机): 确认订阅 API 的事件名与数据形态（ArrayBuffer/string）
    await BluetoothSerial.subscribe((data) => {
      const bytes = typeof data === 'string' ? strToBytes(data) : new Uint8Array(data);
      this.onDataCb && this.onDataCb(bytes);
    });
    return this;
  }

  write(data) {
    const bytes = typeof data === 'string' ? strToBytes(data) : Uint8Array.from(data);
    BluetoothSerial.write({ address: this.opts.address, bytes: bytes.buffer })
      .catch((e) => this.onErrorCb && this.onErrorCb('SPP 写失败: ' + e.message));
  }

  on(event, cb) {
    if (event === 'data') this.onDataCb = cb;
    else if (event === 'closed') this.onClosedCb = cb;
    else if (event === 'error') this.onErrorCb = cb;
    return this;
  }

  async close() {
    try { await BluetoothSerial.disconnect({ address: this.opts.address }); } catch {}
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
   *  - 'ble:<deviceId>:<service>:<tx>:<rx>' → BLE 串口透传
   *  - 'spp:<address>'                      → Android 经典蓝牙 SPP
   */
  async open(deviceId, _baud) {
    await this.close();
    let p;
    if (deviceId.startsWith('ble:')) {
      const [, dev, service, tx, rx] = deviceId.split(':');
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

  /** 蓝牙设备清单（供「扫描」按钮）；TCP 场景返回空 */
  async listPorts() {
    // TODO(真机): BLE 扫描 + SPP 已配对列表合并；模拟器无蓝牙返回空
    return [];
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
