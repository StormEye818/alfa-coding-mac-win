/**
 * 测试沙箱地基：把一辆「模拟 Giulia」以虚拟 vLinker MS 的形式提供给工具。
 *
 *   工具（选 vLinker MS / WiFi 测试入口） ──串口桥 tcpOpen──> 本文件 TCP :35001
 *                                                                 │
 *                                                    ELM327/ISO-TP 收发
 *                                                                 │
 *                                                    ECU 模型（giulia-car.mjs）
 *
 * 职责：
 *   1) 模拟一台 vLinker MS（应答 AT 指令）
 *   2) 按 ATSH/ATCRA 的 29 位地址把 UDS 帧路由到对应 ECU
 *   3) 处理 ISO-TP 单帧/多帧（含流控）
 *   4) 把 ECU 应答封装回 ISO-TP 发给工具
 *
 * 传输说明：走 TCP 而不是 pty。macOS 上 socat PTY↔PTY 中继会把小应答
 * 攒批、不定时迟到（实测最多滞后 8 秒），导致工具端超时；TCP 回环没有
 * 这个问题。工具侧经由串口桥的 tcpOpen（界面选 WiFi 类接口填 127.0.0.1:35001）。
 */
import net from 'net';
import { GiuliaCar } from './giulia-car.mjs';

const car = new GiuliaCar({ log: (m) => console.log('[car]  ' + m) });
const PORT = Number(process.env.SANDBOX_PORT || 35001);

function makeConn(sock) {
  const st = {
    target: 0x40, tester: 0xF1,   // 默认车身电脑（0x40）
    rxPending: null,               // ISO-TP 上行重组
    pending: '',
  };

  function send(text) {
    if (sock.destroyed) return;
    try { sock.write(Buffer.from(text, 'latin1')); } catch {}
  }
  function sendHex(bytes) {
    // 行分隔符用 \r\n：src/elm327.js 的 cleanLines 按 \n 分行（只删 \r），
    // 裸 \r 会把所有帧拼成一行导致 ISO-TP 重组失败
    send(Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('') + '\r\n');
  }

  /** 把 UDS 应答按 ISO-TP 分帧发回 */
  function replyIsoTp(payload) {
    const id = (0x18DA0000 | (st.tester << 8) | st.target).toString(16).toUpperCase().padStart(8, '0');
    const h = (b) => b.toString(16).toUpperCase().padStart(2, '0');
    if (payload.length <= 7) {
      send(id + h(payload.length) + Array.from(payload).map(h).join('') + '\r\n');
      return;
    }
    const total = payload.length;
    send(id + h(0x10 | ((total >> 8) & 0x0f)) + h(total & 0xff) + Array.from(payload.slice(0, 6)).map(h).join('') + '\r\n');
    // 先给流控
    send(id + h(0x30) + '00' + '00' + '\r\n');
    let idx = 1, off = 6;
    while (off < total) {
      send(id + h(0x20 | (idx & 0x0f)) + Array.from(payload.slice(off, off + 7)).map(h).join('') + '\r\n');
      off += 7; idx = (idx + 1) & 0x0f;
    }
  }

  function handleAt(cmd) {
    const up = cmd.toUpperCase().trim();
    if (up === 'ATZ') return '\r\rVLinker MS v1.0\r\r>';
    if (up === 'ATI') return 'VLinker MS v1.0\r>';
    if (up.startsWith('ATSH')) {
      // ATSH 携带完整 29 位 ID（18DA<TX><RX>），目标 ECU 是 TX 字节（bit8..15）；
      // 取 `& 0xff` 会拿到 RX（0xF1），导致所有请求被路由到不存在的地址
      const hexPart = up.slice(4).replace(/[^0-9A-F]/g, '');
      const id = parseInt(hexPart, 16) || 0;
      st.target = hexPart.length >= 6 ? (id >> 8) & 0xff : id & 0xff;
      return 'OK\r>';
    }
    if (up.startsWith('ATCRA')) return 'OK\r>';
    if (up.startsWith('AT')) return 'OK\r>';
    return 'OK\r>';
  }

  /** 处理收到的 ISO-TP 帧（工具侧，含 PCI） */
  function handleFrame(hex) {
    const bytes = hex.match(/../g).map((x) => parseInt(x, 16));
    const pci = bytes[0];
    const type = pci >> 4;
    const h = (b) => b.toString(16).toUpperCase().padStart(2, '0');
    const id = (0x18DA0000 | (st.tester << 8) | st.target).toString(16).toUpperCase().padStart(8, '0');
    if (type === 0x0) {
      const len = pci & 0x0f;
      const payload = bytes.slice(1, 1 + len);
      dispatch(payload);
      send('>');                      // 数据应答也要以 '>' 结束，工具端按提示符收包
    } else if (type === 0x1) {
      const total = ((pci & 0x0f) << 8) | bytes[1];
      st.rxPending = { total, chunks: bytes.slice(2), got: bytes.length - 2 };
      // 首帧要回流控帧（0x30 00 00），否则工具端多帧发送会等流控直到超时
      send(id + h(0x30) + '00' + '00' + '\r\n>');
    } else if (type === 0x2 && st.rxPending) {
      st.rxPending.chunks.push(...bytes.slice(1));
      st.rxPending.got += bytes.length - 1;
      if (st.rxPending.got >= st.rxPending.total) {
        const payload = st.rxPending.chunks.slice(0, st.rxPending.total);
        st.rxPending = null;
        dispatch(payload);
      }
      send('>');                      // 连续帧同样以 '>' 结束
    }
  }

  function dispatch(payload) {
    const ecu = car.ecuByAddress(st.target);
    if (!ecu) { replyIsoTp([0x7f, payload[0], 0x11]); return; }
    const resp = car.handle(ecu, payload);
    if (resp && resp.length) replyIsoTp(resp);
  }

  return function onChunk(buf) {
    st.pending += buf.toString('latin1');
    let idx;
    while ((idx = st.pending.search(/[\r\n>]/)) >= 0) {
      const cmd = st.pending.slice(0, idx).trim();
      st.pending = st.pending.slice(idx + 1);
      if (!cmd) continue;
      const up = cmd.toUpperCase();
      console.log('[TS] 收到 ' + JSON.stringify(cmd));
      if (up.startsWith('AT')) send(handleAt(cmd));
      else if (/^[0-9A-Fa-f]+$/.test(cmd)) handleFrame(cmd);
      else send('?\r>');
    }
  };
}

const server = net.createServer((sock) => {
  console.log('[sandbox] 工具已接入 ' + sock.remoteAddress + ':' + sock.remotePort);
  sock.on('data', makeConn(sock));
  sock.on('error', () => {});
  sock.on('close', () => console.log('[sandbox] 工具断开'));
});

// SANDBOX_HOST：默认只听本机；Android 模拟器需 SANDBOX_HOST=0.0.0.0（经 10.0.2.2 访问）
server.listen(PORT, process.env.SANDBOX_HOST || '127.0.0.1', () => {
  console.log('[sandbox] 模拟 Giulia 已就绪');
  console.log('[sandbox] 连接方式: TCP 127.0.0.1:' + PORT);
  console.log('[sandbox] 工具里选「Vgate vLinker MS（沙箱）」+ 地址 127.0.0.1:' + PORT);
});
