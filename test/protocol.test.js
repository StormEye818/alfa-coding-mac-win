/** 协议层端到端自测（走模拟适配器，离车可跑）：node test/protocol.test.js */
import { Elm327, reassembleIsoTp, hexToBytes, bytesToHex } from '../src/elm327.js';
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
    await link.init({ protocol: 8 });
    check('初始化发出 ATZ/ATE0/ATH1/ATSP8',
        port.txLog.includes('ATZ') && port.txLog.includes('ATE0') &&
        port.txLog.includes('ATH1') && port.txLog.includes('ATSP8'));

    await link.setAddress({ tx: 0x40, rx: 0xF1 });
    check('请求 ID 设为 18DA40F1', port.txLog.some((c) => c === 'ATSH18DA40F1'),
        JSON.stringify(port.txLog.filter((c) => c.startsWith('ATSH'))));

    const uds = new Uds(link);
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

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
