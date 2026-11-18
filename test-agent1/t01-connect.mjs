/**
 * 测试 01：§二 连接 + §三 读取配置 + 基线状态（§九 反向验证前置）
 */
import { Tool } from '../sandbox/drive.mjs';
import { probeSnapshot } from './probe.mjs';

// 前置：bridge/server.js（ws :8850）与 sandbox/harness.mjs（模拟车 :35001）须在别处已启动；
// 本脚本不启动/清理它们。连接失败等异常一律 exit 1，并打印明确前置提示。
process.on('uncaughtException', (e) => {
    console.error('[test-agent1] 运行异常（若连接被拒，请先启动 node bridge/server.js 与 node sandbox/harness.mjs）：'
        + (e && e.message ? e.message : String(e)));
    process.exit(1);
});

let pass = 0, fail = 0;
const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const t = new Tool({ adapter: 'vlinker-ms', port: '127.0.0.1:35001', log: (m) => console.log('  · ' + m) });

console.log('--- §二 连接 ---');
const t0 = Date.now();
await t.connect();
const connectMs = Date.now() - t0;
check('连接车身电脑', '连接成功，bodyModule 为车身电脑', String(t.session.bodyModule) + ` (${connectMs}ms)`, String(t.session.bodyModule).includes('BODY'));

console.log('--- §三 自动读取配置 ---');
const t1 = Date.now();
const blk = await t.readConfig();
const readMs = Date.now() - t1;
check('自动读取车辆配置', '约 289 字节，CRC 自洽', `${blk.bytes.length} 字节，CRC ${blk.verify().ok ? '自洽' : '异常'} (${readMs}ms)`,
    blk.bytes.length === 289 && blk.verify().ok);

console.log('--- 基线：里程表闪烁真值（§九 反向验证）---');
const snap = await probeSnapshot(t, { verbose: true });
console.log('snapshot:', JSON.stringify({
    odoFlash: snap.odoFlash, bodyCounter: snap.bodyCounter,
    installed: snap.installedCount,
    misaligned: Object.values(snap.nodes).filter(n => n.installed && !n.aligned).map(n => n.addr + ':' + n.name),
}, null, 2));
check('初始 odoFlash', 'true（模拟车出厂默认 ABS/EPS/DASM 未对齐）', String(snap.odoFlash), snap.odoFlash === true);

console.log('--- §5.1 读取对齐状态（工具口径）---');
const st = await t.checkAlignment();
console.log(JSON.stringify({ ref: st.ref, aligned: st.aligned, misaligned: st.misaligned, absent: st.absent, failed: st.failed, verdict: st.verdict }, null, 2));
const toolMispredict = (st.misaligned + st.failed) > 0;
check('工具对齐结论与真值一致', `工具判定闪烁=${snap.odoFlash}`, `工具 verdict="${st.verdict}" 判定闪烁=${toolMispredict}`, toolMispredict === snap.odoFlash);
check('结论文案（教程 §5.1）', '含「里程表会闪烁」', st.verdict, st.verdict.includes('里程表会闪烁'));
check('未对齐节点识别', '3 个未对齐（ABS 0x28 / EPS 0x30 / DASM 0x2A）',
    st.detail.filter(d => d.status === 'misaligned').map(d => d.name + '@' + (d.counter) + '/ref' + d.ref).join('; ') + ` (共${st.misaligned})`,
    st.misaligned === 3);

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
console.log(`通过 ${pass}/${results.length}`);
await t.close();                 // P3-6：关闭桥接连接，避免进程不退出
process.exit(fail ? 1 : 0);
