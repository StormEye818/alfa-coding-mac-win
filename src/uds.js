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
    /** DATA1S —— 标准流程在对齐前言里与 DATA1 一起读（`03 22 20 24`）。语义待深挖，先采集。 */
    PROXI_DATA1S: 0x2024,
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

/**
 * 22 10 2A 响应里「字节号」的下标基准。
 * **= 1（1-based）** —— 已由标准流程逐字节确认：解析处是 `block[字节号 - 1]`。
 * 响应缓冲固定 **13 字节** = 1 字节长度前缀 + 12 载荷（`62 10 2A` + 9 数据），
 * 三组差异在缓冲 [5,6] / [8,9] / [11,12]，即载荷数据区 [1,2] / [4,5] / [7,8]。
 * 车端已验证行为的 `block[n-1]` 已确认 1-based；若出现整体偏一位，先怀疑载荷切片，再考虑改这里。
 */
const PROXI_BYTE_INDEX_BASE = 1;

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
        if (resp.length < 3) {
            throw new UdsError(`${service}: 负响应格式错误（${bytesToHex(resp)}）`);
        }
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

    async testerPresent(timeoutMs = 5000) {
        return this.link.request(new Uint8Array([0x3e, 0x00]), { timeoutMs });
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
        let resp = await this.link.request(new Uint8Array([0x10, 0x03]), { timeoutMs: 3000 });
        if (resp && resp[0] === 0x7f && resp[2] === 0x12) {
            // 子功能不支持：部分模块的扩展会话号是 0x92（与连接校验同口径）
            resp = await this.link.request(new Uint8Array([0x10, 0x92]), { timeoutMs: 3000 });
        }
        if (!resp || resp[0] !== 0x50 || (resp[1] !== 0x03 && resp[1] !== 0x92)) {
            const hex = resp ? bytesToHex(resp) : '(空)';
            throw new UdsError(`扩展会话切换失败：期望 50 03/50 92，实得 ${hex}`, resp && resp[0] === 0x7f ? resp[2] : undefined);
        }
        return resp;
    }

    async readDataByIdentifier(did) {
        const hi = (did >> 8) & 0xff, lo = did & 0xff;
        const resp = assertPositive(await this.link.request(new Uint8Array([0x22, hi, lo])), '读取');
        if (resp[0] !== 0x62) throw new UdsError(`意外的响应服务 0x${resp[0].toString(16)}`);
        // 校验 DID：迟到的上一条应答若服务号同为 62，不能当本条数据用
        if (resp.length < 3 || resp[1] !== hi || resp[2] !== lo) {
            throw new UdsError(`响应 DID 不匹配：期望 ${hi.toString(16).padStart(2, '0')} ${lo.toString(16).padStart(2, '0')}，实得 ${bytesToHex(resp.slice(1, 3))}`);
        }
        return resp.slice(3);       // 62 <hi> <lo> <data...>
    }

    async writeDataByIdentifier(did, data) {
        const hi = (did >> 8) & 0xff, lo = did & 0xff;
        const req = new Uint8Array(3 + data.length);
        req[0] = 0x2e; req[1] = hi; req[2] = lo; req.set(data, 3);
        // 写入前强制进扩展会话（S3 超时会掉回默认会话，那时写入必被拒 0x31）
        await this.enterExtendedSession();
        // 车端已验证的写流程在组帧/写之前固定 Sleep(500)，不是 200ms。
        // 逐帧对齐时这个时序也必须一致；500ms 必须在 **2E 之前**。
        await new Promise((r) => setTimeout(r, 500));
        for (let attempt = 0; ; attempt++) {
            try {
                const resp = assertPositive(await this.link.request(req, { timeoutMs: 8000 }), '写入');
                if (resp[0] !== 0x6e || resp.length < 3 || resp[1] !== hi || resp[2] !== lo) {
                    throw new UdsError(`写入响应不匹配：期望 6E ${hi.toString(16).padStart(2, '0')} ${lo.toString(16).padStart(2, '0')}，实得 ${bytesToHex(resp)}`);
                }
                return resp;
            } catch (e) {
                const nrc = e instanceof UdsError ? e.nrc : undefined;
                // 0x31 = 请求超出范围：典型原因是会话掉了/未在扩展会话 → 重进会话再试
                if (nrc === 0x31 && attempt === 0) {
                    await this.enterExtendedSession();
                    continue;
                }
                // 瞬时失败（无响应/0x21 太频繁/0x22 条件不满足/0x78 等）：等 2 秒重试一次，
                // 与标准逐节点写入的重试语义一致
                if (attempt === 0 && (e instanceof Elm327Error || nrc === 0x21 || nrc === 0x22 || nrc === 0x10)) {
                    await new Promise((r) => setTimeout(r, 2000));
                    await this.enterExtendedSession();
                    continue;
                }
                throw e;
            }
        }
    }

    async readDtc() {
        // 0x19 02 FF = reportDTCByStatusMask（全部）
        const resp = assertPositive(await this.link.request(new Uint8Array([0x19, 0x02, 0xff])), '读故障码');
        if (resp[0] !== 0x59 || resp[1] !== 0x02) {
            throw new UdsError(`读故障码响应服务不匹配：${bytesToHex(resp.slice(0, 2))}`);
        }
        return parseDtcList(resp);
    }

    /**
     * 读故障冻结帧快照（19 04 reportDTCSnapshotRecordByDTCNumber）。
     * 应答 = 59 04 <DTC3> <记录号> <数据…>；参数位置由 dtc-snapshots.json 的偏移给出。
     *
     * ⚠️ 请求与车端已验证行为**逐字节一致**：`19 04 00 00 00 00`（DTC 全 0 + 记录号 0）。
     *    车端已验证行为对同一模块的所有快照参数都用这一条命令；此前我们按点击的 DTC 拼
     *    `19 04 <hi> <lo> 00 00`，属无实证的自创路径（2026-10-18 按车端已验证行为对齐）。
     */
    async readDtcSnapshot() {
        const resp = assertPositive(
            await this.link.request(new Uint8Array([0x19, 0x04, 0x00, 0x00, 0x00, 0x00]), { timeoutMs: 5000 }),
            '读冻结帧');
        if (resp[0] !== 0x59 || resp[1] !== 0x04) {
            throw new UdsError(`冻结帧响应服务不匹配：${bytesToHex(resp.slice(0, 2))}`);
        }
        return resp;
    }

    async clearDtc() {
        const resp = assertPositive(await this.link.request(new Uint8Array([0x14, 0xff, 0xff, 0xff])), '清故障码');
        if (resp[0] !== 0x54) throw new UdsError(`清码响应服务不匹配：${bytesToHex(resp.slice(0, 1))}`);
        return resp;
    }

    /**
     * 安全访问：请求种子 + 发送密钥。
     * 952/949 用 0x03/0x04，密钥是 5 位 PIN 的 BCD（`02 27 04 <12 34 05>`）；
     * 0x05/0x06 是服务器算的，我们不碰。
     *
     * 与车端已验证行为对齐的两点：
     *   1. 种子全 0 = ECU 已解锁 → **不再发密钥**（车端已验证行为直接当成功返回，
     *      否则 27 04 会被 NRC 0x24「请求顺序错误」拒掉）；
     *   2. 密钥就是把 5 位数字按 BCD 拼成 3 字节（`022704` + 5 位数字），与 `pinToKeyBcd` 一致。
     *
     * @returns {{alreadyUnlocked?: boolean, seed?: number[]}}
     */
    async securityAccess(pin) {
        const seed = assertPositive(await this.link.request(new Uint8Array([0x27, 0x03])), '取种子');
        if (seed[0] !== 0x67 || seed[1] !== 0x03) throw new UdsError('取种子响应异常');
        const seedBytes = Array.from(seed.slice(2));
        if (seedBytes.length && seedBytes.every((b) => b === 0)) {
            return { alreadyUnlocked: true, seed: seedBytes };
        }
        const key = pinToKeyBcd(pin);
        const resp = assertPositive(await this.link.request(new Uint8Array([0x27, 0x04, ...key])), '送密钥');
        if (resp[0] !== 0x67 || resp[1] !== 0x04) {
            throw new UdsError(`送密钥响应异常：${bytesToHex(resp.slice(0, 2))}`);
        }
        return resp;
    }

    // ---- PROXI 专用 ----

    /** 读某模块的 PROXI 写入计数器 */
    async readProxiWriteCounter() {
        const d = await this.readDataByIdentifier(DID.PROXI_WRITE_COUNTER);
        if (!d || !d.length) return null;
        // 源数据（params_all.tsv 的 `PROXI configuration write counter`）里 NumOfBytes=1，
        // 正常就是单字节。此前对多字节按**小端**装配，2 字节 `00 0C` 会算成 3072。
        // 现在：单字节直取；多字节按大端（与全项目其他数值口径一致）。
        if (d.length === 1) return d[0];
        let v = 0;
        for (const b of d) v = v * 256 + b;
        return v;
    }

    async readProxi() {
        return this.readDataByIdentifier(DID.PROXI_DATA1);
    }

    async readProxiAll() {
        // ⚠️ 顺序读，不要 Promise.all —— 串口半双工，并发会串帧（2026-10-15 修复）
        const data1 = await this.readDataByIdentifier(DID.PROXI_DATA1);
        const data2 = await this.readDataByIdentifier(DID.DATA2);
        const data3 = await this.readDataByIdentifier(DID.DATA3);
        return { data1, data2, data3 };
    }

    /**
     * 对齐前言 —— 与标准流程步骤 0 **逐条一致**：
     *   `03 22 20 23` 读 DATA1
     *   `03 22 20 24` 读 DATA1S   ← 我们此前没有
     *   `02 3E 00`    TesterPresent ← 我们此前没有
     * 之后才进入逐节点的 `Sleep(200) → 2E 20 23 → 22 10 2A → 22 40 AA`。
     *
     * DATA1S 语义尚未深挖（名称来自标准流程字符串 `DATA1S:`），先采集进日志，
     * 不参与判定 —— 拿到实车样本后再定它的用途。
     */
    async alignPrelude() {
        const data1 = await this.readDataByIdentifier(DID.PROXI_DATA1);
        let data1s = null;
        try {
            data1s = await this.readDataByIdentifier(DID.PROXI_DATA1S);
        } catch (e) {
            // 部分模块可能不支持 0x2024 —— 不致命，记下继续
            data1s = null;
        }
        // TesterPresent 保持会话（有些 ECU 不回，允许空）
        await this.testerPresent().catch(() => { });
        return { data1, data1s };
    }

    async writeProxi(data1) {
        return this.writeDataByIdentifier(DID.PROXI_DATA1, data1);
    }

    /**
     * 按节点回读校验（DID 0x102A）。
     * 响应固定 12 字节：62 10 2A + 9 数据 = 3 组 [标志, 字节号, 异或掩码]，
     * 差异组 (字节号, 异或掩码) 位于数据 [1,2] / [4,5] / [7,8]。
     * 字节号非 0 且掩码非 0 视为有效差异组，指出该节点存储块与基准块的差异位置——
     * 对齐判定的主依据。`expected` 传基准块：基准值 ⊕ 掩码 = 实际存储值。
     *
     * ⚠️ 字节号基准（BYTE_INDEX_BASE）：默认按 **1-based** 解释（`expected[n-1]`），
     *    即字节号 1 = 块内第 1 字节。此基准来自对方缓冲语义推断，**尚未实车验证**。
     *    若实车发现差异字节整体偏一位，改这个常量即可，不要改解析槽位。
     */
    async verifyProxi(expected) {
        // 标准写入序列：Sleep(200) → 2E 20 23 → 22 10 2A → 22 40 AA
        //   Sleep(200) 与 2E 20 23 在 writeDataByIdentifier（写之前）
        //   本函数只负责 22 10 2A + 22 40 AA
        // 车端已验证行为：空/短应答 → Sleep(2000) → 重读一次
        let resp = null;
        for (let attempt = 0; ; attempt++) {
            try {
                resp = assertPositive(await this.link.request(new Uint8Array([0x22, 0x10, 0x2A])), '回读校验');
            } catch (e) {
                if (attempt === 0) {
                    await new Promise((r) => setTimeout(r, 2000));
                    continue;
                }
                throw e;
            }
            if (resp && resp.length >= 12) {
                // 迟到的上一条 62 20 23（289 字节）也 >=12，必须校验服务/DID 才能避免假判定
                if (resp[0] === 0x62 && resp[1] === 0x10 && resp[2] === 0x2a) break;
                throw new UdsError(`回读校验响应不匹配：${bytesToHex(resp.slice(0, 3))}`);
            }
            if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 2000));
                continue;
            }
            throw new UdsError(`回读校验应答不完整：${resp ? bytesToHex(resp) : '(空)'}`);
        }
        const d = resp.slice(3);
        const diffs = [];
        // 3 组差异槽位：每组 3 字节 [标志, 字节号, 异或掩码]，(字节号, 掩码) 在 [1,2]、[4,5]、[7,8]
        for (const [idxPos, maskPos] of [[1, 2], [4, 5], [7, 8]]) {
            const n = d[idxPos];
            const m = d[maskPos];
            if (n && m) {
                // 字节号 → 数组下标。基准见上方注释；越界时不静默算错，标记为无效。
                const idx = n - PROXI_BYTE_INDEX_BASE;
                const inRange = expected != null && idx >= 0 && idx < expected.length;
                const want = inRange ? expected[idx] : null;
                diffs.push({
                    byte: n,
                    xorMask: m,
                    got: want === null ? null : (want ^ m),
                    want,
                    // 越界 = 字节号基准或块长口径不符，必须上车看原始数据再判
                    indexOutOfRange: expected != null && !inRange,
                });
            }
        }
        // 校验后补发 22 40 AA（写入序列的第三条命令，与标准流程一致）
        await this.link.request(new Uint8Array([0x22, 0x40, 0xAA]), { timeoutMs: 3000 })
            .catch(() => {});
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
