'use strict';
/**
 * 模块 → 适配线分组。
 * 依据诊断数据源 PROXIX1 对齐项的 ResultFormat 编码 `<目标地址><波特率>[x]`：
 *   末尾 x = 需要换适配线的那条 CAN（对应 6 号灰色线）
 *   无 x 且 500k = 直连
 *   无 x 且 125k = 舒适/车身 CAN（5 号蓝色线）
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'diag-data', 'data');
const OUT = path.join(__dirname, '..', 'src', 'data');

function readTsv(name) {
    const txt = fs.readFileSync(path.join(DATA, name), 'utf8');
    const lines = txt.split('\n').filter((l) => l.length > 0);
    const hdr = lines[0].split('\t');
    return lines.slice(1).map((l) => {
        const c = l.split('\t');
        const o = {};
        hdr.forEach((h, i) => { o[h] = c[i] !== undefined ? c[i] : ''; });
        return o;
    });
}

function build() {
    const ecus = readTsv('ecu_list.tsv');
    const params = readTsv('params_all.tsv');

    // 对齐项里 addr+baud → 是否换线
    const nodeSwap = new Map();   // "TX|baud" -> bool
    for (const r of params) {
        if (r.ModuleID !== 'PROXIX1' || r.CmdType !== '2') continue;
        const m = /^([0-9A-Fa-f]{2})(\d{3})(x?)$/.exec(String(r.ResultFormat).trim());
        if (!m) continue;
        const key = m[1].toUpperCase() + '|' + parseInt(m[2], 10);
        if (!nodeSwap.has(key)) nodeSwap.set(key, m[3] === 'x');
        else if (m[3] === 'x') nodeSwap.set(key, true);   // 任一标记换线就算换线
    }

    const groups = {
        none: { label: '直连（无需换线）', cable: 'none', hint: '' },
        comfort: { label: '舒适/车身 CAN', cable: 'adapter-5-blue', hint: '请接 5 号蓝色适配线' },
        swap: { label: '底盘/安全 CAN', cable: 'adapter-6-gray', hint: '请更换为 6 号灰色适配线' },
    };

    const map = {};
    const seen = new Set();
    for (const r of ecus) {
        const n = parseInt(r.carId, 10);
        if (!((n >= 680 && n <= 682) || (n >= 693 && n <= 695))) continue;
        const code = r.code;
        if (seen.has(code)) continue;
        seen.add(code);
        const baud = /125/.test(r.bus) || /BHCAN/i.test(r.bus) ? 125 : 500;
        const key = String(r.tx).toUpperCase() + '|' + baud;
        const swap = nodeSwap.get(key);
        let group = 'none';
        if (swap === true) group = 'swap';
        else if (baud === 125) group = 'comfort';
        map[code] = {
            code,
            name: r.name,
            bus: r.bus,
            tx: r.tx,
            rx: r.rx,
            baud,
            group,
            cable: groups[group].cable,
            hint: groups[group].hint,
        };
    }

    fs.writeFileSync(path.join(OUT, 'cables.json'), JSON.stringify({
        note: '模块 → 适配线分组。ELM327 需按 hint 换线后才能访问该模块；vLinker MS 可自动切换，无需换线。',
        source: 'diag-data/data/params_all.tsv PROXIX1 ResultFormat（<地址><波特率>[x]）',
        groups,
        modules: map,
    }, null, 2) + '\n');

    const counts = { none: 0, comfort: 0, swap: 0 };
    for (const m of Object.values(map)) counts[m.group]++;
    console.log('模块数:', Object.keys(map).length);
    console.log('  直连  :', counts.none);
    console.log('  5号蓝 :', counts.comfort);
    console.log('  6号灰 :', counts.swap);
    console.log('\n需换 6 号灰线的模块:');
    for (const m of Object.values(map)) if (m.group === 'swap') console.log('  ', m.code, m.name);
}

build();
