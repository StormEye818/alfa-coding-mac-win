'use strict';
/**
 * 车辆识别（本车画像）—— 按车上读到的 PROXI 位图过滤模块清单。
 *
 * 为什么需要这一层：
 *   模块清单来自诊断数据源，是「同一平台上可能装车的全部模块」。所以发动机里会同时
 *   出现 2.0 汽油（IAW10JAX）、2.2 柴油（JTDM23GP）、2.9 V6（MED17.3.5 + 副 ECU），
 *   此外还有后桥转向、主动空气动力、后排独立空调这些本车没有的东西，清单很难看。
 *   诊断数据源本身也是按「车型版本」（同平台按发动机分版本）组织 ECU 清单的 ——
 *   即「按车过滤」本来就是既有口径，只是那套工具把选版本的工作交给了用户。
 *   我们不要求用户先选版本，而是直接读车上已有的 PROXI 位图推断。
 *
 * 判据（全部来自车上数据，不猜字符串、不猜零件号）：
 *   1) 模块 ↔ 节点：按**诊断地址**对应（module.tx ↔ alignmentNodes.addr）。
 *      地址是数据里唯一稳定的键；节点名称会翻译、会改，不能当键。
 *   2) 在位 = 配置位图 DATA1[25..40] ∪ 实际位图 DATA3[32..47]。
 *      取并集而不是交集：只要「配置里写了」或「车上真在」就允许连它 —— 典型场景
 *      是「待移除」节点（配置有、车上没），用户仍要连上去看为什么掉了。
 *   3) 发动机家族（结构性判据，改硬件后重读即变）：
 *        ECM2（V6 副 ECU，地址 0x17）在位 → 2.9 V6
 *        否则 SCR/AdBlue（地址 0x01）在位 → 2.2 柴油
 *        否则单 ECM 平台 → 2.0 汽油（置信度 medium，可手动改）
 *      2.9 先判是因为 V6 有两套 ECU，判据最硬；SCR 只在柴油车上出现。
 *      用户可在界面上改发动机版本，选择按 VIN 记住（见 app/app.js）。
 *
 * ⚠️ 这一层只影响**界面显示哪些模块**，不影响任何写入路径：
 *    隐藏的模块仍可通过「显示未配置模块」看到并连接，识别错了也不会写坏车。
 */

import { buildAlignmentBitmaps } from './alignment.js';

/** 发动机版本 → 显示名 */
export const ENGINE_LABELS = {
    '2.0': '2.0 汽油',
    '2.2': '2.2 柴油',
    '2.9': '2.9 V6',
};

/** 模块代号 → 发动机版本（只有这几套动力总成会互相排斥） */
export const ENGINE_OF_MODULE = {
    IAW10JAX: '2.0',
    JTDM23GP: '2.2',
    'MED17.3.5': '2.9',
    'MED17.3.5S': '2.9',
};

/** 结构性判据用到的节点（名称取自 modules.json alignmentNodes，含容错正则） */
export const MARKER_NODES = {
    ecm: /^Engine Control Node \(ECM\/NCM\)$/i,
    ecm2: /^Engine control Module 2 \(ECM2\)$/i,
    scr: /^Selective Catalytic Reduction Module \(SCRM\)$/i,
};

const maskOf = (node) => {
    const raw = String((node && (node.bitMask || node.presence)) || '').replace(/[^0-9a-f]/gi, '');
    const m = parseInt(raw, 16);
    return Number.isFinite(m) ? (m & 0xff) : 0;
};

/** 节点在两张位图上的状态；位图缺失 → 全 false */
function nodeBits(node, bitmaps) {
    const idx = Number(node && node.startByte) - 1;
    const mask = maskOf(node);
    if (!bitmaps || !mask || idx < 0 || idx >= bitmaps.window) {
        return { configured: false, actual: false, present: false };
    }
    const configured = (bitmaps.configured[idx] & mask) !== 0;
    const actual = (bitmaps.actual[idx] & mask) !== 0;
    return { configured, actual, present: configured || actual };
}

/** 2 位十六进制地址归一：'a0' → 'A0'、'0x28' → '28' */
function normAddr(v) {
    return String(v === undefined || v === null ? '' : v).trim().toUpperCase().replace(/^0X/, '');
}

/**
 * 构造本车画像。
 *
 * @param {object} opts
 * @param {string} opts.platform        '952' / '949'（界面「车型」下拉）
 * @param {Uint8Array|number[]|null} opts.data1 车身 PROXI 配置块（22 20 23）
 * @param {Uint8Array|number[]|null} opts.data3 CAN 配置块（22 40 A2），读不到可传 null
 * @param {Array} opts.modules          modules.json 的 modules
 * @param {Array} opts.nodes            modules.json 的 alignmentNodes
 * @param {string} [opts.engineOverride] 用户手动指定的发动机版本
 * @returns {null | {
 *   platform:string, engine:string|null, engineSource:string, confidence:string,
 *   rows:Array, rowByCode:Map, visible:Array, hidden:Array,
 *   counts:{total:number, visible:number, hidden:number, unmapped:number},
 *   hasBitmaps:boolean, notes:string[]
 * }}
 *   数据不足（没有 DATA1）→ null：调用方应显示全部模块，不做任何过滤。
 */
function buildVehicleProfile(opts = {}) {
    const modules = Array.isArray(opts.modules) ? opts.modules : [];
    const nodes = Array.isArray(opts.nodes) ? opts.nodes : [];
    const platform = String(opts.platform || '952');
    const data1 = opts.data1;
    if (!data1 || !data1.length) return null;

    // DATA3 读不到时用全 0 兜底：实际位图全 0，退化成「只看配置位图」，
    // 仍比不过滤好 —— 配置位图在车身电脑里总是可读的。
    const bitmaps = buildAlignmentBitmaps(data1, opts.data3)
        || buildAlignmentBitmaps(data1, new Uint8Array(80));

    const noteList = [];
    const bitsOf = (re) => {
        const node = nodes.find((n) => re.test(String(n.name || '').trim()));
        return node ? nodeBits(node, bitmaps) : { configured: false, actual: false, present: false, missing: true };
    };
    const ecm = bitsOf(MARKER_NODES.ecm);
    const ecm2 = bitsOf(MARKER_NODES.ecm2);
    const scr = bitsOf(MARKER_NODES.scr);

    // ---- 发动机家族 ----
    let engine = null;
    let engineSource = 'unknown';
    if (ecm2.present) { engine = '2.9'; engineSource = 'ecm2'; }
    else if (scr.present) { engine = '2.2'; engineSource = 'scr'; }
    else if (ecm.present) { engine = '2.0'; engineSource = 'single-ecm'; }
    if (!ecm.present && !ecm2.present) {
        noteList.push('配置位图里没有发动机节点，发动机版本无法判定');
    }
    const autoEngine = engine;
    if (opts.engineOverride && ENGINE_LABELS[opts.engineOverride]) {
        if (engine && engine !== opts.engineOverride) {
            noteList.push(`手动指定 ${ENGINE_LABELS[opts.engineOverride]}（自动推断为 ${ENGINE_LABELS[engine]}）`);
        }
        engine = opts.engineOverride;
        engineSource = 'user';
    }
    const confidence = engineSource === 'ecm2' || engineSource === 'scr' || engineSource === 'user'
        ? 'high'
        : engineSource === 'single-ecm' ? 'medium' : 'unknown';

    // ---- 地址 → 节点 ----
    const byAddr = new Map();
    for (const n of nodes) {
        const a = normAddr(n && n.addr);
        if (!a || n.addrUnknown) continue;      // addr=00 是「地址未知」，不能当键
        if (!byAddr.has(a)) byAddr.set(a, []);
        byAddr.get(a).push(n);
    }

    const rows = modules.map((m) => {
        const code = String(m.code || '');
        const addr = normAddr(m.tx);
        const hitNodes = byAddr.get(addr) || [];
        const platformOk = !m.platforms || !m.platforms.length || m.platforms.includes(platform);
        const engineBitsKnown = ecm.present || ecm2.present;

        let configured = false;
        let actual = false;
        for (const n of hitNodes) {
            const b = nodeBits(n, bitmaps);
            configured = configured || b.configured;
            actual = actual || b.actual;
        }
        const present = configured || actual;
        const engineOf = ENGINE_OF_MODULE[code] || null;

        let reason = null;
        if (!platformOk) reason = 'platform';
        // 家族匹配的发动机：直接可见 —— 发动机一定在车上，位图可能过期/读残
        else if (engineOf && engine && engineOf === engine) reason = null;
        else if (engineOf && engine && engineOf !== engine) reason = 'engine';
        else if (!hitNodes.length) reason = 'unmapped';
        // 位图里连 ECM 位都没有：说明整车位图不可信，发动机模块一律保留（宁可多显示）
        else if (engineOf && !engineBitsKnown) reason = 'engine-unknown';
        else if (!present) reason = 'absent';

        return {
            code,
            name: String(m.name || ''),
            tx: addr,
            node: hitNodes.length ? hitNodes[0].name : null,
            configured,
            actual,
            present,
            engine: engineOf,
            platformOk,
            // unmapped（数据里找不到同地址节点）/ engine-unknown → 无法判断，保留可见，避免误伤
            visible: reason === null || reason === 'unmapped' || reason === 'engine-unknown',
            reason,
        };
    });

    const rowByCode = new Map(rows.map((r) => [r.code, r]));
    const visible = rows.filter((r) => r.visible);
    const hidden = rows.filter((r) => !r.visible);
    const unmapped = rows.filter((r) => r.reason === 'unmapped');

    return {
        platform,
        engine,
        engineAuto: autoEngine,
        engineSource,
        confidence,
        rows,
        rowByCode,
        visible,
        hidden,
        counts: { total: rows.length, visible: visible.length, hidden: hidden.length, unmapped: unmapped.length },
        hasBitmaps: !!bitmaps,
        notes: noteList,
    };
}

export { buildVehicleProfile, nodeBits, normAddr };
