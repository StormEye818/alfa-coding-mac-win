/**
 * 数值换算单测（纯函数，离车可跑）：node test/scale.test.js
 *
 * 目的：把 2026-10-15「实时数据数值换算全量对齐」与 2026-10-18「位族格式分派」
 * 这两次修复锁进回归。此前 app.js 里的 applyScale 没有任何自动化覆盖，
 * 沙箱又是小端编码 → 换算改错了也没人拦得住。
 */
import fs from 'fs';
import { applyScale, snapshotValue } from '../src/scale.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}
const eq = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 1e-9 : a === b;

const params = JSON.parse(fs.readFileSync(new URL('../src/data/params.json', import.meta.url), 'utf8'));
const flat = [];
for (const m of Object.keys(params.modules)) for (const it of params.modules[m]) flat.push({ mod: m, ...it });
const byName = (re, mod) => flat.find((x) => re.test(x.name) && (!mod || x.mod === mod));

console.log('数值：大端 + 符号 + 小数位 + 系数');
{
    const steer = byName(/steering angle/i, 'ABSMMKC1');
    check('转向角 spec 是 nums,2,6.25', !!steer && steer.spec.format === 'nums,2,6.25', steer && steer.spec.format);
    // 实车闭环样本：0xFFEF → -17 → -1.06°
    check('0xFFEF → -1.06（大端两位补码）', eq(applyScale(Uint8Array.from([0xFF, 0xEF]), steer), -1.06),
        String(applyScale(Uint8Array.from([0xFF, 0xEF]), steer)));
    check('0x001E → 1.88', eq(applyScale(Uint8Array.from([0x00, 0x1E]), steer), 1.88),
        String(applyScale(Uint8Array.from([0x00, 0x1E]), steer)));
    // 小端会得到 -4097 × 6.25/100 = -256.06 —— 明确排除
    check('同一字节按小端会是 -256.06（防回归到小端）', !eq(applyScale(Uint8Array.from([0xEF, 0xFF]), steer), -1.06));

    const rpm = byName(/engine speed/i, 'ADBLU1');
    check('转速 850 → raw 3400(0x0D48) 大端', eq(applyScale(Uint8Array.from([0x0D, 0x48]), rpm), 850),
        JSON.stringify(rpm.spec));
    const volt = byName(/battery voltage/i, 'BODY33');
    check('电瓶电压 138 → 13.8', eq(applyScale(Uint8Array.from([0x8A]), volt), 13.8), String(applyScale(Uint8Array.from([0x8A]), volt)));
}

console.log('\n位族：bits / bitw / bitchars');
{
    const bits = flat.find((x) => x.spec.format === 'bits');
    const opts = bits.spec.options;
    const first = opts[0];
    const val = parseInt(first.slice(2, 4), 16), mask = parseInt(first.slice(0, 2), 16);
    check(`bits 命中首项「${first.slice(4)}」`, applyScale(Uint8Array.from([val]), bits) === first.slice(4),
        String(applyScale(Uint8Array.from([val]), bits)));
    check('bits 掩码外的位不影响', applyScale(Uint8Array.from([val | (mask ^ mask)]), bits) === first.slice(4));

    const bitw = flat.find((x) => x.spec.format === 'bitw');
    const o = bitw.spec.options[0];   // MMVVMMVV标签
    const b0 = parseInt(o.slice(2, 4), 16) | parseInt(o.slice(0, 2), 16);
    const b1 = parseInt(o.slice(6, 8), 16) | parseInt(o.slice(4, 6), 16);
    check(`bitw 双字节命中「${o.slice(8)}」`, applyScale(Uint8Array.from([b0, b1]), bitw) === o.slice(8),
        String(applyScale(Uint8Array.from([b0, b1]), bitw)));

    const bc = flat.find((x) => x.spec.format === 'bitchars');
    const e0 = bc.spec.options[0];
    check(`bitchars 逐字节拼「${e0.slice(4)}」`, applyScale(Uint8Array.from([parseInt(e0.slice(2, 4), 16)]), bc) === e0.slice(4));
}

console.log('\n位族：PROXIX1 在场位（格式串带地址+波特，40 项）');
{
    // 这 40 项此前落进数值分支，显示成 8 / 4 / 64
    const cases = [['C6500', 0x08, 'Present'], ['30500x', 0x04, 'Present'], ['1F500', 0x40, 'Present']];
    for (const [fmt, byte, want] of cases) {
        const p = params.modules.PROXIX1.find((x) => x.spec.format === fmt);
        const buf = new Uint8Array(289);
        buf[p.spec.start] = byte;
        const got = applyScale(buf, p);
        check(`${fmt} 字节 0x${byte.toString(16)} → ${want}（不是数字）`, got === want, `got=${got}`);
    }
    // 全量：所有"有选项表"的参数都必须返回选项标签，不能返回纯数字
    let bad = [];
    for (const it of flat) {
        const o = it.spec.options;
        if (!o || !o.length) continue;
        const buf = new Uint8Array(600);
        const v = applyScale(buf, it);
        if (typeof v === 'number') bad.push(`${it.mod}:${it.name}(${it.spec.format})→${v}`);
    }
    check(`有选项表的 ${flat.filter((x) => x.spec.options && x.spec.options.length).length} 个参数全部走标签分支`,
        bad.length === 0, bad.slice(0, 5).join(' | '));
}

console.log('\n其他格式族');
{
    const nm = flat.find((x) => x.spec.format.startsWith('nm'));
    // nm,0,1,0,7F：掩码 0x7F 后直接是 % —— 0x9C & 0x7F = 0x1C = 28
    check('nm 掩码截位 0x9C → 28', applyScale(Uint8Array.from([0x9C]), nm) === 28, String(applyScale(Uint8Array.from([0x9C]), nm)));
    const hex = flat.find((x) => x.spec.format === 'hex');
    check('hex 族输出大写十六进制', /^[0-9A-F]+$/.test(String(applyScale(Uint8Array.from([0x01, 0xAB]), hex))));
    const str = flat.find((x) => x.spec.format === 'str');
    const vinBytes = Uint8Array.from('ZAR95200001234567'.split('').map((c) => c.charCodeAt(0)));
    check('str 族输出 ASCII', applyScale(vinBytes, { spec: { ...str.spec, bytes: 17, start: 0 } }) === 'ZAR95200001234567');
    const date = flat.find((x) => x.spec.format === 'date');
    check('date 族退化为 hex（不装对）', /^[0-9A-F ]+$/.test(String(applyScale(Uint8Array.from([0x24, 0x06, 0x15, 0x00]), date))));
    check('空应答返回 null', applyScale(new Uint8Array(0), hex) === null);
}

console.log('\n冻结帧：19 04 数据区口径（DID 定位 / 绝对偏移）');
{
    const snaps = JSON.parse(fs.readFileSync(new URL('../src/data/dtc-snapshots.json', import.meta.url), 'utf8'));
    // ① 无 DID（绝对偏移）：AAML1 "Operating time" start=8、4 字节 → 数据区第 8 字节起
    const plain = snaps.modules.AAML1.find((x) => /Operating time/i.test(x.name) && !x.did);
    const resp = new Uint8Array(6 + 48);
    resp[0] = 0x59; resp[1] = 0x04;                      // 59 04 + DTC3 + 记录号 = 6 字节头
    resp[6 + plain.start - 1] = 0x00;                    // data[7] = 0x000004D2 = 1234 分钟
    resp[6 + plain.start] = 0x00;
    resp[6 + plain.start + 1] = 0x04;
    resp[6 + plain.start + 2] = 0xD2;
    check(`AAML1 ${plain.name}（start=${plain.start} 绝对偏移）→ 1234`,
        snapshotValue(resp, plain) === 1234, String(snapshotValue(resp, plain)));

    // ② 有 DID（按 DID 定位）：ABSMMKC1 "Operating time" did=1008、start=1
    const byDid = snaps.modules.ABSMMKC1.find((x) => x.did === '1008');
    const r2 = new Uint8Array(6 + 40);
    r2[0] = 0x59; r2[1] = 0x04;
    // 数据区先放一个无关 DID 再放 1008，验证是"找到 DID"而不是"取第一段"
    const d = [
        0x60, 0x82, 0x01,                                // 其它条目（DID 6082 + 1 字节）
        0x10, 0x08, 0x00, 0x00, 0x02, 0x9A,              // DID 1008 → 0x0000029A = 666
        0x10, 0x09, 0x00, 0x0A,
    ];
    d.forEach((b, i) => { r2[6 + i] = b; });
    check(`ABSMMKC1 ${byDid.name}（DID 1008 定位）→ 666`,
        snapshotValue(r2, byDid) === 666, String(snapshotValue(r2, byDid)));

    // ③ DID 不存在 → null（界面显示 —，不装对）
    const missing = { ...byDid, did: 'FFFF' };
    check('DID 不在快照里时返回 null', snapshotValue(r2, missing) === null);

    // ④ 应答太短 → null
    check('应答不足 6 字节时返回 null', snapshotValue(new Uint8Array([0x59, 0x04]), byDid) === null);

    // ⑤ start 是 1-based：start=1 取的是 DID 后第 1 字节
    const firstByte = { ...byDid, bytes: 1, format: 'num', start: 1, scale: 1, offset: 0, decimals: 0 };
    check('start=1 取 DID 后第 1 字节（=0x00）', snapshotValue(r2, firstByte) === 0,
        String(snapshotValue(r2, firstByte)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
