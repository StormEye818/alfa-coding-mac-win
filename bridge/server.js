/**
 * 串口 / TCP 桥接服务。
 *
 * 浏览器无法直接访问串口与 TCP，这里提供一个本地桥：
 *   · 枚举串口（含 USB / 蓝牙 SPP 虚拟串口）
 *   · 打开/关闭串口，设置波特率，收发原始字节
 *   · TCP 连接（WiFi 型接口按 IP:端口 连接）
 *
 * 界面通过 WebSocket 调用，协议（JSON）：
 *   → {"id":1,"op":"listPorts"}
 *   → {"id":2,"op":"open","port":"/dev/ttyUSB0","baud":38400}
 *   → {"id":3,"op":"tcpOpen","host":"192.168.0.10","port":35000}
 *   → {"id":4,"op":"write","data":"ATZ\r"}
 *   → {"id":5,"op":"close"}
 *   ← {"id":1,"ok":true,"ports":[...]}
 *   ← {"op":"data","hex":"41545A0D..."}     收到的原始字节（hex）
 */
import { WebSocketServer } from 'ws';
import net from 'net';
import { SerialPort } from 'serialport';

const PORT = Number(process.env.BRIDGE_PORT || 8850);
const wss = new WebSocketServer({ port: PORT });

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function listPorts() {
  try {
    const list = await SerialPort.list();
    return list.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      friendly: p.friendlyName || '',
      vid: p.vendorId || '',
      pid: p.productId || '',
      serial: p.serialNumber || '',
    }));
  } catch (e) {
    return [];
  }
}

wss.on('connection', (ws) => {
  let sp = null;          // SerialPort 实例
  let sock = null;        // net.Socket 实例
  const closeAll = () => {
    // 注意：SerialPort.close() 在未打开时会抛异步 error 事件，必须先挂 error 处理 + 判 isOpen
    if (sp) {
      sp.removeAllListeners('error');
      sp.on('error', () => {});            // 吞掉关闭过程中的异步错误，避免进程崩溃
      try { if (sp.isOpen) sp.close(); } catch {}
    }
    if (sock) {
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      try { sock.destroy(); } catch {}
    }
    sp = sock = null;
  };

  ws.on('close', closeAll);
  ws.on('error', closeAll);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, op } = msg;
    try {
      switch (op) {
        case 'listPorts':
          return send(ws, { id, ok: true, ports: await listPorts() });

        case 'open': {
          closeAll();
          const p = new SerialPort({ path: msg.port, baudRate: msg.baud || 38400, autoOpen: false });
          p.on('error', (e) => send(ws, { op: 'error', message: e.message }));
          try {
            await new Promise((res, rej) => p.open((e) => (e ? rej(e) : res())));
          } catch (e) {
            try { p.close(); } catch {}
            sp = null;
            throw e;
          }
          sp = p;
          sp.on('data', (buf) => {
            console.log('[bridge] 桥转发', buf.length, '字节  t=', Date.now() % 100000);
            send(ws, { op: 'data', hex: Buffer.from(buf).toString('hex') });
          });
          sp.on('error', (e) => send(ws, { op: 'error', message: e.message }));
          sp.on('close', () => send(ws, { op: 'closed' }));
          return send(ws, { id, ok: true, port: msg.port, baud: msg.baud || 38400 });
        }

        case 'tcpOpen': {
          closeAll();
          sock = net.createConnection({ host: msg.host, port: msg.port });
          const to = setTimeout(() => {
            try { sock && sock.destroy(); } catch {}
            rej0(new Error('TCP 连接超时'));
          }, msg.timeout || 4000);
          let rej0 = null;
          await new Promise((res, rej) => {
            rej0 = rej;
            sock.once('connect', () => { clearTimeout(to); res(); });
            sock.once('error', (e) => { clearTimeout(to); rej(e); });
          });
          sock.on('data', (buf) => send(ws, { op: 'data', hex: Buffer.from(buf).toString('hex') }));
          sock.on('error', (e) => send(ws, { op: 'error', message: e.message }));
          sock.on('close', () => send(ws, { op: 'closed' }));
          return send(ws, { id, ok: true, host: msg.host, port: msg.port });
        }

        case 'write': {
          const buf = Buffer.from(String(msg.data || ''), 'hex');
          const target = sp || sock;
          if (!target) return send(ws, { id, ok: false, error: '未连接' });
          if (sp && !sp.isOpen) { sp = null; return send(ws, { id, ok: false, error: '串口未打开' }); }
          await new Promise((res, rej) => target.write(buf, (e) => (e ? rej(e) : res())));
          return send(ws, { id, ok: true, wrote: buf.length });
        }

        case 'writeText': {
          const target = sp || sock;
          if (!target) return send(ws, { id, ok: false, error: '未连接' });
          await new Promise((res, rej) => target.write(Buffer.from(msg.text || '', 'latin1'), (e) => (e ? rej(e) : res())));
          return send(ws, { id, ok: true });
        }

        case 'close':
          closeAll();
          return send(ws, { id, ok: true });

        case 'setBaud': {
          // 部分接口（如 ELM327 高速模式）运行中切波特率
          if (!sp) return send(ws, { id, ok: false, error: '未连接串口' });
          await new Promise((res, rej) => sp.update({ baudRate: msg.baud }, (e) => (e ? rej(e) : res())));
          return send(ws, { id, ok: true, baud: msg.baud });
        }

        default:
          return send(ws, { id, ok: false, error: '未知操作: ' + op });
      }
    } catch (e) {
      return send(ws, { id, ok: false, error: e.message });
    }
  });
});

console.log(`[bridge] 串口/TCP 桥已启动  ws://127.0.0.1:${PORT}`);
