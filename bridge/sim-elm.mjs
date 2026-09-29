/**
 * 虚拟 ELM327：在 pty 上模拟一台 ELM327 适配器，用于离车自测串口全链路。
 * 读写用同步轮询，消除流缓冲带来的时序不确定性。
 */
import { spawn } from 'child_process';
import fs from 'fs';

const socat = spawn('socat', [
  'PTY,link=/tmp/elm-sim,raw,echo=0',
  'PTY,link=/tmp/elm-sim-peer,raw,echo=0',
], { stdio: 'ignore' });

for (let i = 0; i < 50 && !fs.existsSync('/tmp/elm-sim'); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
if (!fs.existsSync('/tmp/elm-sim')) {
  console.error('socat 创建 pty 失败，请确认已安装 socat');
  process.exit(1);
}

const fd = fs.openSync('/tmp/elm-sim-peer', 'r+');
const buf = Buffer.alloc(4096);
let pending = '';

function respond(cmd) {
  const up = cmd.toUpperCase().trim();
  let resp;
  if (up === 'ATZ') resp = '\r\rELM327 v1.5\r\r>';
  else if (up === 'ATI') resp = 'ELM327 v1.5\r>';
  else if (up.startsWith('AT')) resp = 'OK\r>';
  else if (/^\d/.test(up)) resp = '41 00 BE 3E B8 11 8A\r>';
  else resp = '?\r>';
  console.log('[sim-elm] <=', JSON.stringify(cmd), '=>', JSON.stringify(resp.slice(0, 20)));
  try { fs.writeSync(fd, Buffer.from(resp, 'latin1')); } catch (e) { console.log('[sim-elm] 写回失败', e.message); }
}

console.log('[sim-elm] 虚拟 ELM327 已就绪 → /tmp/elm-sim');

// 同步轮询读，保证应答即时
for (;;) {
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, buf.length); } catch { n = 0; }
  if (n > 0) {
    pending += buf.toString('latin1', 0, n);
    let idx;
    while ((idx = pending.search(/[\r\n>]/)) >= 0) {
      const cmd = pending.slice(0, idx).trim();
      pending = pending.slice(idx + 1);
      if (cmd) respond(cmd);
    }
  } else {
    await new Promise((r) => setTimeout(r, 5));
  }
}
