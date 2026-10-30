'use strict';
/**
 * PROXI 对齐状态 —— 车身电脑 DATA1 / DATA3 位图比对。
 *
 * 语义来源（与车端已验证流程逐位对齐，2026-10-29 实车回归后修正）：
 *   进入车身模块后读三条 DID：
 *     22 20 23 → DATA1（PROXI 配置块）
 *     22 40 A1 → DATA2（不参与状态判定）
 *     22 40 A2 → DATA3（CAN 配置块，PROXIX 家族 80 字节）
 *   再用四张 16 字节位图做比对：
 *     DATA1[25..40] = 配置位图（PROXI 里“应该有哪些节点”）
 *     DATA3[32..47] = 实际位图（车上“实际有哪些节点”）
 *     DATA3[48..63] = EOL 期望位图
 *     DATA3[64..79] = EOL 完成位图
 *
 * 位图索引是**字节反序**的：节点 startByte=1 → 窗口最后一字节，startByte=16 → 窗口第一字节。
 * 实测交叉验证：SGW 节点 startByte=2 / mask 0x01 ↔ 命名项「SGW」Byte40 mask 0x01
 * （DATA1 0-based 索引 41-2=39 = 社区 Byte40）。
 *
 * 判定（与车端已验证流程一致）：
 *   配置 & 实际            → Ok（EOL 期望且完成 → EOL Ok；期望未完成 → EOL Failed）
 *   未配置 & 实际          → Added   （车上存在、配置里没有 → 需要添加）
 *   配置 & 未实际          → Removed （配置里有、车上不存在 → 需要移除）
 *   两者都没有              → 不列出（未安装/不适用）
 *
 * 可写入范围（2026-10-29 二次核对）：车端全量对齐的写入循环对每个节点先查
 * **EOL 期望位图（E = DATA3[48..63]）**，位为 0 直接 continue，不发起 2E 20 23
 * （车端全量写入循环里的过滤，PROXIX 与 legacy 两个家族各有一处）。E 在量产车上可能全 0
 * （无 EOL 数据），此时该过滤等价于「不过滤」。
 * 本工具的可写集合取 **实际位图 C**：E 有值且某节点 C=1/E=0 时（后加装件），
 * 写入前会单独提示，避免与车端全量口径悄悄分叉。
 *
 * ⚠️ 不要再逐节点读 22 10 2A 来判状态：那是**写入后的单节点回读校验**，
 *    不是整车状态来源；实车上大量模块对该 DID 不应答，逐节点读会得到假状态。
 *
 * SGW（安全网关，节点 startByte=2 / mask 0x01 ↔ 命名项 Byte40）在本车平台
 * （952/949，PROXI 程序代号 PROXIX1）**没有任何特殊分支**：它就是普通一个节点位，
 * 读写都走位图。车端对 SGW 唯一的态度是「实际位图里没有它 → 配置位也就没有它」，
 * 即 bypass 状态下做对齐会把 SGW 的配置位清掉（装回 SGW 后会变「待添加」，再对齐一次即可）
 * —— 车端已验证就是这个口径，**这里不要为 SGW 加任何特殊处理或拦截**。
 */

/** PROXIX 家族（952/949，DATA3=80B） */
const LAYOUT_PROXIX = {
    family: 'PROXIX',
    window: 16,
    data1Configured: 25,   // DATA1[25..40]
    data1Eol: 41,          // DATA1[41..56]
    data3Actual: 32,       // DATA3[32..47]
    data3Eol: 48,          // DATA3[48..63]
    data3EolDone: 64,      // DATA3[64..79]
};

/** 40 字节 DATA3 家族（保留；本工具当前只出 PROXIX） */
const LAYOUT_LEGACY = {
    family: 'LEGACY',
    window: 8,
    data1Configured: 25,   // DATA1[25..32]
    data1Eol: 33,          // DATA1[33..40]
    data3Actual: 16,       // DATA3[16..23]
    data3Eol: 24,          // DATA3[24..31]
    data3EolDone: 32,      // DATA3[32..39]
};

/** 位图是反序窗口：out[i] = bytes[start + len - 1 - i] */
function reversedWindow(bytes, start, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const v = bytes[start + len - 1 - i];
        out[i] = v === undefined ? 0 : v;
    }
    return out;
}

function nodeMask(node) {
    const raw = String(node.bitMask || (node.presence || '').slice(0, 2) || '')
        .replace(/[^0-9a-f]/gi, '');
    const m = parseInt(raw, 16);
    return Number.isFinite(m) ? (m & 0xff) : 0;
}

/**
 * 由 DATA1 + DATA3 构造四张位图。
 * @returns {null | {family:string, window:number, configured:Uint8Array, actual:Uint8Array, eol:Uint8Array, eolDone:Uint8Array, eolConfigured:Uint8Array}}
 */
function buildAlignmentBitmaps(data1, data3) {
    if (!data1 || !data1.length || !data3 || !data3.length) return null;
    const layout = data3.length >= 64 ? LAYOUT_PROXIX : LAYOUT_LEGACY;
    const w = layout.window;
    if (data1.length < layout.data1Eol + w) return null;
    if (data3.length < layout.data3EolDone + w) return null;
    return {
        family: layout.family,
        window: w,
        configured: reversedWindow(data1, layout.data1Configured, w),
        actual: reversedWindow(data3, layout.data3Actual, w),
        eol: reversedWindow(data3, layout.data3Eol, w),
        eolDone: reversedWindow(data3, layout.data3EolDone, w),
        eolConfigured: reversedWindow(data1, layout.data1Eol, w),
    };
}

/** 单节点状态。节点 startByte 是位图索引（1-based），不是 PROXI 字节号。 */
function nodeAlignmentStatus(node, bitmaps) {
    const idx = Number(node && node.startByte) - 1;
    const mask = nodeMask(node);
    if (!mask || idx < 0 || idx >= bitmaps.window) return null;
    const configured = (bitmaps.configured[idx] & mask) !== 0;
    const actual = (bitmaps.actual[idx] & mask) !== 0;
    const eol = (bitmaps.eol[idx] & mask) !== 0;
    const eolDone = (bitmaps.eolDone[idx] & mask) !== 0;
    if (!configured && !actual && !eol && !eolDone) {
        return { listed: false, status: 'absent', configured, actual, eol, eolDone, alignable: false };
    }
    let status;
    if (configured && actual) {
        if (eol && eolDone) status = 'eol-ok';
        else if (eol && !eolDone) status = 'eol-failed';
        else status = 'ok';
    } else if (!configured && actual) {
        status = 'added';
    } else if (configured && !actual) {
        status = 'removed';
    } else {
        // 只有 EOL 位（期望/完成）置位，配置与实际都没有：车上没有这个节点，
        // 也没被配置 —— 不能算「待移除」（那样会被计入需对齐数，虚增 N 个）。
        status = 'eol-only';
    }
    // alignable：**只有实际位图（DATA3[32..47]）置位的节点才可写入**。
    // 「待移除」= 配置里有、车上没有 → 没有写入目标，勾选也必须无效。
    return { listed: true, status, configured, actual, eol, eolDone, alignable: actual };
}

function bytesEq(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * 整车对齐状态。
 *
 * @param {Uint8Array|number[]} data1 DID 0x2023
 * @param {Uint8Array|number[]} data3 DID 0x40A2
 * @param {Array<{name:string,startByte:number,bitMask?:string,presence?:string}>} nodes
 * @returns {{
 *   ok: boolean, reason?: string, family?: string, bitmaps?: object,
 *   rows: Array<object>, byName: Map<string, object>,
 *   counts: {listed:number, present:number, ok:number, added:number, removed:number, eolOk:number, eolFailed:number, needs:number, eolExpected:number},
 *   consistent: boolean, sgwPresent: boolean
 * }}
 */
function computeAlignment(data1, data3, nodes) {
    const emptyCounts = { listed: 0, present: 0, ok: 0, added: 0, removed: 0, eolOk: 0, eolFailed: 0, eolOnly: 0, needs: 0, eolExpected: 0 };
    const bitmaps = buildAlignmentBitmaps(data1, data3);
    if (!bitmaps) {
        return {
            ok: false,
            reason: data1 && data1.length
                ? `DATA3 长度 ${data3 ? data3.length : 0} 不足以构造位图（PROXIX 需要 80 字节）`
                : '未读取 DATA1',
            rows: [], byName: new Map(), counts: emptyCounts, consistent: false, sgwPresent: false,
        };
    }
    const rows = [];
    const byName = new Map();
    for (const node of nodes || []) {
        const st = nodeAlignmentStatus(node, bitmaps);
        if (!st) continue;
        const row = { node, name: node.name, ...st };
        rows.push(row);
        byName.set(node.name, row);
        if (!st.listed) continue;
        emptyCounts.listed++;
        if (st.actual) emptyCounts.present++;
        if (st.eol) emptyCounts.eolExpected++;
        if (st.status === 'ok') emptyCounts.ok++;
        else if (st.status === 'added') emptyCounts.added++;
        else if (st.status === 'removed') emptyCounts.removed++;
        else if (st.status === 'eol-ok') emptyCounts.eolOk++;
        else if (st.status === 'eol-failed') emptyCounts.eolFailed++;
        else if (st.status === 'eol-only') emptyCounts.eolOnly++;
    }
    // Added + Removed = 真正需要“补写/移除”的节点数（EOL 未完成单列）
    emptyCounts.needs = emptyCounts.added + emptyCounts.removed;
    const consistent = bytesEq(bitmaps.configured, bitmaps.actual)
        && bytesEq(bitmaps.eol, bitmaps.eolDone)
        && bytesEq(bitmaps.eol, bitmaps.eolConfigured);
    const sgwPresent = rows.some((r) => r.listed && r.actual && /\(SGW\)/i.test(r.name));
    return {
        ok: true,
        family: bitmaps.family,
        bitmaps,
        rows,
        byName,
        counts: emptyCounts,
        consistent,
        sgwPresent,
    };
}

/** 状态中文标签（界面/日志共用；避免各处各写一套） */
const ALIGN_STATUS_LABEL = {
    ok: '已对齐',
    added: '待添加',
    removed: '待移除',
    'eol-ok': '已对齐（EOL Ok）',
    'eol-failed': 'EOL 未完成',
    'eol-only': '仅 EOL 位（车上无此节点）',
    absent: '未安装',
};

export {
    LAYOUT_PROXIX,
    LAYOUT_LEGACY,
    buildAlignmentBitmaps,
    nodeAlignmentStatus,
    computeAlignment,
    ALIGN_STATUS_LABEL,
};
