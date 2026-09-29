/**
 * 测试 03：§五 PROXI 对齐全流程 + §九 刷写判据核心（正反向里程表闪烁）
 *
 * 关键场景：
 *   A. 全部对齐 → odoFlash 应为 false，结论「整车对齐正常，无里程表闪烁」
 *   B. 反向验证：只写车身电脑（节点未补写）→ odoFlash 应为 true
 *      · 同时记录工具「读取对齐状态」的结论是否与真值一致（疑似假阴性点）
 *   C. 只选未对齐 → 对齐所选 → odoFlash 恢复 false
 *   D. 未安装节点不应被对齐（写入应拒绝/忽略）
 */
import { Tool } from '../sandbox/drive.mjs';
import { probeSnapshot, ABSENT_NODES } from './probe.mjs';

const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const t = new Tool({ adapter: 'vlinker-ms', port: '127.0.0.1:35001', log: (m) => console.log('  · ' + m) });
await t.connect();
await t.readConfig();

const installedPredicate = (n) => !ABSENT_NODES.has(n.name);   // 模拟车已安装集合

// ---------- A. 全部对齐 ----------
console.log('--- A. 全部对齐（清掉出厂未对齐 + 历史改动）---');
const a1 = await t.alignNodes(installedPredicate);
check('全部对齐执行', '成功=55 已安装节点，失败=0', `成功 ${a1.done} / 失败 ${a1.fail}`, a1.done === 55 && a1.fail === 0);
const snapA = await probeSnapshot(t, { verbose: true });
check('对齐后 odoFlash 真值（§九-4 正向）', 'false（全部一致）', String(snapA.odoFlash), snapA.odoFlash === false);
const stA = await t.checkAlignment();
check('§九-2 对齐状态结论', '整车对齐正常，无里程表闪烁', stA.verdict, stA.verdict === '整车对齐正常，无里程表闪烁');
check('§九-2 全部已安装节点 ✓ 已对齐', `aligned=55 misaligned=0 failed=0`, `aligned=${stA.aligned} misaligned=${stA.misaligned} failed=${stA.failed} absent=${stA.absent}`,
    stA.aligned === 55 && stA.misaligned === 0 && stA.failed === 0);

// ---------- B. 反向：只写车身电脑 → 应闪烁 ----------
console.log('--- B. 反向验证：仅写车身电脑，节点未补写 ---');
await t.selectNamed('Dynamic control selector', 'Type 1');   // 改回 Type 1（与当前 Type 3 不同）
await t.applySelected();
const w = await t.writeToEcu();
check('B 步写入车身电脑成功', '读回一致', `ok=${w.ok}`, w.ok);
const snapB = await probeSnapshot(t, { verbose: true });
check('§九 反向：未对齐时 odoFlash 应为 true', 'true（车身电脑配置已变，节点仍旧）', String(snapB.odoFlash), snapB.odoFlash === true);
const stB = await t.checkAlignment();
console.log('     [工具结论] ' + stB.verdict + ` (aligned=${stB.aligned} misaligned=${stB.misaligned} failed=${stB.failed})`);
check('工具「读取对齐状态」与真值一致（写入后必须报闪烁）', `应含「里程表会闪烁」（真值 odoFlash=true）`,
    `verdict="${stB.verdict}"`,
    stB.verdict.includes('里程表会闪烁') === snapB.odoFlash);
check('工具判定的闪烁布尔 = 真值', `toolFlash=${stB.verdict.includes('里程表会闪烁')} 应等于 true`,
    String(stB.verdict.includes('里程表会闪烁')), stB.verdict.includes('里程表会闪烁') === true);

// ---------- C. 只选未对齐 → 对齐所选 ----------
console.log('--- C. 只选未对齐补对齐 ---');
const stC = await t.checkAlignment();
const misalignedNames = new Set(stC.detail.filter(d => d.status === 'misaligned').map(d => d.name));
console.log('     工具口径未对齐清单:', [...misalignedNames].join(' | ') || '(空)');
const c1 = await t.alignNodes((n) => misalignedNames.has(n.name));
check('对齐所选节点（工具口径未对齐）', `对齐 ${misalignedNames.size} 个`, `成功 ${c1.done} / 失败 ${c1.fail}`, c1.done === misalignedNames.size);
const snapC = await probeSnapshot(t, { verbose: true });
check('补对齐后 odoFlash', 'false', String(snapC.odoFlash), snapC.odoFlash === false);
const stC2 = await t.checkAlignment();
check('补对齐后结论', '整车对齐正常，无里程表闪烁', stC2.verdict, stC2.verdict === '整车对齐正常，无里程表闪烁');

// ---------- D. 未安装节点不应被对齐 ----------
console.log('--- D. 未安装节点写入行为 ---');
let absentReject = false, absentMsg = '';
try {
    const r = await t.alignNodes((n) => n.name === 'Compact Disk Node (CDM)');   // 无 CD 换碟机
    absentReject = r.fail === 1 && r.done === 0;
    absentMsg = `done=${r.done} fail=${r.fail}`;
} catch (e) { absentReject = true; absentMsg = '抛错: ' + e.message; }
check('未安装节点（CDM）对齐应失败/被拒', 'fail=1 done=0 或明确拒绝', absentMsg, absentReject);
const snapD = await probeSnapshot(t);
check('尝试对齐未安装节点不影响闪烁状态', 'odoFlash 仍为 false', String(snapD.odoFlash), snapD.odoFlash === false);

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
console.log(`通过 ${results.filter(r => r.ok).length}/${results.length}`);
process.exit(0);
