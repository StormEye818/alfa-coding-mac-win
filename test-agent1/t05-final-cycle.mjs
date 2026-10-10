/**
 * 测试 05：§九 刷写成功判据完整闭环（端到端）
 *   1) 写入后读回一致
 *   2) PROXI 对齐后里程表不闪烁（真值 snapshot.odoFlash）
 *   3) 重新读取后各项当前值正确
 *   4) 反向：未对齐时里程表应闪烁
 */
import { Tool } from '../sandbox/drive.mjs';
import { probeSnapshot, ABSENT_NODES, expectedInstalledCount } from './probe.mjs';

const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const t = new Tool({ adapter: 'vlinker-ms', port: '127.0.0.1:35001', log: (m) => console.log('  · ' + m) });
await t.connect();
const blk = await t.readConfig();
check('§九 前置：读取 289 字节 CRC 自洽', '289 / 自洽', `${blk.bytes.length} / ${blk.verify().ok}`, blk.bytes.length === 289 && blk.verify().ok);

// 1) 设定：DNA Type 3 + 大灯清洗开启
await t.selectNamed('Dynamic control selector', 'Type 3/DNA/Sport');
await t.selectFeature('headlight-washer', 1);           // 开启大灯清洗
const changes = await t.applySelected();
check('§九-1 前置：应用设定', '至少 1 处字节变更', JSON.stringify(changes), changes.length >= 1);

const w = await t.writeToEcu();
check('§九-1 写入后读回一致', 'ok=true，diff 空', `ok=${w.ok} diff=${JSON.stringify(w.diff)}`, w.ok && w.diff.length === 0);

// 3) 重新读取后各项当前值正确
const blk2 = await t.readConfig();
const v88 = blk2.getByte(88) & 96;
check('§九-3 重读后 DNA 当前值=Type 3 (96)', '96', String(v88), v88 === 96);
// 大灯清洗 headlight-washer: patches[0] addr 59 bits {"2":1}（开启）
const b59 = blk2.getByte(59);
check('§九-3 重读后大灯清洗=开启 (Byte59 bit2=1)', 'bit2=1', `Byte59=0x${b59.toString(16)} bit2=${(b59 >> 2) & 1}`, ((b59 >> 2) & 1) === 1);

// 4) 反向：写完未对齐 → 应闪烁
const snapMid = await probeSnapshot(t);
check('§九-4 反向：写入后未对齐 → odoFlash=true', 'true', String(snapMid.odoFlash), snapMid.odoFlash === true);

// 2) 全部对齐 → 不应闪烁
const al = await t.alignNodes((n) => !ABSENT_NODES.has(n.name));
check('§九-2 全部对齐', `${expectedInstalledCount()} 成功 0 失败`, `成功 ${al.done} / 失败 ${al.fail}`, al.done === expectedInstalledCount() && al.fail === 0);
const snapEnd = await probeSnapshot(t, { verbose: true });
check('§九-2/4 对齐后 odoFlash=false（里程表不闪烁）', 'false', String(snapEnd.odoFlash), snapEnd.odoFlash === false);
const st = await t.checkAlignment();
check('§九-2 对齐状态结论', '整车对齐正常，无里程表闪烁', st.verdict, st.verdict === '整车对齐正常，无里程表闪烁');

// 3) 再读一遍确认当前值仍正确（对齐写入不应改变车身电脑上的值）
const blk3 = await t.readConfig();
check('§九-3 对齐后当前值仍正确', 'DNA=96, 大灯清洗 bit2=1', `DNA=${blk3.getByte(88) & 96} b59bit2=${(blk3.getByte(59) >> 2) & 1}`,
    (blk3.getByte(88) & 96) === 96 && ((blk3.getByte(59) >> 2) & 1) === 1);

// 交叉验证：命名项与扩展项对同一功能的取值一致性（DNA Type 3）
await t.selectFeature('dna-race', 2);   // 类型 3 / DNA / Sport = fixed 236=0xEC
await t.applySelected();
check('交叉验证：扩展项 dna-race 类型3 与命名项 Type3 同值', 'fixed 0xEC 与掩码结果一致', `Byte88=0x${t.block.getByte(88).toString(16)}`, t.block.getByte(88) === 0xEC);

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
console.log(`通过 ${results.filter(r => r.ok).length}/${results.length}`);
process.exit(0);
