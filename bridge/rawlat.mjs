import { SerialPort } from 'serialport';
const sp = new SerialPort({ path: '/tmp/elm-sim', baudRate: 38400, autoOpen: false });
await new Promise((res, rej) => sp.open((e) => (e ? rej(e) : res())));
console.log('已打开，isOpen =', sp.isOpen);
let n = 0; let t0 = Date.now();
sp.on('data', (b) => { n++; console.log('  收到 #' + n, (Date.now() - t0) + 'ms', JSON.stringify(b.toString())); });
for (let i = 1; i <= 3; i++) {
  t0 = Date.now();
  sp.write(Buffer.from('ATI\r', 'latin1'), (e) => { if (e) console.log('写失败', e.message); });
  await new Promise((r) => setTimeout(r, 1500));
}
console.log('共收到', n, '包（发 3 条）');
sp.close(); process.exit(0);
