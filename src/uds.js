'use strict';
/**
 * UDS / KWP 服务封装 —— 全部建立在 Elm327.request() 之上。
 *
 * 952/949 Body Computer 上确认到的用法（诊断数据源与协议分析）：
 *   0x22 0x20 0x23 → DATA1  (PROXI 配置块，就是我们要改的那块)
 *   0x22 0x40 0xA1 → DATA2
 *   0x22 0x40 0xA2 → DATA3  (CAN 配置)
 *   0x22 0x10 0x2A → 写后校验
 *   0x2E 0x20 0x23 <DATA1> → PROXI 写入
 *   0x3E 0x00      → 保活
 *   0x27 0x03/0x04 → 安全访问（5 位 PIN，BCD）；0x05/0x06 为服务器算密钥，不用
 */

import { bytesToHex, hexToBytes, Elm327Error } from './elm327.js';

const DID = {
    PROXI_DATA1: 0x2023,
    DATA2: 0x40A1,
    DATA3: 0x40A2,
    VERIFY: 0x102A,
    /** 各模块的 PROXI 写入计数器 —— 与车身电脑比对（辅助参考，主判据是 0x102A） */
    PROXI_WRITE_COUNTER: 0x292E,
    VIN: 0xF190,
    ECU_ISO: 0xF1A5,
    HW_NUMBER: 0xF192,
    SW_NUMBER: 0xF194,
    ECU_SERIAL: 0xF18C,
};

const NRC = {
    0x10: '通用拒绝',
    0x11: '服务不支持',
    0x12: '子功能不支持',
    0x13: '请求长度/格式错误',
    0x21: '请求太频繁，稍后重试',
    0x22: '条件不满足（点火/车速等）',
    0x31: '请求超出范围',
    0x33: '安全访问被拒绝',
    0x35: '密钥无效',
    0x72: '编程失败',
    0x78: '请求已接收，等待（pending）',
    0x7E: '子功能在当前会话不支持',
    0x7F: '服务在当前会话不支持',
};

class UdsError extends Error {
    constructor(msg, nrc) {
        super(msg);
        this.nrc = nrc;
        this.nrcText = nrc !== undefined ? (NRC[nrc] || `未知 NRC 0x${nrc.toString(16)}`) : undefined;
    }
}

function assertPositive(resp, service) {
    if (!resp || resp.length === 0) throw new UdsError(`${service}: 空响应`);
    if (resp[0] === 0x7f) {
        const nrc = resp[2];
        throw new UdsError(`${service} 被拒绝：${NRC[nrc] || 'NRC 0x' + nrc.toString(16)}`, nrc);
    }
    return resp;
}

class Uds {
    /** @param {import('./elm327').Elm327} link */
    constructor(link) {
        this.link = link;
    }

    async testerPresent() {
        return this.link.request(new Uint8Array([0x3e, 0x00]));
    }

    /**
     * 进扩展会话（10 03 → 必须回 50 03）。
     *
     * 实车定论（2026-10-10）：写入 NRC 0x31 的根因就是没进扩展会话——
     * 读取在默认会话能过，写入（2E）必须扩展会话。ECU 的 S3 会话超时通常 5 秒，
     * 用户编辑字节常花十几秒，所以**每次写入前都必须重进**，不能只在连接时进一次。
     * 对齐模块连接标准流程（每次连接发 10 03 并强制校验 50 03）。
     */
    async enterExtendedSession() {
        const resp = await this.link.request(new Uint8Array([0x10, 0x03]), { timeoutMs: 3000 });
        if (!resp || resp.length < 2 || resp[0] !== 0x50 || resp[1] !== 0x03) {
            const hex = resp ? bytesToHex(resp) : '(空)';
            throw new UdsError(`扩展会话切换失败：期望 50 03，实得 ${hex}`, resp && resp[0] === 0x7f ? resp[2] : undefined);
        }
        return resp;
    }

    async readDataByIdentifier(did) {
        const hi = (did >> 8) & 0xff, lo = did & 0xff;
        const resp = assertPositive(await this.link.request(new Uint8Array([0x22, hi, lo])), '读取');
        if (resp[0] !== 0x62) throw new UdsError(`意外的响应服务 0x${resp[0].toString(16)}`);
        return resp.slice(3);       // 62 <hi> <lo> <data...>
    }

    async writeDataByIdentifier(did, data) {
        const hi = (did >> 8) & 0xff, lo = did & 0xff;
        const req = new Uint8Array(3 + data.length);
        req[0] = 0x2e; req[1] = hi; req[2] = lo; req.set(data, 3);
        // 写入前强制进扩展会话（S3 超时会掉回默认会话，那时写入必被拒 0x31）
        await this.enterExtendedSession();
        try {
            return assertPositive(await this.link.request(req, { timeoutMs: 8000 }), '写入');
        } catch (e) {
            // 0x31 = 请求超出范围：典型原因是会话掉了/未在扩展会话。重进一次会话再试。
            if (e instanceof UdsError && e.nrc === 0x31) {
                await this.enterExtendedSession();
                return assertPositive(await this.link.request(req, { timeoutMs: 8000 }), '写入');
            }
            throw e;
        }
    }

    async readDtc() {
        // 0x19 02 FF = reportDTCByStatusMask（全部）
        const resp = assertPositive(await this.link.request(new Uint8Array([0x19, 0x02, 0xff])), '读故障码');
        return parseDtcList(resp);
    }

    async clearDtc() {
        return assertPositive(await this.link.request(new Uint8Array([0x14, 0xff, 0xff, 0xff])), '清故障码');
    }

    /**
     * 安全访问：请求种子 + 发送密钥。
     * 952/949 用 0x03/0x04，密钥是 5 位 PIN 的 BCD；0x05/0x06 是服务器算的，我们不碰。
     */
    async securityAccess(pin) {
        const seed = assertPositive(await this.link.request(new Uint8Array([0x27, 0x03])), '取种子');
        if (seed[0] !== 0x67) throw new UdsError('取种子响应异常');
        const key = pinToKeyBcd(pin);
        return assertPositive(await this.link.request(new Uint8Array([0x27, 0x04, ...key])), '送密钥');
    }

    // ---- PROXI 专用 ----

    /** 读某模块的 PROXI 写入计数器 */
    async readProxiWriteCounter() {
        const d = await this.readDataByIdentifier(DID.PROXI_WRITE_COUNTER);
        // 数值格式（num）：小端，取低字节即可
        return d.length ? d[0] : null;
    }

    async readProxi() {
        return this.readDataByIdentifier(DID.PROXI_DATA1);
    }

    async readProxiAll() {
        const [d1, d2, d3] = await Promise.all([
            this.readDataByIdentifier(DID.PROXI_DATA1),
            this.readDataByIdentifier(DID.DATA2),
            this.readDataByIdentifier(DID.DATA3),
        ]);
        return { data1: d1, data2: d2, data3: d3 };
    }

    async writeProxi(data1) {
        return this.writeDataByIdentifier(DID.PROXI_DATA1, data1);
    }

    /**
     * 按节点回读校验（与诊断软件一致，DID 0x102A）。
     * 响应 13 字节：62 10 2A <...> ，其中含最多 3 组 (字节号, 异或掩码)，
     * 指出该节点存储块与基准块（车身电脑当前 PROXI）的差异位置——
     * 对齐判定的主依据。`expected` 传基准块用于还原差异字节的存储值。
     */
    async verifyProxi(expected) {
        const resp = assertPositive(await this.link.request(new Uint8Array([0x22, 0x10, 0x2A])), '回读校验');
        const d = resp.slice(3);
        const diffs = [];
        // 通行的解析方式：data[n-1] ^ mask 即该字节应有的值差异；n=0 表示无该项
        for (const [idxPos, maskPos] of [[5, 6], [8, 9], [11, 12]]) {
            const n = d[idxPos];
            const m = d[maskPos];
            if (n && m) {
                const want = expected ? expected[n - 1] : null;
                diffs.push({
                    byte: n,
                    xorMask: m,
                    got: want === null ? null : (want ^ m),
                    want,
                });
            }
        }
        return { ok: diffs.length === 0, diffs, raw: d };
    }
}

/** 5 位 PIN → BCD 密钥字节 */
function pinToKeyBcd(pin) {
    const s = String(pin).trim();
    if (!/^\d{5}$/.test(s)) throw new UdsError('PIN 必须是 5 位数字');
    return [
        ((s.charCodeAt(0) - 48) << 4) | (s.charCodeAt(1) - 48),
        ((s.charCodeAt(2) - 48) << 4) | (s.charCodeAt(3) - 48),
        (s.charCodeAt(4) - 48),
    ];
}

/** 0x19 响应 → DTC 列表 */
function parseDtcList(resp) {
    // 59 02 <statusAvailabilityMask> [ <dtcHi> <dtcLo> <status> ]...
    const out = [];
    for (let i = 3; i + 2 < resp.length; i += 3) {
        const hi = resp[i], lo = resp[i + 1], st = resp[i + 2];
        if (hi === 0 && lo === 0 && st === 0) continue;
        out.push({
            code: dtcCodeToString(hi, lo),
            raw: [hi, lo],
            status: st,
            pending: (st & 0x04) !== 0,
            confirmed: (st & 0x08) !== 0,
        });
    }
    return out;
}

function dtcCodeToString(hi, lo) {
    const letters = ['P', 'C', 'B', 'U'];
    const a = hi >> 6;
    const b = (hi >> 4) & 0x3;
    const c = hi & 0xf;
    const d = lo >> 4;
    const e = lo & 0xf;
    return `${letters[a]}${b}${c.toString(16).toUpperCase()}${d.toString(16).toUpperCase()}${e.toString(16).toUpperCase()}`;
}

export { Uds, UdsError, DID, NRC, pinToKeyBcd, parseDtcList, dtcCodeToString };
