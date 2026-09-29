/**
 * 测试 02：§三 配置项修改 + §四 字节编辑器 + §九-1 写入后读回一致/当前值正确
 */
import { Tool } from '../sandbox/drive.mjs';
import { probeSnapshot } from './probe.mjs';

const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const t = new Tool({ adapter: 'vlinker-ms', port: '127.0.0.1:35001', log: (m) => console.log('  · ' + m) });
await t.connect();
const blk = await t.readConfig();
check('读取配置 289 字节 CRC 自洽', '289 字节且 CRC 自洽', `${blk.bytes.length} / ${blk.verify().ok ? '自洽' : '异常'}`, blk.bytes.length === 289 && blk.verify().ok);

// ---------- §3.1 命名配置项 ----------
console.log('--- §3.1 命名配置项 ---');
const before88 = blk.getByte(88);
const curVal = (v, mask) => {
    // 当前生效值：按掩码提取后与选项 value 对应
    return v & mask;
};
const dnaMask = 96;
check('DNA 选择器当前生效值', 'Type 1 (值 32)，初始字节 0xAC（bit6-5=01）', `Byte88=0x${before88.toString(16)} 掩码后=${curVal(before88, dnaMask)}`, curVal(before88, dnaMask) === 32);

await t.selectNamed('Dynamic control selector', 'Type 3/DNA/Sport');
const changes = await t.applySelected();
const after88 = t.block.getByte(88);
check('选择 Type 3 后待写入字节', 'Byte88 0xAC → 0xEC（掩码 0x60 内变 96，其它位不动）',
    `Byte88=0x${after88.toString(16)} 变更 ${JSON.stringify(changes)}`,
    after88 === 0xEC && changes.length === 1 && changes[0].addr === 88 && changes[0].before === 0xAC && changes[0].after === 0xEC);
check('CRC 自动重算（§四）', 'apply+seal 后 CRC 存储值=计算值', `verify=${JSON.stringify(t.block.verify())}`, t.block.verify().ok);

// 同字节其它位不受影响
const othersIntact = ((before88 & ~dnaMask) === (after88 & ~dnaMask));
check('按位掩码写入不影响同字节其它位', 'Byte88 除 bit5-4 外不变', String(othersIntact), othersIntact);

// ---------- §四 字节编辑器 ----------
console.log('--- §四 字节编辑器 ---');
const b156 = t.block.getByte(156);
await t.editByte(156, 5, (b156 >> 5 & 1) ^ 1);   // 翻转 bit5
const flipped = t.block.getByte(156);
check('位编辑翻转 bit', `Byte156 bit5 翻转，0x${b156.toString(16)} → 0x${flipped.toString(16)}`,
    `0x${flipped.toString(16)}`, flipped === (b156 ^ 0x20));
check('位编辑后 CRC 自动重算', 'CRC 自洽', `ok=${t.block.verify().ok}`, t.block.verify().ok);
// 还原此字节（工具侧等价：setByte 回原值）
t.block.setByte(156, b156); t.block.seal();
check('还原此字节', 'Byte156 回到 0x' + b156.toString(16), '0x' + t.block.getByte(156).toString(16), t.block.getByte(156) === b156);

// hex 输入两种写法（EC / 0xEC）在 ProxiBlock.setByte 的接受性
let hexOk = true, hexErr = '';
try { t.block.setByte(156, parseInt('0xEC', 16)); if (t.block.getByte(156) !== 0xEC) hexOk = false;
      t.block.setByte(156, parseInt('EC', 16)); if (t.block.getByte(156) !== 0xEC) hexOk = false;
} catch (e) { hexOk = false; hexErr = e.message; }
check('hex 输入 EC / 0xEC 均可', '两种写法都接受', hexOk ? '均接受' : '失败:' + hexErr, hexOk);
t.block.setByte(156, b156); t.block.seal();   // 恢复，保持只改 Byte88

// ---------- §3.3 写入 ECU ----------
console.log('--- §3.3 写入 ECU ---');
const stBefore = await t.checkAlignment();
console.log('写入前对齐:', stBefore.verdict);
const w = await t.writeToEcu();
check('写入 ECU 后读回一致（§九-1）', 'ok=true 且 diff 为空', `ok=${w.ok} diff=${JSON.stringify(w.diff)}`, w.ok && w.diff.length === 0);

// ---------- §九-3 重新读取后当前值正确 ----------
const blk2 = await t.readConfig();
const v88 = curVal(blk2.getByte(88), dnaMask);
check('重读后 DNA 当前值=设定值（§九-3）', 'Type 3 (96)', `Byte88=0x${blk2.getByte(88).toString(16)} 掩码后=${v88}`, v88 === 96);

// ---------- §3.2 扩展配置项（含同字节冲突数据面）----------
console.log('--- §3.2 扩展配置项 ---');
// 选两项同字节的扩展项：cornering-lights 与 headlight-washer 都打 Byte59
await t.selectFeature('cornering-lights');
await t.selectFeature('headlight-washer', 0);
const c2 = await t.applySelected();
check('同字节两项扩展配置可同时应用（待冲突告警由 UI 判）', '应用出变更（冲突提示应由界面红字告警）',
    `变更 ${JSON.stringify(c2.map(x => x.addr))}`, c2.length >= 1);
// 写入这两项
const w2 = await t.writeToEcu();
check('扩展配置写入读回一致', 'ok=true', `ok=${w2.ok} diff=${w2.diff.length}`, w2.ok);

// 单选互斥：同一扩展项两次选择只保留最后一次
await t.selectFeature('dna-race', 2);  // 3 选 1：类型 3 / DNA / Sport（fixed 236=0xEC）
const c3 = await t.applySelected();
const w3 = await t.writeToEcu();
check('扩展项单选写入成功', 'ok=true', `ok=${w3.ok} 变更${c3.length}处`, w3.ok);

const snapAfter = await probeSnapshot(t);
console.log('写入后（未对齐节点）odoFlash =', snapAfter.odoFlash, ' bodyCounter=', snapAfter.bodyCounter);
check('写入后里程表仍闪烁（§九 反向：未对齐→闪）', 'true（仅改了车身电脑，各节点未补写）', String(snapAfter.odoFlash), snapAfter.odoFlash === true);

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
console.log(`通过 ${results.filter(r => r.ok).length}/${results.length}`);
process.exit(0);   // BridgeClient 连接不关闭会挂住事件循环
