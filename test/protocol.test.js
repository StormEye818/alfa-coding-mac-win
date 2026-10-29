/** 协议层端到端自测（走模拟适配器，离车可跑）：node test/protocol.test.js */
import { Elm327, reassembleIsoTp, parseFrames, hexToBytes, bytesToHex } from '../src/elm327.js';
import { Uds, DID, pinToKeyBcd, parseDtcList, dtcCodeToString, isRoutineBusy } from '../src/uds.js';
import { MockAdapter } from '../src/mock-adapter.js';
import { ProxiBlock } from '../src/proxi.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log('ISO-TP 重组');
    check('单帧', bytesToHex(reassembleIsoTp(['03222023'])[0]) === '222023');
    const multi = reassembleIsoTp([
        '1014' + '622023' + 'AABBCCDDEE',   // 首帧：总长 0x14=20，载荷 8 字节
        '21' + '1122334455667788',           // 连续帧 1：8 字节
        '22' + '99AABBCC',                   // 连续帧 2：4 字节，收满 20
    ]);
    check('多帧重组长度正确', multi.length === 1 && multi[0].length === 20,
        `frames=${multi.length} len=${multi.map((m) => m.length)}`);
    check('多帧内容正确', bytesToHex(multi[0]) === '622023AABBCCDDEE112233445566778899AABBCC');

    console.log('\nELM327 + 模拟车：读写 PROXI');
    const port = new MockAdapter({ dtc: [{ raw: [0x90, 0x00], status: 0x08 }] });
    const link = new Elm327(port, { adapter: 'sim', log: () => {} });
    await link.init({ protocol: 7 });
    check('初始化发出 ATZ/ATE0/ATH1/ATSP7',
        port.txLog.includes('ATZ') && port.txLog.includes('ATE0') &&
        port.txLog.includes('ATH1') && port.txLog.includes('ATSP7'));

    await link.setAddress({ tx: 0x40, rx: 0xF1 });
    check('请求 ID 设为 18DA40F1', port.txLog.some((c) => c === 'ATSH18DA40F1'),
        JSON.stringify(port.txLog.filter((c) => c.startsWith('ATSH'))));

    const uds = new Uds(link);
    // ATSPB 之后 protocol 字段是字符串 'B'；旧 #singleFrame 把它当非 CAN，DLC=8 填充失效。
    // 这条断言必须放在 setAddress 之后，才能覆盖真实连模块路径。
    {
        const before = port.txLog.length;
        await uds.readDataByIdentifier(DID.VIN);
        const sf = port.txLog.slice(before).find((c) => /^0322F190/i.test(c));
        check('setAddress 后单帧仍补齐 8 字节', sf === '0322F19000000000', String(sf));
    }

    const d1 = await uds.readDataByIdentifier(DID.PROXI_DATA1);
    check('读 PROXI DATA1 成功', d1.length === 289, `got ${d1.length} 字节`);

    const blk = new ProxiBlock(d1);
    check('块头部是实车样例 ASCII 066390...', blk.headerAscii().startsWith('066390'), blk.headerAscii().slice(0, 12));
    check('未改动时 CRC 自洽', blk.verify().ok, JSON.stringify(blk.verify()));

    // 22 10 2A 的响应数据区固定 9 字节（3 组 标志/字节号/异或掩码）；模拟车全 0 = 无差异
    const vOk = await uds.verifyProxi(blk.bytes);
    check('22 10 2A 无差异 → ok', vOk.ok === true && vOk.diffs.length === 0, JSON.stringify(vOk));

    console.log('\n改一个功能 → 封缄 → 写入 → 再读回');
    blk.setBit(58, 1, 1);
    const sealed = blk.seal();
    check('seal 后 verify 通过', blk.verify().ok);
    await uds.writeProxi(blk.bytes);
    const back = await uds.readDataByIdentifier(DID.PROXI_DATA1);
    const backBlk = new ProxiBlock(back);
    check('读回一致', backBlk.diff(blk).length === 0);
    check('Byte58 bit1 确实置上', backBlk.getBit(58, 1) === 1);
    check('读回的 CRC 仍自洽', backBlk.verify().ok, JSON.stringify(backBlk.verify()));

    console.log('\nDTC / 安全访问 / PIN');
    const dtcs = await uds.readDtc();
    check('读到 1 条 DTC', dtcs.length === 1, `got ${dtcs.length}`);
    check('DTC 解码 P0000', dtcs[0].code === dtcCodeToString(0x90, 0x00), `got ${dtcs[0] && dtcs[0].code}`);
    check('5 位 PIN → BCD', bytesToHex(pinToKeyBcd('12345')) === '123405',
        bytesToHex(pinToKeyBcd('12345')));
    let threw = false;
    try { pinToKeyBcd('12ab5'); } catch (e) { threw = true; }
    check('非法 PIN 报错', threw);
    await uds.securityAccess('12345');
    check('安全访问完成', true);

    console.log('\nDTC 状态位：当前故障 vs 历史/已存储（UDS 4字节/条）');
    {
        const list = parseDtcList(Uint8Array.from([
            0x59, 0x02, 0xff,
            0x01, 0x23, 0x11, 0x01,   // testFailed（FTB 0x11）
            0x01, 0x24, 0x00, 0x08,   // 仅 confirmedDTC（已存储）
            0x01, 0x25, 0x00, 0x0c,   // pendingDTC + confirmedDTC
            0x01, 0x26, 0x00, 0x20,   // 仅 testFailedSinceLastClear（历史）
        ]));
        check('testFailed → 当前故障', list[0].active === true && list[0].testFailed === true);
        check('仅 confirmed → 历史/已存储', list[1].active === false && list[1].confirmed === true);
        check('pending + confirmed → 当前故障', list[2].active === true);
        check('仅 testFailedSinceLastClear → 历史', list[3].active === false);
        check('FTB 随记录带出', list[0].ftb === 0x11 && list[1].ftb === 0x00, JSON.stringify(list.map((d) => d.ftb)));
    }

    console.log('\nDTC 实车回归：IAW 10JA 健康车（2026-10-29 日志前 5 条，status 全 0x40）');
    {
        // 真车应答字节：59 02 CF 之后每 4 字节一条 = <DTC高> <DTC低> <FTB=00> <状态=0x40>
        const list = parseDtcList(Uint8Array.from([
            0x59, 0x02, 0xcf,
            0x1e, 0x47, 0x00, 0x40,   // P1E47（车端定义表：Knock sensor 1）
            0x03, 0x28, 0x00, 0x40,   // P0328（Knock sensor）
            0x03, 0x27, 0x00, 0x40,   // P0327
            0x03, 0x25, 0x00, 0x40,   // P0325
            0x11, 0x88, 0x00, 0x40,   // P1188（Intake pressure sensor）
        ]));
        check('解析出 5 条记录', list.length === 5, `got ${list.length}`);
        check('码值正确（P1E47 / P0328…）',
            list[0].code === 'P1E47' && list[1].code === 'P0328' && list[4].code === 'P1188',
            JSON.stringify(list.map((d) => d.code)));
        check('全部不是故障（stored=false，UI 不展示）',
            list.every((d) => !d.stored && !d.active && d.status === 0x40),
            JSON.stringify(list.map((d) => d.status)));
    }

    console.log('\nDTC legacy 兼容：3 字节/条（总长不按 4 对齐时退回）');
    {
        const list = parseDtcList(Uint8Array.from([
            0x59, 0x02, 0xff,
            0x90, 0x00, 0x08,         // confirmed
            0xaa, 0x55, 0x04,         // pending
        ]));
        check('legacy 3 字节解析出 2 条', list.length === 2, `got ${list.length}`);
        check('legacy 状态位正确', list[0].confirmed === true && list[1].pending === true);
    }

    console.log('\n例程忙 NRC（协议层已剥长度前缀，NRC 在 [2]）');
    check('7F 31 21 → 忙', isRoutineBusy(Uint8Array.from([0x7f, 0x31, 0x21])) === true);
    check('7F 31 23 → 忙', isRoutineBusy(Uint8Array.from([0x7f, 0x31, 0x23])) === true);
    check('71 03 … → 非忙', isRoutineBusy(Uint8Array.from([0x71, 0x03, 0x02, 0x04])) === false);
    check('短帧 7F 31 → 非忙（不崩）', isRoutineBusy(Uint8Array.from([0x7f, 0x31])) === false);

    console.log('\n22 10 2A 错帧（串到上一条 62 20 23）→ 重读一次');
    {
        let calls = 0;
        const fakeLink = {
            async request(p) {
                if (p[0] === 0x22 && p[1] === 0x10 && p[2] === 0x2a) {
                    calls++;
                    // 第一次：迟到的 62 20 23（289 字节块的首 9 字节），长度也 >= 12
                    return calls === 1
                        ? Uint8Array.from([0x62, 0x20, 0x23, ...new Array(9).fill(0)])
                        : Uint8Array.from([0x62, 0x10, 0x2a, ...new Array(9).fill(0)]);
                }
                return Uint8Array.from([0x62, 0x40, 0xaa]);
            },
        };
        const u2 = new Uds(fakeLink);
        const v2 = await u2.verifyProxi(new Uint8Array(289));
        check('错帧后重读并判定 ok', v2.ok === true && calls === 2, `ok=${v2.ok} calls=${calls}`);
    }

    console.log('\n模拟器快照可用于 UI');
    check('snapshot 输出 hex 文本', port.snapshot().split('\n').length > 1);

    console.log('\n线格式（与车端已验证行为逐字节对齐点）');
    {
        // ① 单帧必须补齐 8 字节：车端已验证行为常驻 ATCAF1（适配器补 PCI+填充），
        //    我们走 CAF0 自补 PCI，填充也得自己做，否则线上是短帧。
        const raw = [];
        const fake = {
            on(ev, cb) { if (ev === 'data') this.h = cb; },
            write(d) { raw.push(String(d).replace(/\r$/, '')); setTimeout(() => this.h && this.h('OK\r\r>'), 1); },
        };
        const l2 = new Elm327(fake, { adapter: 'elm327', log: () => {} });
        await l2.init({ protocol: 7 });
        await l2.request(Uint8Array.from([0x22, 0xf1, 0x90])).catch(() => {});
        const sf = raw.find((x) => /^[0-9A-F]{2}22F190/i.test(x));
        check('单帧请求 = 03 22 F1 90 + 4 字节 0x00 填充', sf === '0322F19000000000', String(sf));

        // ② 多帧首帧：>255 字节用 0x11（12 位长度），低字节 = 总长-256
        const big = new Uint8Array(292);              // 2E 20 23 + 289 字节块
        big[0] = 0x2e; big[1] = 0x20; big[2] = 0x23;
        raw.length = 0;
        await l2.request(big).catch(() => {});
        const ff = raw.find((x) => /^11/i.test(x));
        check('292 字节写 → 首帧 11 24 2E 20 23…', !!ff && ff.startsWith('11242E2023'), String(ff && ff.slice(0, 16)));
    }

    console.log('\n响应解析：CAN ID 只剥行首');
    {
        // 数据区里出现与响应 ID 相同的字节序列时，不能被当头部剥掉（旧实现会）
        const frames = parseFrames('18DAF140 62 20 23 18 DA F1 40 00\r\r>', 0x18daf140);
        check('行首 ID 被剥掉、数据区 18DAF140 保留',
            frames.length === 1 && frames[0].toUpperCase() === '62202318DAF14000',
            JSON.stringify(frames));
    }

    console.log('\n超时后的迟到应答（半双工串口最容易踩的串帧）');
    {
        // 第一条 22 20 23 在 50ms 超时，应答 100ms 才到；第二条 22 10 2A 必须拿到自己的应答
        let cb = null, n = 0;
        const fake = {
            on(ev, fn) { if (ev === 'data') cb = fn; },
            write() {
                const i = ++n;
                setTimeout(() => cb && cb(i === 1
                    ? '18DAF14003622023\r\r>'
                    : '18DAF1400C62102A000000000000000000\r\r>'), i === 1 ? 100 : 5);
            },
        };
        const l3 = new Elm327(fake, { adapter: 'elm327', log: () => {} });
        l3.protocol = 7;
        l3.respId = 0x18daf140;
        let code = null;
        try { await l3.request(Uint8Array.from([0x22, 0x20, 0x23]), { timeoutMs: 50 }); }
        catch (e) { code = e.code; }
        const r = await l3.request(Uint8Array.from([0x22, 0x10, 0x2a]), { timeoutMs: 500 });
        check('超时排空后不消费上一条迟到应答',
            code === 'TIMEOUT' && bytesToHex(r).startsWith('62102A'),
            `first=${code} second=${bytesToHex(r)}`);
    }

    console.log('\n适配器先回 OK、UDS 应答晚一段');
    {
        // 真车 ELM 在 CAF0 下发完帧后常先回 "OK"，ECU 的 6E/62 应答晚一个段到。
        // 旧实现见不到响应 ID 就 break → BAD_FRAME，把成功的写入判成失败。
        let cb = null;
        const fake = {
            on(ev, fn) { if (ev === 'data') cb = fn; },
            write() {
                setTimeout(() => cb && cb('OK\r\r>'), 5);
                setTimeout(() => cb && cb('18DAF140036E2023\r\r>'), 80);
            },
        };
        const l5 = new Elm327(fake, { adapter: 'elm327', log: () => {} });
        l5.protocol = 7;
        l5.respId = 0x18daf140;
        const r = await l5.request(Uint8Array.from([0x2e, 0x20, 0x23]), { timeoutMs: 1000 });
        check('OK 后继续等，拿到 6E 20 23', bytesToHex(r) === '6E2023', bytesToHex(r));
    }

    console.log('\n无等待者时的残留段不能给下一条命令');
    {
        // 上一条命令超时后很久才到（已过 120ms 排空窗口）→ 进入 segQueue。
        // 旧实现里下一条命令会立刻把这段当成自己的应答；现在按「到达时间 < 发出时间」丢弃。
        let cb = null;
        const fake = {
            on(ev, fn) { if (ev === 'data') cb = fn; },
            write(d) {
                const cmd = String(d).replace(/\r$/, '');
                if (/^0322102A/i.test(cmd)) {
                    setTimeout(() => cb && cb('18DAF1400C62102A000000000000000000\r\r>'), 5);
                }
            },
        };
        const l4 = new Elm327(fake, { adapter: 'elm327', log: () => {} });
        l4.protocol = 7;
        l4.respId = 0x18daf140;
        cb('18DAF14003622023\r\r>');          // 迟到、无人认领 → 入队
        await sleep(5);
        const r = await l4.request(Uint8Array.from([0x22, 0x10, 0x2a]), { timeoutMs: 500 });
        check('残留段被丢弃，返回本条 62 10 2A', bytesToHex(r).startsWith('62102A'), bytesToHex(r));
    }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
