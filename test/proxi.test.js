/** 核心逻辑自测：node test/proxi.test.js */
import { ProxiBlock, crc16Kermit } from '../src/proxi.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log('CRC-16/KERMIT');
check("CRC('123456789') = 0x2189", crc16Kermit(new TextEncoder().encode('123456789')) === 0x2189,
    `got 0x${crc16Kermit(new TextEncoder().encode('123456789')).toString(16)}`);
check('CRC 空数据 = 0', crc16Kermit(new Uint8Array(0)) === 0);

console.log('\n实车照片头部（2026-09-28 Giulia 四叶草 中国版）');
// 前 24 字节已从照片精确读出：ASCII "406200232331OUTPUT-SIT %"
// 结构 = "406200"(6) + CRC 五位十进制 "23233"(5) + "1"(1) + "OUTPUT-SIT %"(12) = 24
const head = '3430363230303233323333314F55545055542D5349542025';
const body = new Uint8Array(289).fill(0);      // 12 行 x24 + 1
const headBytes = Uint8Array.from(head.match(/../g).map((h) => parseInt(h, 16)));
body.set(headBytes, 0);
const blk = new ProxiBlock(body);
check('头部 ASCII = 406200232331OUTPUT-SIT %', blk.headerAscii() === '406200232331OUTPUT-SIT %',
    `got ${JSON.stringify(blk.headerAscii())}`);
check('存储的 CRC 读出 23233', blk.storedCrc() === 23233, `got ${blk.storedCrc()}`);

console.log('\n字节/位编辑');
const b = new ProxiBlock(body);
b.setBit(58, 1, 1);
check('Byte58 bit1 置 1', b.getBit(58, 1) === 1 && b.getByte(58) === 0x02);
b.setBit(58, 1, 0);
check('Byte58 bit1 清 0', b.getByte(58) === 0x00);
b.setByte(119, 0x79);
check('Byte119 整体设为 0x79', b.getByte(119) === 0x79);
b.setBits(166, { 0: 1, 1: 1 });
check('Byte166 bit0+1 组合 (DDA=3)', b.getByte(166) === 0x03);
let threw = false;
try { b.setByte(9999, 0); } catch (e) { threw = true; }
check('越界下标报错', threw);
threw = false;
try { b.setBit(10, 9, 1); } catch (e) { threw = true; }
check('非法位编号报错', threw);

console.log('\n校验与封缄');
const c = new ProxiBlock(body);
const v0 = c.verify();
check('未封缄时 stored != computed（说明 CRC 区被覆盖过）', v0.stored !== v0.computed,
    `stored=${v0.stored} computed=${v0.computed}`);
const sealed = c.seal();
check('seal() 写回 5 位十进制', c.storedCrc() === sealed && String(sealed).padStart(5, '0').length === 5);
check('seal 后 verify 通过', c.verify().ok, JSON.stringify(c.verify()));

console.log('\ndiff');
const d1 = new ProxiBlock(body);
const d2 = new ProxiBlock(body);
d2.setBit(156, 4, 1);   // 全零块里置 1 才会产生差异
d2.setByte(58, 0xff);
const diffs = d1.diff(d2);
check('检出 2 处差异', diffs.length === 2, `got ${diffs.length}`);
check('差异含 Byte156', diffs.some((x) => x.addr === 156));
check('差异含 Byte58', diffs.some((x) => x.addr === 58));

console.log('\nhex 往返');
const txt = d1.toHexText();
check('toHexText 每行 24 字节', txt.split('\n')[0].split(' ').length === 24);
check('fromHex 可还原', ProxiBlock.fromHex(txt).diff(d1).length === 0);

console.log('\nmerge DATA3（MES 对齐同款）');
{
  // PROXIX 80B：DATA1[25..56] = DATA3[32..63]（正序）
  const b = new ProxiBlock(new Uint8Array(80).fill(0xAA));
  b.seal();
  const crcBefore = b.storedCrc();
  const d3 = new Uint8Array(80);
  for (let i = 0; i < 80; i++) d3[i] = i;          // 0x00..0x4F 便于核对
  const r = b.mergeData3(d3);
  check('80B 分支合并执行', r.merged === true, JSON.stringify(r));
  check('changed=32（全改）', r.changed === 32, `got ${r.changed}`);
  check('DATA1[25]=DATA3[32]', b.bytes[25] === d3[32], `got ${b.bytes[25]}`);
  check('DATA1[40]=DATA3[47]', b.bytes[40] === d3[47], `got ${b.bytes[40]}`);
  check('DATA1[56]=DATA3[63]', b.bytes[56] === d3[63], `got ${b.bytes[56]}`);
  check('区外不动（DATA1[57]）', b.bytes[57] === 0xAA);
  check('合并后 CRC 重算自洽', b.verify().ok);
  check('CRC 随数据变化', b.storedCrc() !== crcBefore);

  // 幂等：同一 DATA3 再合一次，零变化
  const r2 = b.mergeData3(d3);
  check('重复合并零变化', r2.merged && r2.changed === 0, JSON.stringify(r2));

  // 全零 DATA3 跳过（沙箱占位保护）
  const b2 = new ProxiBlock(new Uint8Array(80).fill(0xAA));
  const r3 = b2.mergeData3(new Uint8Array(80));
  check('全零 DATA3 跳过', r3.merged === false, JSON.stringify(r3));
  check('跳过时块未被污染', b2.bytes[25] === 0xAA);

  // 40B 分支：只动 DATA1[25..40]
  const b3 = new ProxiBlock(new Uint8Array(80).fill(0xAA));
  const d3s = new Uint8Array(40);
  for (let i = 0; i < 40; i++) d3s[i] = 0x10 + i;
  const r4 = b3.mergeData3(d3s);
  check('40B 分支合并', r4.merged === true && r4.changed === 16, JSON.stringify(r4));
  check('40B：DATA1[25]=DATA3[16]', b3.bytes[25] === d3s[16]);
  check('40B：DATA1[40]=DATA3[31]', b3.bytes[40] === d3s[31]);
  check('40B：DATA1[41] 不动', b3.bytes[41] === 0xAA);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
