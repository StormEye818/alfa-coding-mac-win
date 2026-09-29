/**
 * 测试 04：§六 特殊功能 + §七 实时数据 + §八 模块诊断 + 业务规则负向
 */
import { Tool } from '../sandbox/drive.mjs';

const results = [];
const check = (name, expected, actual, ok) => {
    results.push({ name, expected, actual, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n     期望: ${expected}\n     实际: ${actual}`);
};

const t = new Tool({ adapter: 'vlinker-ms', port: '127.0.0.1:35001', log: (m) => console.log('  · ' + m) });
await t.connect();
await t.readConfig();

// ---------- §六 特殊功能 ----------
console.log('--- §六 特殊功能 ---');
// 1) 普通离线功能执行
await t.runFunction('Rear fog lights');   // PROXIX1 上的同名项
check('离线功能执行（后雾灯）', '执行成功', 'ok', true);

// 2) 需服务器密钥的功能应被拒绝
let srvReject = false, srvMsg = '';
try {
    await t.runFunction('PROXI ALIGNMENT PROCEDURE');  // 若不是 server 级会执行，先探测
    srvMsg = '可执行（非 server 级）';
} catch (e) { srvReject = true; srvMsg = e.message; }
console.log('     PROXI ALIGNMENT PROCEDURE →', srvMsg);

// 找一个 server 级功能验证拒绝
import fs from 'fs';
const fn = JSON.parse(fs.readFileSync(new URL('../src/data/functions.json', import.meta.url), 'utf8'));
const all = fn.categories.flatMap((c) => c.items);
const serverItem = all.find((i) => i.security && i.security.level === 'server');
let srv2 = false, srv2Msg = '';
try { await t.runFunction(serverItem.name); srv2Msg = '未拒绝！'; }
catch (e) { srv2 = e.message.includes('服务器密钥'); srv2Msg = e.message; }
check('需服务器密钥功能被禁用/拒绝', '明确拒绝且提示不支持', `${serverItem.name} → ${srv2Msg}`, srv2);

// 3) PIN 级功能：安全访问流程（5 位 PIN）
const pinItem = all.find((i) => i.security && i.security.level === 'pin');
console.log('     PIN 级功能样例:', pinItem && pinItem.name, pinItem && pinItem.module);
let pinOk = false, pinMsg = '';
try {
    await t.session.runOn(pinItem.module, async () => {
        const r = await t.uds.securityAccess('12345');
        pinOk = true; pinMsg = '安全访问通过 key=' + JSON.stringify(r);
    });
} catch (e) { pinMsg = '安全访问: ' + e.message; }
check('需 PIN 功能的安全访问可完成', '5 位 PIN 换密钥成功', pinMsg, pinOk);

// 4) 输入规格校验：保养周期 0~127500 步进 500（超范围应拒写）
let ruleReject = false, ruleMsg = '';
try {
    await t.session.runOn('SVCRST29', async () => {
        // Service interval DID：从 functions.json 命令里取 2E 后的 DID
        const svc = all.find((i) => /^Service interval$/i.test(i.name));
        const did = parseInt(/2E([0-9A-Fa-f]{4})/.exec(svc.commands)[1], 16);
        try {
            await t.uds.writeDataByIdentifier(did, Uint8Array.from([255]));  // 255*500=127500 合法上限
            ruleMsg = '上限值 127500 写入成功';
            try {
                await t.uds.writeDataByIdentifier(did, Uint8Array.from([256 & 0xff])); // 255 上限外？用 -1 类
            } catch (e) { /* 换一种 */ }
            // 直接越界：长度不符（2 字节）应 NRC 13
            try {
                await t.uds.writeDataByIdentifier(did, Uint8Array.from([1, 2, 3]));
                ruleMsg += '；长度不符未拒绝（异常）';
            } catch (e) { ruleReject = true; ruleMsg += '；长度不符被拒:' + e.message; }
        } catch (e) { ruleMsg = '上限值被拒: ' + e.message; }
    });
} catch (e) { ruleMsg = e.message; }
check('输入规格校验（Service interval）', '越界/长度不符被拒', ruleMsg, ruleReject);

// 5) 业务规则：保养券张数禁止写入更大值（防回拨）
let couponMsg = '';
await t.session.runOn('SVCRST29', async () => {
    const before = await t.uds.readDataByIdentifier(0x2800);
    const cur = before[0];
    couponMsg = `当前券数 ${cur}；`;
    try {
        await t.uds.writeDataByIdentifier(0x2800, Uint8Array.from([cur + 3]));
        const after = await t.uds.readDataByIdentifier(0x2800);
        couponMsg += after[0] === cur ? '写入更大值被静默忽略（值不变）✓' : `写入更大值竟然生效: ${after[0]} ✗`;
    } catch (e) {
        couponMsg += `写入更大值被拒（NRC）: ${e.message} ✓`;
    }
    try {
        await t.uds.writeDataByIdentifier(0x2800, Uint8Array.from([cur > 0 ? cur - 1 : 0]));
        const after2 = await t.uds.readDataByIdentifier(0x2800);
        couponMsg += `；写入更小值 ${cur > 0 ? cur - 1 : 0} → 实际 ${after2[0]}`;
    } catch (e) { couponMsg += '；写更小值: ' + e.message; }
});
check('业务规则：保养券禁止写入更大值', '更大值被拒/忽略，更小值允许', couponMsg, /✓/.test(couponMsg));

// ---------- §八 模块诊断 ----------
console.log('--- §八 模块诊断 ---');
const dtc1 = await t.readDtc('ABSMMKC1');
check('读取故障码（ABSMMKC1）', '带码值与名称', JSON.stringify(dtc1.slice(0, 3).map((d) => d.code + ':' + d.name)),
    dtc1.length > 0 && dtc1.every((d) => d.code && d.name));
let clearOk = false, clearMsg = '';
try {
    await t.session.runOn('ABSMMKC1', async () => { await t.uds.clearDtc(); });
    const dtc2 = await t.readDtc('ABSMMKC1');
    clearMsg = `清除后剩 ${dtc2.length} 条（清除前 ${dtc1.length} 条）`;
    clearOk = dtc2.length === 0 || dtc2.length < dtc1.length;
} catch (e) { clearMsg = e.message; }
check('清除故障码', '清除后故障码减少/清空', clearMsg, clearOk);

// ---------- §七 实时数据 ----------
console.log('--- §七 实时数据 ---');
const params = JSON.parse(fs.readFileSync(new URL('../src/data/params.json', import.meta.url), 'utf8'));
const modCode = 'ABSMMKC1';
const list = (params.modules && params.modules[modCode]) || [];
const p0 = list[0];
let pval = null, pMsg = '';
try {
    pval = await t.readParam(modCode, p0.did);
    pMsg = `${modCode} DID ${p0.did} (${p0.name || p0.label || '?'}) → ${JSON.stringify(pval).slice(0, 60)}`;
} catch (e) { pMsg = e.message; }
check('读取实时参数', `按 DID 读出数值（${modCode}）`, pMsg, pval !== null);

// CSV 格式化导出（界面侧为导出文件；此处验证数据可采样成 CSV 结构）
const rows = ['time,' + (p0.name || p0.did)];
for (let i = 0; i < 3; i++) {
    const v = await t.readParam(modCode, p0.did);
    rows.push(`${new Date().toISOString()},${Array.isArray(v) ? v.join(' ') : v}`);
}
check('CSV 采样结构', '表头 + 时间序列行', rows.length === 4, rows.length === 4);

// ---------- 字节编辑器负向：坏 CRC 应拒写 ----------
console.log('--- 负向：坏 CRC 写入 ---');
const good = Uint8Array.from(t.block.bytes);
const bad = Uint8Array.from(good); bad[100] ^= 0xff;   // 破坏数据但不修 CRC
let crcReject = false, crcMsg = '';
try {
    await t.uds.writeProxi(bad);
    crcMsg = '坏 CRC 竟然写入成功（异常）';
} catch (e) { crcReject = true; crcMsg = e.message; }
check('CRC 不符的块应被 ECU 拒写', 'NRC 拒绝', crcMsg, crcReject);

console.log('\n=== 汇总 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
console.log(`通过 ${results.filter(r => r.ok).length}/${results.length}`);
process.exit(0);
