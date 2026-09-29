'use strict';
/**
 * 从 diag-data 抽出的 TSV 生成 952/949 模块映射 + PROXI 对齐节点表。
 * 用法：node tools/build-data.js
 *
 * 结果格式编码（来自诊断数据源 PROXIX1 的 ResultFormat 字段）：
 *   <目标地址><波特率>  如 40500 = 0x40 @500kbit
 *   末尾带 x 的（如 28500x）= 需要换适配线才能访问的那条 CAN
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

/** 40500 → { addr:'40', baud:500, swapCable:false } */
function parseRf(rf) {
    const m = /^([0-9A-Fa-f]{2})(\d{3})(x?)$/.exec(String(rf).trim());
    if (!m) return null;
    return {
        addr: m[1].toUpperCase(),
        baud: parseInt(m[2], 10),
        swapCable: m[3] === 'x',
    };
}

function build() {
    fs.mkdirSync(OUT, { recursive: true });

    // ---- 1. 952/949 模块表 ----
    const ecus = readTsv('ecu_list.tsv');
    const platOf = (carId) => {
        const n = parseInt(carId, 10);
        if (n >= 680 && n <= 682) return '952';   // Giulia
        if (n >= 693 && n <= 695) return '949';   // Stelvio
        return null;
    };
    const byCode = new Map();
    for (const r of ecus) {
        const plat = platOf(r.carId);
        if (!plat) continue;
        const key = r.code;
        if (!byCode.has(key)) {
            byCode.set(key, {
                code: key,
                name: r.name,
                bus: r.bus,
                tx: r.tx,
                rx: r.rx,
                platforms: [],
                timeoutMs: parseInt(r.timeout, 10) || 0,
                sort: parseInt(r.sort, 10) || 0,
            });
        }
        const e = byCode.get(key);
        if (!e.platforms.includes(plat)) e.platforms.push(plat);
    }
    const modules = [...byCode.values()].sort((a, b) => a.sort - b.sort);

    // ---- 2. PROXI 对齐节点表 ----
    const params = readTsv('params_all.tsv');
    const nodes = [];
    for (const r of params) {
        if (r.ModuleID !== 'PROXIX1' || r.CmdType !== '2') continue;
        const rf = parseRf(r.ResultFormat);
        if (!rf) continue;
        nodes.push({
            name: r.ParamName,
            addr: rf.addr,
            baud: rf.baud,
            swapCable: rf.swapCable,
            startByte: parseInt(r.StartByte, 10),
            bitMask: (r.BitResults || '').split('|')[0].replace(/[^0-9A-Fa-f]/g, '').slice(0, 2) || null,
            presence: r.BitResults || '',
            request: r.Commands,
        });
    }
    // 按换线分组、再按名称
    nodes.sort((a, b) => (a.swapCable === b.swapCable ? a.name.localeCompare(b.name) : (a.swapCable ? 1 : -1)));

    const busGroups = {
        // 与 诊断数据源 + 官方适配线说明对照（P2 截图可校正）
        plain: { label: '直连（无需换线）', baud: 500, cable: 'none' },
        comfort: { label: '舒适/车身 CAN', baud: 125, cable: 'adapter-5-blue' },
        swap: { label: '底盘/安全 CAN（需换线）', baud: 500, cable: 'adapter-6-gray' },
    };

    fs.writeFileSync(path.join(OUT, 'modules.json'), JSON.stringify({
        generatedFrom: 'diag-data/data (诊断软件 5.4 DB)',
        platforms: {
            '952': { name: 'Giulia', code: '952', bodyModule: 'BODY33', proxiModule: 'PROXIX1' },
            '949': { name: 'Stelvio', code: '949', bodyModule: 'BODY30', proxiModule: 'PROXIX1' },
        },
        busGroups,
        modules,
        alignmentNodes: nodes,
    }, null, 2) + '\n');

    console.log(`modules: ${modules.length}`);
    console.log(`alignment nodes: ${nodes.length}`);
    const g = (f) => nodes.filter(f).length;
    console.log(`  直连 500k : ${g((n) => !n.swapCable && n.baud === 500)}`);
    console.log(`  舒适 125k : ${g((n) => !n.swapCable && n.baud === 125)}`);
    console.log(`  换线 500x : ${g((n) => n.swapCable)}`);
}

build();
