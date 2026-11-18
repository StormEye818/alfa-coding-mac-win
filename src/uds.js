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

import { bytesToHex, hexToBytes, Elm327Error, ELM_TIMEOUT_MS } from './elm327.js';

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

/**
 * D4 读码超时（②等价路径，非 MES ①级对齐）：
 *  - 链路单段基准 = ELM_TIMEOUT_MS = 5000ms（elm327.js:16 现有常量）；
 *  - 连续帧背靠背档 = ATST03 = 12ms（MES 5.5 协议文档 docs/05-protocol.md:40
 *    「ATST03=12ms 连续帧背靠背」；elm327.js:164 同口径）；
 *  - 实车最大应答 = 859B ≈ 108 帧（本文件 parseDtcList 注释的 IAW 10JA 日志）。
 * 推导：T = 5000 + 108 × 12 = 6296ms。不是拍脑袋选整数档，也不改判定数据。
 */
const DTC_READ_TIMEOUT_MS = ELM_TIMEOUT_MS + 108 * 12;

/**
 * D2 记录长度字典（③扩展自身的正确性，不称对齐）：
 * UDS 19 02 FF 标准 = 4 字节/条（<DTC高><DTC低><FTB><状态>）；
 * MES 5.5 协议文档 docs/05-protocol.md:56-57 同口径。legacy 3 字节/条只在
 * 调用方显式给出 recordBytes=3 或模块字典登记为 3 时启用。
 * 严禁按 payload % 4 / % 3 整除猜测 —— 3B/条且条数为 4 倍数时会被误判成 4B。
 */
const DTC_RECORD_BYTES = Object.freeze({ STANDARD: 4, LEGACY: 3 });
/** 952/949 平台 dtc.json 的 38 模块均为 UDS 标准 4 字节；新增 legacy 模块必须在此登记。 */
const DTC_RECORD_BYTES_BY_MODULE = Object.freeze([
    'AAML1', 'AAMR1', 'ABG28', 'ABSMMKC1', 'ADBLU1', 'AMP2', 'ANC1',
    'BODY30', 'BODY33', 'BODY33V2', 'CDCM1', 'CLIMA33', 'CNAV13', 'CSWM2',
    'CSWM5', 'DASH29', 'DASH29TFT', 'DASM1', 'DTCM4', 'EMCM1X', 'EPSZFX1',
    'ESM1X', 'HALF1', 'HDLGHT6', 'IAW10JAX', 'JTDM23GP', 'LRBSS1',
    'MED17.3.5', 'MED17.3.5S', 'PARKSEN14', 'PARKSEN8', 'PLGM1', 'RFH30',
    'SLCK2', 'TBM1', 'TTM1', 'TVM1', 'ZF8HP50',
].reduce((m, k) => { m[k] = DTC_RECORD_BYTES.STANDARD; return m; }, {}));

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

    /**
     * @param {{module?: string, recordBytes?: 3|4}} [opts]
     *   module → 从 DTC_RECORD_BYTES_BY_MODULE 字典取条长；显式 recordBytes 优先。
     *   两者都不给时按 UDS 标准 4 字节（不是整除猜测）；legacy 模块必须显式声明。
     */
    async readDtc({ module, recordBytes } = {}) {
        // 0x19 02 FF = reportDTCByStatusMask（全部）。
        // FF 会把「本周期自检未运行」的定义项（status=0x40）也带回来——健康车一次能回
        // 200+ 条，**不是故障**；parseDtcList 用 stored 位区分，UI 只展示真正存储过的。
        // 859B/108 帧应答：用由 ELM_TIMEOUT_MS + ATST03×帧数 推导的超时（D4），
        // 不再用默认 5s（elm327.js:16）。
        const resp = assertPositive(
            await this.link.request(new Uint8Array([0x19, 0x02, 0xff]), { timeoutMs: DTC_READ_TIMEOUT_MS }),
            '读故障码');
        if (resp[0] !== 0x59 || resp[1] !== 0x02) {
            throw new UdsError(`读故障码响应服务不匹配：${bytesToHex(resp.slice(0, 2))}`);
        }
        return parseDtcList(resp, { module, recordBytes });
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
     * 只读 DATA3（`22 40 A2`）。
     *
     * 用途：当调用方只需要 DATA3 时，直接使用本方法；不要走 readProxiAll()。
     * readProxiAll() 会顺序读 DATA1（289B 多帧）→ DATA2 → DATA3 并把前两块丢弃，
     * 在半双工链路上多出两次无用的多帧往返（每帧含流控等待），慢 ECU 上会放大耗时。
     * MES 5.5 协议文档 docs/05-protocol.md:75,77 记载：前置读 DATA1+DATA1S+3E00，
     * 三读（DATA1/DATA2/DATA3）的用途是三者比对，不是取其中一块后丢弃另外两块。
     *
     * 沿用 readDataByIdentifier 的既有 DID 校验、负响应与会话语义，不另造路径。
     * readProxiAll() 行为保持不变——其调用方可能需要三块一起用。
     */
    async readProxiData3() {
        return this.readDataByIdentifier(DID.DATA3);
    }

    /**
     * 对齐前言 —— 与标准流程步骤 0 **逐条一致**：
     *   `03 22 20 23` 读 DATA1
     *   `03 22 20 24` 读 DATA1S   ← 我们此前没有
     *   `02 3E 00`    TesterPresent ← 我们此前没有
     * 之后才进入逐节点的 `Sleep(500) → 2E 20 23 → 22 10 2A → 22 40 AA`。
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
        // 标准写入序列：Sleep(500) → 2E 20 23 → 22 10 2A → 22 40 AA
        //   Sleep(500) 与 2E 20 23 在 writeDataByIdentifier（写之前）；500ms 已对照块写入口核实（源 36873 Thread.Sleep(500)）
        //   本函数只负责 22 10 2A + 22 40 AA
        // 车端已验证行为：空/短应答 → Sleep(2000) → 重读一次。
        // ⚠️ 半双工串口没有请求标签：超时后迟到的 62 20 23（289 字节）同样 >=12 字节，
        //    必须校验服务 + DID；**不匹配也要重读一次**，否则一次串帧就被判成节点未对齐。
        let resp = null;
        let mismatch = '';
        for (let attempt = 0; ; attempt++) {
            try {
                resp = assertPositive(await this.link.request(new Uint8Array([0x22, 0x10, 0x2A])), '回读校验');
                if (resp && resp.length >= 12 && resp[0] === 0x62 && resp[1] === 0x10 && resp[2] === 0x2a) {
                    mismatch = '';
                    break;
                }
                mismatch = resp && resp.length >= 12
                    ? `回读校验响应不匹配：${bytesToHex(resp.slice(0, 3))}`
                    : `回读校验应答不完整：${resp ? bytesToHex(resp) : '(空)'}`;
            } catch (e) {
                if (attempt === 0) {
                    await new Promise((r) => setTimeout(r, 2000));
                    continue;
                }
                throw e;
            }
            if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 2000));
                continue;
            }
            throw new UdsError(mismatch);
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
        // A2：校验后补发 22 40 AA（写入序列第三条命令）。MES 侧仅文档级证据
        // （docs/05-protocol.md:95，②级）——修的目标是「不静默」：把正响应/NRC/异常
        // 全部记录并暴露给调用方，不再 .catch(()=>{}) 吞掉。
        // 不强制抛错打断对齐主流程：这条是辅助校验，失败由调用方决定是否升级。
        let aux;
        try {
            const auxResp = await this.link.request(new Uint8Array([0x22, 0x40, 0xAA]), { timeoutMs: 3000 });
            const nrc = auxResp && auxResp[0] === 0x7f && auxResp.length >= 3 ? auxResp[2] : undefined;
            aux = {
                ok: !!(auxResp && auxResp[0] === 0x62),
                nrc,
                nrcText: nrc !== undefined ? (NRC[nrc] || `NRC 0x${nrc.toString(16)}`) : undefined,
                raw: auxResp ? bytesToHex(auxResp) : '(空)',
                error: null,
                at: Date.now(),
            };
        } catch (e) {
            aux = {
                ok: false,
                nrc: e instanceof UdsError ? e.nrc : undefined,
                nrcText: e instanceof UdsError ? e.nrcText : undefined,
                raw: '(无应答)',
                error: (e && e.message) ? e.message : String(e),
                at: Date.now(),
            };
        }
        this.lastProxiAuxCheck = aux;
        if (typeof this.onProxiAuxCheck === 'function') {
            try { this.onProxiAuxCheck(aux); } catch { /* 回调异常不影响主判定 */ }
        }
        return {
            ok: diffs.length === 0, diffs, raw: d, auxCheck: aux,
            // A2 显式失败标记（供上层/门禁判定）：22 40 AA 失败必须为 false，
            // 不能再只靠一个没人看的 catch 把这条辅助校验吞掉。
            verifyMarker40AA: aux.ok,
        };
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

/**
 * 0x19 响应 → DTC 列表。
 * DTC 状态字节（ISO 14229-1 DtcStatusOfDTC）各位含义：
 *   bit0 testFailed · bit1 testFailedThisOperationCycle · bit2 pendingDTC
 *   bit3 confirmedDTC · bit4 testNotCompletedSinceLastClear
 *   bit5 testFailedSinceLastClear · bit6 testNotCompletedThisOperationCycle
 *   bit7 warningIndicatorRequested
 * active = **当前活跃**（testFailed | pendingDTC）。
 * confirmedDTC 只表示"故障已被确认并存储"，测试已通过后仍会保持置位 ——
 * 它属于「历史/已存储」，不能算当前故障（否则清码前的旧记录会被当成正在发生）。
 *
 * ⚠️ 记录长度是 **4 字节/条**（UDS 标准）：`<DTC高> <DTC低> <FTB失败类型字节> <状态>`。
 * 实车证据（2026-10-29 发动机电脑 IAW 10JA，`19 02 FF` 应答 859 字节）：
 * `59 02 CF` 之后每 4 字节一条，且按高 16 位查车端定义表逐条命中
 * （0x1E47=Knock sensor 1、0x0328/0327/0325=Knock sensor、0x2B2F=Electric fan speed 1）。
 * 此前按 3 字节一条切，错位后把常量填充字节 `00 40` 切成了「P0040 · 状态 0x03」这类
 * 幽灵故障 —— 健康车也显示 110+ 条（ECU 对 FF 掩码会把全部"本周期自检未运行"的
 * 定义项带回来，状态 0x40，**不是故障**）。
 * D2：条长只能来自「显式 recordBytes / 模块字典 / UDS 标准默认 4」，
 * **严禁**用 payload % 4 / % 3 整除猜测 —— 3 字节/条且条数为 4 倍数时会被误判成 4B，
 * 整段错位。无字典且 payload 不按标准 4B 对齐时明确报错，不静默退回 3B。
 */
function parseDtcList(resp, opts) {
    // 59 02 <statusAvailabilityMask> [ <dtcHi> <dtcLo> <ftb> <status> ]...（UDS 4 字节/条）
    const out = [];
    if (!resp || resp.length < 4) return out;
    const explicit = (typeof opts === 'number')
        || !!(opts && typeof opts === 'object'
            && (opts.recordBytes != null || opts.stride != null || opts.module != null));
    const stride = resolveDtcRecordBytes(opts);
    const payload = resp.length - 3;
    if (payload % stride !== 0) {
        throw new UdsError(
            `DTC 记录长度不匹配：payload=${payload}B，条长=${stride}B。` +
            '请显式传 recordBytes（3=legacy / 4=UDS 标准）或带字典的 module；禁止整除猜测');
    }
    // D2 应答结构自检（无显式条长时）：3B/条被当成 4B 时，3B 记录的状态字节会错位到
    // FTB 位。真车样本（IAW 10JA 859B）与模拟车的 FTB 恒为 0x00；若按 4B 解析后
    // 多数记录 FTB 非 0，说明条长错位，明确报错要求显式 recordBytes，不许静默出错成绩单。
    if (!explicit && stride === DTC_RECORD_BYTES.STANDARD) {
        let nonzeroFtb = 0, count = 0;
        for (let i = 3; i + stride <= resp.length; i += stride) {
            count++;
            if (resp[i + 2] !== 0) nonzeroFtb++;
        }
        if (count > 1 && nonzeroFtb * 2 > count) {
            throw new UdsError(
                `DTC 应答结构自检失败：按 UDS 标准 4B 解析时 ${nonzeroFtb}/${count} 条 FTB 非 0` +
                '（疑似 legacy 3B 记录错位到 FTB 位）。请显式传 recordBytes=3；禁止整除猜测');
        }
    }
    for (let i = 3; i + stride <= resp.length; i += stride) {
        const hi = resp[i], lo = resp[i + 1];
        const ftb = stride === 4 ? resp[i + 2] : 0;
        const st = resp[i + stride - 1];
        if (hi === 0 && lo === 0 && st === 0) continue;
        out.push({
            code: dtcCodeToString(hi, lo),
            raw: [hi, lo],
            ftb,
            status: st,
            testFailed: (st & 0x01) !== 0,
            pending: (st & 0x04) !== 0,
            confirmed: (st & 0x08) !== 0,
            active: (st & 0x05) !== 0,
            // stored = 带实际存储含义的位（bit0-3：当前失败/本周期失败过/待定/已确认）。
            // 只剩 bit4-7 的（如 0x40 = 本周期自检未运行）不是故障，界面不当作故障展示。
            stored: (st & 0x0f) !== 0,
        });
    }
    return out;
}

/** D2：条长解析 —— 显式参数 > 模块字典 > UDS 标准 4B；永不整除猜测。 */
function resolveDtcRecordBytes(opts) {
    let recordBytes;
    let module;
    if (typeof opts === 'number') recordBytes = opts;
    else if (opts && typeof opts === 'object') {
        recordBytes = opts.recordBytes != null ? opts.recordBytes : opts.stride;
        module = opts.module;
    }
    if (recordBytes != null) {
        if (recordBytes !== DTC_RECORD_BYTES.LEGACY && recordBytes !== DTC_RECORD_BYTES.STANDARD) {
            throw new UdsError(`非法 DTC 条长 ${recordBytes}：仅支持 3(legacy)/4(UDS 标准)`);
        }
        return recordBytes;
    }
    if (module != null) {
        const v = DTC_RECORD_BYTES_BY_MODULE[module];
        if (v == null) throw new UdsError(`模块 ${module} 无 DTC 条长字典条目：必须显式传 recordBytes`);
        return v;
    }
    return DTC_RECORD_BYTES.STANDARD;
}

/**
 * 例程状态轮询：ECU 回「忙」的负响应判定。
 *
 * ⚠️ 响应缓冲口径：车端已验证行为的缓冲带 1 字节长度前缀，NRC 在 array[3]
 *    （`array[1] == 127 && array[3] == 33/35`）。**我们的协议层已剥掉长度前缀**，
 *    所以 NRC 在 `resp[2]`。此前照搬 array[3] 写成 st[3]，`7F 31 21` 只有 3 字节，
 *    条件恒 false → 第一次「忙」就停止轮询，长例程（DPF 再生等）被误报为已结束。
 */
function isRoutineBusy(resp) {
    return !!resp && resp.length >= 3 && resp[0] === 0x7f
        && (resp[2] === 0x21 || resp[2] === 0x23);
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

export {
    Uds, UdsError, DID, NRC, pinToKeyBcd, parseDtcList, dtcCodeToString, isRoutineBusy,
    DTC_READ_TIMEOUT_MS, DTC_RECORD_BYTES, DTC_RECORD_BYTES_BY_MODULE,
};
