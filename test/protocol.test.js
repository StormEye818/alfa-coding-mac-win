/** 协议层端到端自测（走模拟适配器，离车可跑）：node test/protocol.test.js */
import { Elm327, reassembleIsoTp, parseFrames, hexToBytes, bytesToHex } from '../src/elm327.js';
import { Uds, DID, pinToKeyBcd, parseDtcList, dtcCodeToString } from '../src/uds.js';
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

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
