import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8850');
let id = 0; const pending = new Map();
const call = (op, extra = {}) => Promise.race([
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, op, ...extra })); }),
  new Promise((r) => setTimeout(() => r({ ok: false, error: '(本地超时)' }), 8000)),
]);
ws.on('message', (m) => { const o = JSON.parse(m.toString()); if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); } });
ws.on('open', async () => {
  const r = await call('listPorts');
  console.log('枚举到的全部串口:');
  (r.ports || []).forEach((p) => console.log('   ', p.path));
  // 直接打开 /dev/ttys000（软链的真实目标）
  for (const cand of ['/tmp/elm-sim', '/dev/ttys000']) {
    const o = await call('open', { port: cand, baud: 38400 });
    console.log(`\nopen ${cand} →`, o.ok, '|', o.error || '');
    if (o.ok) {
      await call('writeText', { text: 'ATI\r' });
      await new Promise((r) => setTimeout(r, 400));
      await call('writeText', { text: 'ATZ\r' });
      await new Promise((r) => setTimeout(r, 400));
      break;
    }
  }
  await call('close');
  ws.close(); process.exit(0);
});
ws.on('error', (e) => { console.log('连接失败:', e.message); process.exit(1); });
