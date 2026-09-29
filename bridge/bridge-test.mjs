import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8850');
let id = 0; const pending = new Map();
const call = (op, extra = {}) => Promise.race([
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, op, ...extra })); }),
  new Promise((r) => setTimeout(() => r({ ok: false, error: '(本地超时)' }), 6000)),
]);
ws.on('message', (m) => {
  const o = JSON.parse(m.toString());
  if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); }
  else console.log('  事件:', JSON.stringify(o).slice(0, 80));
});
ws.on('open', async () => {
  let r = await call('listPorts');
  console.log('listPorts →', r.ok, '| 端口数', r.ports ? r.ports.length : 0);
  (r.ports || []).forEach((p) => console.log('   ', p.path));
  r = await call('open', { port: '/dev/null', baud: 38400 });
  console.log('open 无效端口 →', r.ok, '|', r.error || '');
  r = await call('write', { data: '41545A' });
  console.log('write 未连接 →', r.ok, '|', r.error || '');
  r = await call('tcpOpen', { host: '127.0.0.1', port: 9, timeout: 1500 });
  console.log('tcpOpen 不通 →', r.ok, '|', r.error || '');
  r = await call('close');
  console.log('close →', r.ok);
  ws.close(); process.exit(0);
});
ws.on('error', (e) => { console.log('连接失败:', e.message); process.exit(1); });
