/**
 * 模拟真车自测：node sandbox/car-selftest.mjs
 *
 * 逐项验收 giulia-car.mjs 的行为（PROXI 读写/回读校验、里程表闪烁、
 * 保养券防回拨、故障码、参数换算、执行器/例程、安全访问、失败模式）。
 */
import { GiuliaCar, PROXI_LENGTH, BODY_COUNTER, presenceInfo, decodeNum } from './giulia-car.mjs';
import { ProxiBlock } from '../src/proxi.js';
import { parseDtcList } from '../src/uds.js';
import fs from 'fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};
const hx = (a) => Array.from(a).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const modsData = JSON.parse(fs.readFileSync(new URL('../src/data/modules.json', import.meta.url), 'utf8'));
const dtcData = JSON.parse(fs.readFileSync(new URL('../src/data/dtc.json', import.meta.url), 'utf8'));
const paramsData = JSON.parse(fs.readFileSync(new URL('../src/data/params.json', import.meta.url), 'utf8'));

const car = new GiuliaCar({ log: () => {} });
const E = (addr) => car.ecuByAddress(typeof addr === 'string' ? parseInt(addr, 16) : addr);

console.log('===== 模拟真车自测（Alfa Romeo Giulia/Stelvio 952/949）=====\n');

// ---------------------------------------------------------------------------
console.log('场景 1：读 PROXI → 写入（正确 CRC）→ 读回一致 → 22 10 2A 无差异');
{
    const body = E(0x40);                                   // 车身电脑 BODY33
    const rd = car.handle(body, [0x22, 0x20, 0x23]);
    check('22 20 23 正响应 62 20 23', rd[0] === 0x62 && rd[1] === 0x20 && rd[2] === 0x23);
    const data1 = rd.slice(3);
    check(`DATA1 长度 ${PROXI_LENGTH} 字节`, data1.length === PROXI_LENGTH, `got ${data1.length}`);

    const blk = new ProxiBlock(Uint8Array.from(data1));
    check('读出的块 CRC 自洽（stored=computed）', blk.verify().ok, JSON.stringify(blk.verify()));

    // 改一个配置字节后重新封缄（与工具「写入 ECU」前 seal() 的做法一致）
    blk.setByte(88, blk.getByte(88) ^ 0x0c);
    blk.seal();
    const wr = car.handle(body, [0x2e, 0x20, 0x23, ...blk.bytes]);
    check('2E 20 23 正响应 6E 20 23', wr[0] === 0x6e && wr[1] === 0x20 && wr[2] === 0x23, hx(wr));

    const back = car.handle(body, [0x22, 0x20, 0x23]).slice(3);
    check('写入后读回一致（逐字节）', back.length === blk.bytes.length
        && back.every((b, i) => b === blk.bytes[i]));

    const vf = car.handle(body, [0x22, 0x10, 0x2a]);
    check('22 10 2A 应答 13 字节（62 10 2A + 10 数据）', vf.length === 13
        && vf[0] === 0x62 && vf[1] === 0x10 && vf[2] === 0x2a, `长度 ${vf.length}`);
    const d = vf.slice(3);
    const diffs = [];
    for (const [i, m] of [[5, 6], [8, 9], [11, 12]]) if (d[i] && d[m]) diffs.push({ byte: d[i], mask: d[m] });
    check('回读校验无差异（差异组全 0）', diffs.length === 0, JSON.stringify(diffs));
}

// ---------------------------------------------------------------------------
console.log('\n场景 2：写入（错误 CRC）→ 被拒');
{
    const body = E(0x40);
    const before = car.handle(body, [0x22, 0x20, 0x23]).slice(3);
    const bad = Uint8Array.from(before);
    bad[88] ^= 0xff;                                        // 改字节但不重算 CRC
    const wr = car.handle(body, [0x2e, 0x20, 0x23, ...bad]);
    check('返回 NRC（7F 2E …）', wr[0] === 0x7f && wr[1] === 0x2e, hx(wr));
    check(`NRC = 0x31（请求超出范围/CRC 不符）`, wr[2] === 0x31, `got 0x${(wr[2] || 0).toString(16)}`);
    const now = car.handle(body, [0x22, 0x20, 0x23]).slice(3);
    check('被拒后存储内容不变', now.every((b, i) => b === before[i]));
}

// ---------------------------------------------------------------------------
console.log('\n场景 2b：回读校验报出差异组（字节号, 异或掩码）');
{
    // 用「写入不完整」的车模拟 EEPROM 没写进去的字节，验证 22 10 2A 的差异编码
    const flakyCar = new GiuliaCar({
        partialWriteRate: 1, rng: () => 0, log: () => {},
        partialWriteBytes: [88, 115, 202],
    });
    const fb = flakyCar.ecuByAddress(0x40);
    const blk = new ProxiBlock(Uint8Array.from(flakyCar.handle(fb, [0x22, 0x20, 0x23]).slice(3)));
    const old88 = blk.getByte(88), old115 = blk.getByte(115), old202 = blk.getByte(202);
    blk.setByte(88, old88 ^ 0x0c);
    blk.setByte(115, old115 ^ 0x03);
    blk.setByte(202, old202 ^ 0x55);
    blk.seal();
    flakyCar.handle(fb, [0x2e, 0x20, 0x23, ...blk.bytes]);      // 写入“成功”但 3 字节未更新

    const vf = flakyCar.handle(fb, [0x22, 0x10, 0x2a]);
    check('3 组差异 → 应答 16 字节（62 10 2A + 13 数据）', vf.length === 16, `长度 ${vf.length}`);
    const d = vf.slice(3);
    const groups = [[5, 6], [8, 9], [11, 12]].map(([i, m]) => ({ byte: d[i], mask: d[m] }));
    // 字节号为 1 基（与 src/uds.js 的 expected[n-1] 一致）：下标 88/115/202 → 89/116/203
    check('差异组位于数据 [5,6] [8,9] [11,12]（与 src/uds.js 槽位一致）',
        groups[0].byte === 89 && groups[1].byte === 116 && groups[2].byte === 203,
        JSON.stringify(groups));
    check('异或掩码 = 存储值 ⊕ 写入值（Byte89: 0x0C）', groups[0].mask === 0x0c, `got 0x${groups[0].mask.toString(16)}`);
    // 与工具侧 src/uds.js 的解析语义一致：want ⊕ mask = 实际存储值
    const want = blk.bytes[89 - 1];
    check('uds.js 解析语义：want ⊕ mask = 存储值', (want ^ groups[0].mask) === old88,
        `${want.toString(16)} ^ ${groups[0].mask.toString(16)} vs ${old88.toString(16)}`);
    const flakySnap = flakyCar.snapshot();
    check('配置不一致 → odoFlash 为 true（对齐校验会发现问题）', flakySnap.odoFlash === true);
}

// ---------------------------------------------------------------------------
console.log('\n场景 3：只对齐部分模块 → snapshot().odoFlash === true');
{
    check('初始状态里程表闪烁（有未对齐模块）', car.snapshot().odoFlash === true);
    const snap = car.snapshot();
    const mis = Object.entries(snap.nodes).filter(([, v]) => v.installed && !v.aligned);
    check(`存在未对齐的已安装节点（${mis.length} 个）`, mis.length > 0);

    // 只对齐第一个未对齐节点（写入车身电脑的配置）
    const bodyBlock = car.handle(E(0x40), [0x22, 0x20, 0x23]).slice(3);
    const target = mis[0][1];
    const wr = car.handle(E(target.addr), [0x2e, 0x20, 0x23, ...bodyBlock]);
    check(`单个节点（${mis[0][0]} @0x${target.addr}）对齐写入成功`, wr[0] === 0x6e, hx(wr));
    const after = car.snapshot();
    check('仍未全部对齐 → odoFlash 仍为 true', after.odoFlash === true);
}

// ---------------------------------------------------------------------------
console.log('\n场景 4：全部对齐 → snapshot().odoFlash === false');
{
    const bodyBlock = car.handle(E(0x40), [0x22, 0x20, 0x23]).slice(3);
    const snap = car.snapshot();
    const addrs = new Set();
    for (const [, v] of Object.entries(snap.nodes)) {
        if (v.installed) addrs.add(v.addr);
    }
    let ok = 0, rejected = [];
    for (const a of addrs) {
        const wr = car.handle(E(a), [0x2e, 0x20, 0x23, ...bodyBlock]);
        if (wr[0] === 0x6e) ok++; else rejected.push(`0x${a}:${hx(wr)}`);
    }
    check(`逐节点写入全部成功（${ok}/${addrs.size}）`, rejected.length === 0, rejected.join(' '));
    const after = car.snapshot();
    check('全部对齐 → odoFlash 为 false', after.odoFlash === false,
        JSON.stringify(Object.entries(after.nodes).filter(([, v]) => v.installed && !v.aligned).map(([k]) => k)));
    const alignedCount = Object.values(after.nodes).filter((v) => v.aligned).length;
    console.log(`    （信息：${alignedCount} 个节点已对齐，车身计数 ${after.bodyCounter}）`);
}

// ---------------------------------------------------------------------------
console.log('\n场景 5：保养券张数写更大值 → 被拒（防回拨）');
{
    const svc = E(0x60);                                    // SVCRST29（与 DASH29 同址）
    const rd = car.handle(svc, [0x22, 0x28, 0x00]);
    check('22 28 00 读保养券张数正响应', rd[0] === 0x62);
    const cur = rd[3];
    console.log(`    （当前保养券张数 = ${cur}）`);

    const smaller = car.handle(svc, [0x2e, 0x28, 0x00, Math.max(0, cur - 2)]);
    check('写入更小值 → 接受（6E 28 00）', smaller[0] === 0x6e, hx(smaller));
    const mid = car.handle(svc, [0x22, 0x28, 0x00])[3];
    check(`写入生效（${cur} → ${mid}）`, mid === Math.max(0, cur - 2));

    const bigger = car.handle(svc, [0x2e, 0x28, 0x00, 255]);
    check('写入更大值（255）→ 被拒 NRC 31', bigger[0] === 0x7f && bigger[2] === 0x31, hx(bigger));
    const restore = car.handle(svc, [0x2e, 0x28, 0x00, cur]);
    check('更大值写入未生效（写回原值仍被拒 → 保持回拨保护）',
        restore[0] === 0x7f && car.handle(svc, [0x22, 0x28, 0x00])[3] === mid);
}

// ---------------------------------------------------------------------------
console.log('\n场景 6：故障码读取 / 清除有效');
{
    const body = E(0x40);                                   // BODY33
    const rd = car.handle(body, [0x19, 0x02, 0xff]);
    check('19 02 FF 正响应 59 02 FF', rd[0] === 0x59 && rd[1] === 0x02, hx(rd.slice(0, 6)));
    const list = parseDtcList(Uint8Array.from(rd));
    check(`读到故障码（${list.length} 条）`, list.length > 0);
    const bodyDtc = dtcData.modules.BODY33;
    const matched = list.every((d) => bodyDtc[String(d.raw[0].toString(16).padStart(2, '0')
        + d.raw[1].toString(16).padStart(2, '0')).toUpperCase()]
        || bodyDtc[String(d.raw[0].toString(16).padStart(2, '0') + d.raw[1].toString(16).padStart(2, '0'))]);
    check('码值取自 dtc.json（BODY33）', matched,
        list.map((d) => hx(d.raw)).join(','));
    console.log(`    （示例：${list.map((d) => {
        const k = d.raw.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
        return k + '=' + ((bodyDtc[k] || {}).name || '?');
    }).join('；')}）`);

    const cl = car.handle(body, [0x14, 0xff, 0xff, 0xff]);
    check('14 FF FF FF 清除正响应 54', cl[0] === 0x54);
    const again = parseDtcList(Uint8Array.from(car.handle(body, [0x19, 0x02, 0xff])));
    check('清除后读不到故障码', again.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n场景 7：参数读取并按 spec 换算正确（≥3 项）');
{
    // 电瓶电压 BODY33 DID 1004：bytes=1, format "num,1" → 物理 = raw/10
    const body = E(0x40);
    const specV = paramsData.modules.BODY33.find((x) => x.did === '1004' && /Battery voltage/i.test(x.name)).spec;
    const rv = car.handle(body, [0x22, 0x10, 0x04]).slice(3);
    const vPhys = decodeNum(rv.reduce((a, b, i) => a + b * 256 ** i, 0), specV);
    check(`电瓶电压 ≈ 13.8V（实际 ${vPhys}${specV.unit}）`, vPhys >= 12 && vPhys <= 14, `raw=${hx(rv)}`);

    // 车速 ABG28 DID 1002：bytes=1, format "num", unit km/h
    const abg = E(0xC0);
    const specS = paramsData.modules.ABG28.find((x) => x.did === '1002' && /Vehicle speed/i.test(x.name)).spec;
    const rs = car.handle(abg, [0x22, 0x10, 0x02]).slice(3);
    const sPhys = decodeNum(rs[0] ?? 0, specS);
    check(`车速 在 0-200 km/h（实际 ${sPhys}）`, sPhys >= 0 && sPhys <= 200, `raw=${hx(rs)}`);

    // 发动机转速 ADBLU1 DID 1000：bytes=2, format "num,0,0.25" → 物理 = raw*0.25
    const ad = E(0x01);
    const specR = paramsData.modules.ADBLU1.find((x) => x.did === '1000' && /Engine speed/i.test(x.name)).spec;
    const rr = car.handle(ad, [0x22, 0x10, 0x00]).slice(3);
    const rPhys = decodeNum(rr.reduce((a, b, i) => a + b * 256 ** i, 0), specR);
    check(`发动机转速 在 800-6000 rpm（实际 ${rPhys}）`, rPhys >= 800 && rPhys <= 6000, `raw=${hx(rr)}`);
    check('转速换算与 spec 的 scale=0.25 一致（raw×0.25）',
        Math.abs(rPhys - (rr[0] + rr[1] * 256) * 0.25) < 1e-9);

    // 未知 DID → NRC 31
    const unk = car.handle(body, [0x22, 0x99, 0x99]);
    check('未知 DID 返回 NRC 31', unk[0] === 0x7f && unk[2] === 0x31);
}

// ---------------------------------------------------------------------------
console.log('\n场景 8：执行器 2F 与例程 31 返回正响应');
{
    // 2F：IAW10JAX「A/C Compressor relay」模板 062F50010300FF → 2F 50 01 03 00 FF
    const ecu10 = E(0x10);
    const r2f = car.handle(ecu10, [0x2f, 0x50, 0x01, 0x03, 0x00, 0xff]);
    check('2F 50 01 正响应 6F …', r2f[0] === 0x6f && r2f[1] === 0x50 && r2f[2] === 0x01, hx(r2f));
    const r2f2 = car.handle(ecu10, [0x2f, 0x50, 0x01, 0x03, 0x00, 0x00]);
    check('2F 停止（选项 00）也正响应', r2f2[0] === 0x6f);

    // 31：JTDM23GP 例程模板 053101020401 → 31 01 02 04 01
    const r31 = car.handle(ecu10, [0x31, 0x01, 0x02, 0x04, 0x01]);
    check('31 01 02 04 正响应 71 …00', r31[0] === 0x71 && r31[1] === 0x01
        && r31[2] === 0x02 && r31[3] === 0x04 && r31[4] === 0x00, hx(r31));
    const r31b = car.handle(ecu10, [0x31, 0x03, 0x02, 0x07, 0x0b]);
    check('31 例程停止/查询（子功能 03）也正响应', r31b[0] === 0x71);
}

// ---------------------------------------------------------------------------
console.log('\n附加：在场位 / 安全访问 / 失败模式');
{
    // excluded 节点（拖车 TTM @0x4A）与未安装节点（CDM @0x84）的对齐写入应失败
    const bodyBlock = car.handle(E(0x40), [0x22, 0x20, 0x23]).slice(3);
    const wTtm = car.handle(E(0x4a), [0x2e, 0x20, 0x23, ...bodyBlock]);
    check('excluded 节点（拖车 TTM）对齐写入被拒', wTtm[0] === 0x7f, hx(wTtm));
    const wCdm = car.handle(E(0x84), [0x2e, 0x20, 0x23, ...bodyBlock]);
    check('未安装节点（CD 换碟机 CDM）对齐写入被拒', wCdm[0] === 0x7f, hx(wCdm));

    // 在场位判定与 snapshot 一致
    const snap = car.snapshot();
    const cdmNode = Object.entries(snap.nodes).find(([k]) => k.includes('Compact Disk'));
    check('snapshot 标记 CDM 未安装', cdmNode && cdmNode[1].installed === false);
    const bcmNode = Object.entries(snap.nodes).find(([k]) => k.includes('Body Computer'));
    check('snapshot 标记 BCM 已安装且已对齐', bcmNode && bcmNode[1].installed && bcmNode[1].aligned);

    // 安全访问：PIN 路径可用；SECURITY0529（05/06）返回 NRC
    const body = E(0x40);
    const seed = car.handle(body, [0x27, 0x03]);
    check('27 03 取种子 67 03 …', seed[0] === 0x67 && seed[1] === 0x03, hx(seed));
    const key = car.handle(body, [0x27, 0x04, 0x12, 0x34, 0x05]);   // PIN 12345 的 BCD
    check('27 04 送密钥成功（PIN 路径可用）', key[0] === 0x67 && key[1] === 0x04, hx(key));
    const srv = car.handle(body, [0x27, 0x05]);
    check('27 05（SECURITY0529 服务器密钥）返回 NRC', srv[0] === 0x7f && srv[2] === 0x12, hx(srv));

    // 失败模式：failRate=1 必失败（NRC 22 或 78）
    const flaky = new GiuliaCar({ failRate: 1, rng: () => 0, log: () => {} });
    const fb = flaky.ecuByAddress(0x40);
    const r1 = flaky.handle(fb, [0x22, 0x20, 0x23]);
    check('failRate=1 时返回 NRC 22/78', r1[0] === 0x7f && (r1[2] === 0x22 || r1[2] === 0x78), hx(r1));
    const r2 = flaky.handle(fb, [0x3e, 0x00]);
    check('保活 3E 不受失败模式影响', r2[0] === 0x7e);
}

// ---------------------------------------------------------------------------
console.log('\n附加：契约接口与总线分组');
{
    check('ecuByAddress(0x40) 返回车身电脑 ECU', E(0x40) !== null && E(0x40).modules.includes('BODY33'));
    check('ecuByAddress(未知地址) 返回 null', car.ecuByAddress(0xEE) === null);
    const snap = car.snapshot();
    check('35 个模块全部出现在 snapshot.modules', Object.keys(snap.modules).length === 35,
        String(Object.keys(snap.modules).length));
    const buses = new Set(Object.values(snap.modules).map((m) => m.bus));
    check('分 CCAN29 / BHCAN29 两条总线', buses.has('CCAN29') && buses.has('BHCAN29'), [...buses].join(','));
    const cs = snap.modules.CSWM2;
    check('CSWM2 在 BHCAN29（5 号蓝线）', cs && cs.bus === 'BHCAN29' && cs.cable === 'adapter-5-blue');
    const ab = snap.modules.ABSMMKC1;
    check('ABSMMKC1 在换线组（6 号灰线）', ab && ab.cable === 'adapter-6-gray');
}

// ---------------------------------------------------------------------------
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
