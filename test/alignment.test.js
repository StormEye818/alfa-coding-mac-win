/** 对齐状态位图判定自测：node test/alignment.test.js */
import fs from 'fs';
import {
    computeAlignment,
    buildAlignmentBitmaps,
    nodeAlignmentStatus,
} from '../src/alignment.js';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const mods = JSON.parse(fs.readFileSync(new URL('../src/data/modules.json', import.meta.url), 'utf8'));
const named = JSON.parse(fs.readFileSync(new URL('../src/data/named-settings.json', import.meta.url), 'utf8'));
const sgw = mods.alignmentNodes.find((n) => /\(SGW\)/.test(n.name));

/** 位图写入辅助：节点 startByte 是反序位图索引，不是 PROXI 字节号 */
const maskOf = (n) => parseInt(n.bitMask, 16);
const putCfg = (d1, n) => { d1[41 - n.startByte] |= maskOf(n); };
const putAct = (d3, n) => { d3[48 - n.startByte] |= maskOf(n); };
const putEol = (d3, n) => { d3[64 - n.startByte] |= maskOf(n); };
const putDone = (d3, n) => { d3[80 - n.startByte] |= maskOf(n); };

const mk = () => ({ d1: new Uint8Array(289), d3: new Uint8Array(80) });

console.log('位图映射：节点 startByte=2 ↔ 命名项 Byte40 mask 0x01');
{
    const namedSgw = named.settings.find((s) => /\(SGW\)/.test(s.name));
    check('SGW 节点存在', !!sgw, JSON.stringify(sgw));
    check('节点 startByte=2', sgw.startByte === 2, String(sgw.startByte));
    check('映射到社区 Byte40', 42 - sgw.startByte === namedSgw.startByte,
        `${42 - sgw.startByte} vs ${namedSgw.startByte}`);
    check('掩码一致 0x01', maskOf(sgw) === namedSgw.mask, `${maskOf(sgw)} vs ${namedSgw.mask}`);
}

console.log('\n单节点状态：配置 / 实际 位图组合');
{
    const cases = [
        ['两者都有 → Ok', (b) => { putCfg(b.d1, sgw); putAct(b.d3, sgw); }, (r) => r.status === 'ok'],
        ['只有实际 → Added', (b) => { putAct(b.d3, sgw); }, (r) => r.status === 'added'],
        ['只有配置 → Removed', (b) => { putCfg(b.d1, sgw); }, (r) => r.status === 'removed'],
        ['都没有 → 不列出', () => {}, (r) => r.listed === false && r.status === 'absent'],
    ];
    for (const [name, setup, pred] of cases) {
        const b = mk(); setup(b);
        const bm = buildAlignmentBitmaps(b.d1, b.d3);
        const st = nodeAlignmentStatus({ ...sgw, name: 'SGW' }, bm);
        check(name, !!st && pred(st), JSON.stringify(st));
    }
}

console.log('\nEOL 位：期望 + 完成');
{
    let b = mk(); putCfg(b.d1, sgw); putAct(b.d3, sgw); putEol(b.d3, sgw);
    let st = nodeAlignmentStatus(sgw, buildAlignmentBitmaps(b.d1, b.d3));
    check('EOL 期望未完成 → EOL 未完成', st.status === 'eol-failed', st.status);

    b = mk(); putCfg(b.d1, sgw); putAct(b.d3, sgw); putEol(b.d3, sgw); putDone(b.d3, sgw);
    st = nodeAlignmentStatus(sgw, buildAlignmentBitmaps(b.d1, b.d3));
    check('EOL 期望 + 完成 → EOL Ok', st.status === 'eol-ok', st.status);

    // 只有 EOL 位：车上没有、配置里也没有 —— 不能算「待移除」（否则需对齐数虚增）
    b = mk(); putEol(b.d3, sgw);
    st = nodeAlignmentStatus(sgw, buildAlignmentBitmaps(b.d1, b.d3));
    check('只有 EOL 位 → eol-only', st.status === 'eol-only', st.status);
    check('eol-only 不可写', st.alignable === false, String(st.alignable));
    const onlyEol = computeAlignment(b.d1, b.d3, [sgw]);
    check('eol-only 不计入 needs', onlyEol.counts.needs === 0 && onlyEol.counts.eolOnly === 1,
        JSON.stringify(onlyEol.counts));
}

console.log('\n整车统计：Added / Removed / Ok / 未安装');
{
    const others = mods.alignmentNodes.filter((n) => n.name !== sgw.name).slice(0, 3);
    const [a, b2, c] = others;
    const b = mk();
    putCfg(b.d1, sgw); putAct(b.d3, sgw);          // Ok
    putAct(b.d3, a);                                // Added
    putCfg(b.d1, b2);                               // Removed
    putCfg(b.d1, c); putAct(b.d3, c); putEol(b.d3, c); putDone(b.d3, c);  // EOL Ok

    const res = computeAlignment(b.d1, b.d3, mods.alignmentNodes);
    check('ok', res.ok === true, res.reason);
    check('counts.listed = 4', res.counts.listed === 4, String(res.counts.listed));
    check('counts.ok = 1', res.counts.ok === 1, String(res.counts.ok));
    check('counts.added = 1', res.counts.added === 1, String(res.counts.added));
    check('counts.removed = 1', res.counts.removed === 1, String(res.counts.removed));
    check('counts.eolOk = 1', res.counts.eolOk === 1, String(res.counts.eolOk));
    check('counts.needs = 2（Added + Removed）', res.counts.needs === 2, String(res.counts.needs));
    check('consistent = false', res.consistent === false);
}

console.log('\n可写范围：只有实际位图置位的节点才 alignable');
{
    const others = mods.alignmentNodes.filter((n) => n.name !== sgw.name).slice(0, 3);
    const [a, b2, c] = others;
    const b = mk();
    putCfg(b.d1, sgw); putAct(b.d3, sgw);          // Ok      → 可写
    putAct(b.d3, a);                                // Added   → 可写
    putCfg(b.d1, b2);                               // Removed → 不可写（车上没有）
    putCfg(b.d1, c); putAct(b.d3, c); putEol(b.d3, c); putDone(b.d3, c);  // EOL Ok → 可写

    const res = computeAlignment(b.d1, b.d3, mods.alignmentNodes);
    const row = (n) => res.byName.get(n.name);
    check('counts.present = 3（在位）', res.counts.present === 3, String(res.counts.present));
    check('counts.eolExpected = 1', res.counts.eolExpected === 1, String(res.counts.eolExpected));
    check('Ok → alignable', row(sgw).alignable === true, JSON.stringify(row(sgw)));
    check('Added → alignable', row(a).alignable === true, JSON.stringify(row(a)));
    check('Removed → 不可写', row(b2).alignable === false, JSON.stringify(row(b2)));
    const absentNode = mods.alignmentNodes.find((n) => !res.rows.some((r) => r.name === n.name && r.listed));
    if (absentNode) {
        const r = res.byName.get(absentNode.name);
        check('未安装 → 不可写', r && r.alignable === false, JSON.stringify(r));
    } else {
        check('未安装 → 不可写（无未安装样本，跳过）', true);
    }
}

console.log('\nSGW 实际存在标记');
{
    const b = mk(); putAct(b.d3, sgw);
    const res = computeAlignment(b.d1, b.d3, [sgw]);
    check('SGW 实际位 → sgwPresent', res.sgwPresent === true, String(res.sgwPresent));
    // SGW 就是一个普通节点位：有独立诊断地址，走常规写入，不做任何特殊处理
    check('SGW 有独立诊断地址（可写目标）', String(sgw.addr).toUpperCase() === 'CB', String(sgw.addr));
}

console.log('\n数据不足 / 空输入');
{
    const b = mk();
    const short = computeAlignment(b.d1, new Uint8Array(32), [sgw]);
    check('DATA3=32B → 不构造 PROXIX 位图', short.ok === false && /80/.test(short.reason || ''), short.reason);

    const empty = computeAlignment(null, null, [sgw]);
    check('空输入 → ok=false', empty.ok === false && empty.rows.length === 0, empty.reason);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
