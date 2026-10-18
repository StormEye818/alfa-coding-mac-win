'use strict';
/**
 * 实时数据 / 冻结帧的数值换算（纯函数，无 DOM —— 可直接单测）。
 *
 * 语义来源（实车闭环过，见 HANDOFF 2026-10-15 数值换算全量对齐）：
 *   value = (raw × scale + offset) / 10^decimals
 *   · raw 按 **大端** 装配（实车 `FF EF` → -17 → -1.06°，小端会算成 -4097）
 *   · `nums` 族按字节宽做两位补码（有符号）
 *   · format 串是 `family[,decimals[,scale[,offset[,mask]]]]` 编码，四要素必须整串解析
 *
 * format 族（来自诊断数据源 ResultFormat）：
 *   `num` / `nums`          数值（nums 有符号）
 *   `nm,...`                带掩码截位的数值（如节气门开度 %）
 *   `bits` / `bitw` / `bitchars`  选项表（`MMVV标签` / 双字节配对 / 逐字节拼字符）
 *   `<地址><波特>[x]`         PROXIX1 的在场位参数（如 `1F500`/`30500x`/`C6500`），
 *                            与 bits 同一套 `MMVV标签` 选项表 —— 必须归到 bit 族，
 *                            否则 40 个在场位参数会显示成数字 8 / 4 / 64（2026-10-18 审查 M1）
 *   `str` / `hex` / `hex2`   字符串 / 十六进制
 *   `date` / `datehalf` / `eq3*` / `equ*`  日期与多项式：数据侧未导入换算参数，退化为 hex
 */

/** 带选项表的"编码型"格式串：纯数字或十六进制地址+波特，可带尾缀 x（换线组） */
const CODED_BIT_FORMAT = /^[0-9A-Fa-f]{5,6}x?$/;

/**
 * `19 04` 冻结帧应答的数据区起点：`59 04` + DTC(3) + 记录号(1) = 6 字节。
 * 依据：车端已验证行为 `qv()` 的 StartByte 是「1-based、相对数据区」，
 * 而实时参数表与冻结帧参数表用的是同一套 StartByte 口径（见 docs/修复记录）。
 */
const SNAPSHOT_DATA_OFFSET = 6;

function hexAt(s, i) {
    const v = parseInt(String(s).substr(i, 2), 16);
    return Number.isFinite(v) ? v : 0;
}

/**
 * 冻结帧快照取值：`19 04` 应答 → 单个参数的值。
 *
 * spec 字段（由 tools/build-dtc-snapshots.cjs 生成）：
 *   · `did`  —— 有 DID 形态（源 Commands 第二个 token，如 `…,0885,02`）时按 DID 定位
 *   · `start` —— **1-based**：无 did 时相对数据区；有 did 时相对该 DID 的值区
 *   · `bytes` / `format` / `decimals` / `scale` / `offset` / `options` / `unit`
 *
 * 找不到 DID 或应答太短返回 null（界面显示「—」，不装对）。
 */
function snapshotValue(resp, spec) {
    if (!resp || resp.length <= SNAPSHOT_DATA_OFFSET || !spec) return null;
    const data = Array.prototype.slice.call(resp, SNAPSHOT_DATA_OFFSET);
    let base = 0;
    if (spec.did) {
        const did = typeof spec.did === 'string' ? parseInt(spec.did, 16) : spec.did;
        if (!Number.isFinite(did)) return null;
        const hi = (did >> 8) & 0xff, lo = did & 0xff;
        let found = -1;
        for (let i = 0; i + 1 < data.length; i++) {
            if (data[i] === hi && data[i + 1] === lo) { found = i; break; }
        }
        if (found < 0) return null;
        base = found + 2;                     // 跳过 DID 两字节，值从这里开始
    }
    const start = base + Math.max(0, (Number(spec.start) || 1) - 1);
    if (start >= data.length) return null;
    return applyScale(Uint8Array.from(data), { spec: { ...spec, start } });
}

/**
 * @param {Uint8Array|number[]} raw 应答数据区（对齐调用方给的基准）
 * @param {{spec?: object}} item 参数条目（`item.spec` 是格式规格）
 * @returns {number|string|null}
 */
function applyScale(raw, item) {
    if (!raw || !raw.length) return null;
    const spec = (item && item.spec) || {};
    const nb = spec.bytes || 1;
    const st = spec.start || 0;                       // 参数在应答里的起始偏移（0-based）
    const fmt = String(spec.format || '');
    const slice = Array.prototype.slice.call(raw, st, Math.min(raw.length, st + nb));
    if (!slice.length) return null;

    // ---- 非数值格式：按格式族分支 ----
    if (fmt === 'str') {
        return slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').replace(/\0+$/, '').trimEnd();
    }
    if (fmt === 'hex') return slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    if (fmt === 'hex2') return slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    const namedBit = fmt === 'bits' || fmt === 'bitw' || fmt === 'bitchars';
    const codedBit = CODED_BIT_FORMAT.test(fmt) && Array.isArray(spec.options) && spec.options.length > 0;
    if (namedBit || codedBit) {
        // bit 族语义：选项表 = `MMVV标签`（bits 首字节）/ `MMVVMMVV标签`（bitw 双字节配对）/
        // bitchars 逐字节拼字符；**末项为兜底**
        const opts = spec.options;
        if (!opts || !opts.length) {
            return slice.map((b) => b.toString(2).padStart(8, '0')).join(' ');
        }
        const match1 = (b, e) => (b & hexAt(e, 0)) === hexAt(e, 2);
        const label = (e) => String(e).slice(4);
        if (fmt === 'bitw' && slice.length >= 2) {
            // ⚠️ bitw 是 **16 位掩码 + 16 位取值**（`MMMMVVVV标签`），不是"两对 MMVV"。
            //    按两对解永远匹配不上：巡航开关 `00020002ON` 的第一对是 mask=00/value=02，
            //    `b & 0x00` 恒为 0 ≠ 2 → 只剩末项兜底（该项永远显示 OFF）。
            //    改判据后：`00020002`=(word & 0x0002)==0x0002、`FFFF0201`=(word & 0xFFFF)==0x0201，
            //    以及末项 `00000000`=掩码 0 恒真（正好当兜底），三种样本全自洽。
            const word = (slice[0] << 8) | slice[1];
            for (let k = 0; k < opts.length; k++) {
                const e = opts[k];
                const m = parseInt(String(e).slice(0, 4), 16);
                const v = parseInt(String(e).slice(4, 8), 16);
                if (((word & m) === v) || k === opts.length - 1) return String(e).slice(8);
            }
        }
        if (fmt === 'bitchars') {
            let out = '';
            for (const b of slice) {
                for (let k = 0; k < opts.length; k++) {
                    if (match1(b, opts[k]) || k === opts.length - 1) { out += label(opts[k]); break; }
                }
            }
            return out;
        }
        for (let k = 0; k < opts.length; k++) {
            if (match1(slice[0], opts[k]) || k === opts.length - 1) return label(opts[k]);
        }
    }

    // ---- nm 族：nm,小数位,系数,偏移,掩码 —— 先按掩码截位再线性换算 ----
    if (fmt.startsWith('nm')) {
        const p = fmt.split(',');
        const mask = p[4] ? (parseInt(p[4], 16) >>> 0) : 0xff;
        let n = 0;
        for (const b of slice) n = n * 256 + b;
        n &= mask;
        n = n * (spec.scale ?? (p[2] ? Number(p[2]) : 1)) + (spec.offset ?? (p[3] ? Number(p[3]) : 0));
        const dec = spec.decimals ?? (p[1] ? Number(p[1]) : 0);
        return Number((n / Math.pow(10, dec)).toFixed(dec));
    }

    if (fmt === 'date' || fmt === 'datehalf' || fmt.startsWith('eq3') || fmt.startsWith('equ')) {
        // 日期/多项式：数据侧未导入换算参数，退化为 hex（不装对）
        return slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    }

    // ---- 数值：大端装配 + nums 两位补码 + (raw×scale+offset)/10^decimals ----
    let n = 0;
    for (const b of slice) n = n * 256 + b;
    const signed = spec.signed === true || fmt.startsWith('nums');
    if (signed && n >= Math.pow(2, 8 * slice.length - 1)) n -= Math.pow(2, 8 * slice.length);
    n = n * (spec.scale ?? 1) + (spec.offset ?? 0);
    const dec = spec.decimals ?? 0;
    n = n / Math.pow(10, dec);
    return Number(n.toFixed(dec));
}

export { applyScale, CODED_BIT_FORMAT, SNAPSHOT_DATA_OFFSET, snapshotValue };
