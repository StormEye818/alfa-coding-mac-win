/** 对齐状态与选择逻辑自测：node test/align.test.js */
import fs from 'fs';
import { Uds, DID } from '../src/uds.js';
import { DemoLink } from '../src/demo-link.js';
import { Session } from '../src/session.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const cables = JSON.parse(fs.readFileSync(new URL('../src/data/cables.json', import.meta.url), 'utf8'));
const mods = JSON.parse(fs.readFileSync(new URL('../src/data/modules.json', import.meta.url), 'utf8'));

/** 与 app.js 一致的在场位解析 */
function presenceInfo(node) {
  let mask = 0, presentVal = null, absentVal = null;
  for (const part of String(node.presence || '').split('|')) {
    const m = /^([0-9A-Fa-f]{4})(.*)$/.exec(part.trim());
    if (!m) continue;
    const maskByte = parseInt(m[1].slice(0, 2), 16);
    const val = parseInt(m[1].slice(2, 4), 16);
    mask |= maskByte;
    const label = m[2].trim();
    if (/^not\s/i.test(label)) absentVal = val; else presentVal = val;
  }
  return { mask, presentVal, absentVal };
}

console.log('在场位解析（诊断数据编码 "0101Present|0100Not present"）');
const n0 = mods.alignmentNodes[0];
const pi = presenceInfo(n0);
check('掩码解析为 0x01', pi.mask === 0x01, `got 0x${pi.mask.toString(16)}`);
check('安装值 = 1', pi.presentVal === 1, `got ${pi.presentVal}`);
check('未安装值 = 0', pi.absentVal === 0, `got ${pi.absentVal}`);
const multi = presenceInfo({ presence: '3C10Base, Logic 1|3C20Base, Logic 2' });
check('多位掩码取并集 0x3C', multi.mask === 0x3c, `got 0x${multi.mask.toString(16)}`);

console.log('\n对齐状态比对（PROXI 写入计数器 DID 0x292E）');
{
  const link = new DemoLink({ log: () => {}, misaligned: ['EPSZFX1'], cables });
  const uds = new Uds(link);
  const ses = new Session(link, { cables, platform: '952' });
  ses.on('cableRequired', (e) => ses.confirmCable());
  await ses.ensureModule('BODY33');
  const ref = await uds.readProxiWriteCounter();
  check('基准计数可读', typeof ref === 'number', `got ${ref}`);

  await ses.ensureModule('ABSMMKC1');
  const ok = await uds.readProxiWriteCounter();
  await ses.ensureModule('EPSZFX1');
  const bad = await uds.readProxiWriteCounter();
  check('一致 → 已对齐', ok === ref, `${ok} vs ${ref}`);
  check('不一致 → 未对齐', bad !== ref, `${bad} vs ${ref}`);

  // 选择性对齐：只对未对齐的模块写一次，计数应追平
  link.misaligned.delete('EPSZFX1');
  await ses.ensureModule('EPSZFX1');
  const after = await uds.readProxiWriteCounter();
  check('单独对齐后计数追平', after === ref, `${after} vs ${ref}`);
}

console.log('\n演示链路：22 10 2A 差异组（数据区 [1,2]/[4,5]/[7,8]）');
{
  const link = new DemoLink({ log: () => {}, misaligned: ['EPSZFX1'], cables });
  const uds = new Uds(link);
  const ses = new Session(link, { cables, platform: '952' });
  ses.on('cableRequired', (e) => ses.confirmCable());

  await ses.ensureModule('EPSZFX1');
  const bad = await uds.verifyProxi(link.proxi);
  check('未对齐节点报 Byte88 差异', !bad.ok && bad.diffs.some((d) => d.byte === 88),
    JSON.stringify(bad.diffs));

  await ses.ensureModule('ABSMMKC1');
  const good = await uds.verifyProxi(link.proxi);
  check('已对齐节点无差异', good.ok && good.diffs.length === 0, JSON.stringify(good.diffs));

  // 对齐扫描走 connectNode：只传节点地址（0x30），没有模块代号 —— 演示层必须能反查
  await ses.connectNode({ name: 'EPS', addr: '30', baud: 500, swapCable: true });
  check('按地址连接能反查模块代号', link.currentCode === 'EPSZFX1', String(link.currentCode));
  const viaAddr = await uds.verifyProxi(link.proxi);
  check('按地址连接时差异仍生效', !viaAddr.ok && viaAddr.diffs.some((d) => d.byte === 88),
    JSON.stringify(viaAddr.diffs));
}

console.log('\n节点地址 → 模块映射');
{
  const node = mods.alignmentNodes.find((x) => x.addr.toUpperCase() === '28');
  const mod = Object.values(cables.modules).find((m) => m.tx.toUpperCase() === node.addr.toUpperCase() && m.baud === node.baud);
  check('ABS 节点能映射到模块', mod && mod.code === 'ABSMMKC1', JSON.stringify(mod && mod.code));
  const miss = mods.alignmentNodes.find((x) => x.addr.toUpperCase() === '00');
  const none = Object.values(cables.modules).find((m) => m.tx.toUpperCase() === '00' && m.baud === miss.baud);
  check('无对应模块时回退直接寻址', !none, JSON.stringify(none));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
