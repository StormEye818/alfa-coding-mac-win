'use strict';
/**
 * PROXI 数据块核心逻辑 —— 与 UI 框架无关，可在 Node/浏览器/测试里直接用。
 *
 * 依据 诊断软件 逆向结论（见 ~/diag-data/PROGRESS.md）：
 *   - 读：UDS 0x22 DID 0x2023 → DATA1（PROXI 配置块）
 *   - 写：UDS 0x2E DID 0x2023 <DATA1>，写后用 0x22 DID 0x102A 校验
 *   - 校验：CRC-16/KERMIT（poly 0x8408 反射，init 0，refin/refout true）
 *           对 DATA1[25..] 计算，结果写成 5 位 ASCII 十进制数放到 DATA1[6..10]
 *   - 对齐：逐节点写入，节点清单见 diag-data/data/params_all.tsv 里 ModuleID=PROXIX1
 *
 * 实车照片（2026-09-28，新款 Giulia 四叶草 / 中国版）已确认头部结构：
 *   [0..5]="406200"  [6..10]=CRC 五位十进制  [11]='1'  [12..23]="OUTPUT-SIT %"
 */

const CRC_OFFSET = 6;   // 5 位 ASCII 十进制
const CRC_DIGITS = 5;
const CRC_DATA_START = 25; // 从这个下标起算 CRC

/** CRC-16/KERMIT —— 与 crccheck/reveng 的 "KERMIT" 一致，校验向量 CRC("123456789")=0x2189 */
function crc16Kermit(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let k = 0; k < 8; k++) {
            crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
        }
    }
    return crc & 0xffff;
}

class ProxiError extends Error {}

class ProxiBlock {
    /** @param {Uint8Array} bytes 整个 DATA1 */
    constructor(bytes) {
        if (!bytes || bytes.length < CRC_DATA_START) {
            throw new ProxiError(`PROXI 块长度不足：${bytes ? bytes.length : 0}`);
        }
        this.bytes = Uint8Array.from(bytes);
    }

    static fromHex(text) {
        const clean = String(text).replace(/[^0-9a-fA-F]/g, '');
        if (clean.length === 0) throw new ProxiError('没有读到任何字节');
        if (clean.length % 2 !== 0) throw new ProxiError(`十六进制长度为奇数：${clean.length}`);
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return new ProxiBlock(out);
    }

    get length() { return this.bytes.length; }
    clone() { return new ProxiBlock(this.bytes); }

    /** 当前块里存的 CRC（DATA1[6..10] 的 5 位十进制）；不是合法数字则返回 null */
    storedCrc() {
        const digits = this.bytes.slice(CRC_OFFSET, CRC_OFFSET + CRC_DIGITS);
        let s = '';
        for (const d of digits) {
            if (d < 0x30 || d > 0x39) return null;
            s += String.fromCharCode(d);
        }
        return parseInt(s, 10);
    }

    /** 对 DATA1[25..] 计算 CRC */
    computedCrc() {
        return crc16Kermit(this.bytes, CRC_DATA_START);
    }

    /** 把算出来的 CRC 写回 DATA1[6..10]（5 位十进制 ASCII，不足补零） */
    seal() {
        const v = this.computedCrc();
        const s = String(v).padStart(CRC_DIGITS, '0');
        if (s.length > CRC_DIGITS) throw new ProxiError(`CRC 超出 5 位：${v}`);
        for (let i = 0; i < CRC_DIGITS; i++) {
            this.bytes[CRC_OFFSET + i] = s.charCodeAt(i);
        }
        return v;
    }

    /** 校验：存的 CRC 与算出来的是否一致 */
    verify() {
        const stored = this.storedCrc();
        const calc = this.computedCrc();
        return {
            ok: stored !== null && stored === calc,
            stored,
            computed: calc,
        };
    }

    /**
     * 对齐前置步骤：把 DATA3 的 CAN 配置区合并进 DATA1[25..56]，再重算 CRC。
     *
     * 映射（实车采数 + 社区数据交叉验证）：
     *   · PROXIX（952/949，DATA3=80B）：DATA1[25..56] = DATA3[32..63]（正序拷贝）
     *   · 其他家族（DATA3=40B）：        DATA1[25..40] = DATA3[16..31]（正序拷贝）
     * 标准做法是无条件覆盖；此处 DATA3 全零/过短时跳过（沙箱占位数据保护，避免清掉 DATA1）。
     *
     * @param {Uint8Array} data3  DID 0x40A2 的 CAN 配置块
     * @returns {{merged: boolean, changed: number, reason?: string}} 是否合并、改了几字节
     */
    mergeData3(data3) {
        if (!data3 || data3.length === 0) {
            return { merged: false, changed: 0, reason: 'DATA3 为空' };
        }
        const allZero = data3.every((b) => b === 0);
        if (allZero) {
            return { merged: false, changed: 0, reason: 'DATA3 全零（疑似占位数据），跳过合并' };
        }
        let srcStart;   // DATA3 起点
        let len;
        if (data3.length >= 64) {
            srcStart = 32; len = 32;          // PROXIX 80B → DATA1[25..56]
        } else if (data3.length >= 32) {
            srcStart = 16; len = 16;          // 40B → DATA1[25..40]
        } else {
            return { merged: false, changed: 0, reason: `DATA3 太短（${data3.length} 字节）` };
        }
        if (this.bytes.length < 25 + len) {
            return { merged: false, changed: 0, reason: `DATA1 太短（${this.bytes.length} 字节）` };
        }
        let changed = 0;
        for (let i = 0; i < len; i++) {
            const before = this.bytes[25 + i];
            const after = data3[srcStart + i];
            if (before !== after) changed++;
            this.bytes[25 + i] = after;
        }
        this.seal();                          // DATA1 变了必须重算 CRC（否则 ECU 拒写）
        return { merged: true, changed };
    }

    // ⚠️ 编号约定：对外的字节号一律为社区口径（1-based，Byte1=首字节），
    // 内部数组 0-based。实车定论（2026-10-09）：Race Type2 的 CC 在 Byte88 = 内部[87]。
    #toIdx(no) {
        return no - 1;
    }

    getByte(no) {
        const i = this.#toIdx(no);
        this.#checkIndex(i);
        return this.bytes[i];
    }

    setByte(no, value) {
        const i = this.#toIdx(no);
        this.#checkIndex(i);
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
            throw new ProxiError(`字节值必须是 0-255：${value}`);
        }
        this.bytes[i] = value;
    }

    /** 读某一位（bit7 为最高位，与 通行的位编号一致：bit0=LSB） */
    getBit(no, bit) {
        this.#checkBit(bit);
        return (this.bytes[this.#toIdx(no)] >> bit) & 1;
    }

    /** 改某一位 */
    setBit(no, bit, value) {
        this.#checkBit(bit);
        const i = this.#toIdx(no);
        this.#checkIndex(i);
        const v = value ? 1 : 0;
        this.bytes[i] = (this.bytes[i] & ~(1 << bit)) | (v << bit);
    }

    /** 一次改多位（bitMap: {bit: 0|1}），用于 DDA/LKA 这类组合位 */
    setBits(index, bitMap) {
        for (const [bit, val] of Object.entries(bitMap)) {
            this.setBit(index, Number(bit), val);
        }
    }

    /**
     * 应用一条功能补丁。
     * patch 形如 { bytes: [{ addr, bits:{bit:val}, fixed?:number }, ...] }
     * fixed 表示整体设为该字节（会覆盖该字节其余位，如锁车鸣笛 Byte119=0x79）
     */
    applyPatch(patch) {
        const changed = [];
        for (const item of patch.bytes || []) {
            if (item.fixed !== undefined && item.fixed !== null) {
                const before = this.bytes[item.addr];
                this.setByte(item.addr, item.fixed);
                changed.push({ addr: item.addr, before, after: item.fixed, kind: 'fixed' });
            }
            for (const [bit, val] of Object.entries(item.bits || {})) {
                const b = Number(bit);
                const before = this.getBit(item.addr, b);
                this.setBit(item.addr, b, val);
                changed.push({ addr: item.addr, bit: b, before, after: val ? 1 : 0, kind: 'bit' });
            }
        }
        return changed;
    }

    /** 与另一块逐字节对比，返回差异列表 */
    diff(other) {
        const n = Math.max(this.bytes.length, other.bytes.length);
        const out = [];
        for (let i = 0; i < n; i++) {
            const a = i < this.bytes.length ? this.bytes[i] : null;
            const b = i < other.bytes.length ? other.bytes[i] : null;
            if (a !== b) out.push({ addr: i + 1, from: a, to: b });   // 社区编号（1-based）
        }
        return out;
    }

    /** 导出 标准的 hex 文本（24 字节一行，空格分隔） */
    toHexText(bytesPerLine = 24) {
        const lines = [];
        for (let i = 0; i < this.bytes.length; i += bytesPerLine) {
            lines.push(
                Array.from(this.bytes.slice(i, i + bytesPerLine))
                    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
                    .join(' ')
            );
        }
        return lines.join('\n');
    }

    /** 头部 ASCII 摘要，便于肉眼核对 */
    headerAscii() {
        const head = this.bytes.slice(0, 24);
        let s = '';
        for (const b of head) s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
        return s;
    }

    #checkIndex(i) {
        if (!Number.isInteger(i) || i < 0 || i >= this.bytes.length) {
            throw new ProxiError(`字节下标越界：${i}（块长 ${this.bytes.length}）`);
        }
    }

    #checkBit(b) {
        if (!Number.isInteger(b) || b < 0 || b > 7) {
            throw new ProxiError(`位编号必须是 0-7：${b}`);
        }
    }
}

export { ProxiBlock, ProxiError, crc16Kermit, CRC_OFFSET, CRC_DIGITS, CRC_DATA_START };
