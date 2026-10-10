/**
 * Giulia (952) / Stelvio (949) 全车 ECU 模拟。
 *
 * 【接口契约】（harness.mjs 依赖以下三点，实现时必须保持）
 *   car.ecuByAddress(addr: number) -> ECU | null
 *       按 CAN 目标地址（tx）返回该 ECU；未知地址返回 null
 *   car.handle(ecu, payload: number[]) -> number[] | null
 *       处理一帧 UDS 请求，返回应答字节（无应答返回 null）
 *   car.snapshot() -> object
 *       返回整车状态，便于测试断言（各模块 PROXI 计数、里程表是否闪烁、DTC 等）
 *
 * 【必须模拟到的行为】
 *   1. 35 个模块（见 ../src/data/modules.json），各按 tx/rx 寻址，分 CCAN29 / BHCAN29 两条总线
 *   2. PROXI 配置块（DID 0x2023）：读、写、回读校验（DID 0x102A，返回差异字节）
 *      · 写入需 CRC-16/KERMIT 正确（对 DATA1[25..] 计算，5 位 ASCII 存 DATA1[6..10]）
 *      · CRC 不对则拒写（NRC）
 *      · 0x102A 的比对基准 = 车辆基准块（车身电脑当前 PROXI 内容）：
 *        响应差异组指出该模块存储块与基准不一致的位置（对齐判定的主依据）；
 *        写入车身电脑会刷新全车基准，写入某模块只改该模块的存储块
 *   3. 各模块的 PROXI 写入计数（DID 0x292E）：与车身电脑一致（辅助参考，非主判据）
 *   4. **里程表闪烁**：任一模块配置与车身电脑不一致 → 闪烁；全部一致 → 熄灭
 *   5. 故障码（0x19 读 / 0x14 清）：可读可清，带真实码值
 *   6. 可读参数（0x22 各 DID）：按 ../src/data/params.json 返回合理数值
 *   7. 执行器（0x2F）/ 例程（0x31）/ 写入（0x2E）：按 ../src/data/functions.json 的命令序列响应
 *   8. **业务规则**：如「保养券张数」禁止写入更大值（防回拨），返回 NRC 或静默忽略
 *   9. 未安装的节点（在场位为 0）不应被对齐，写入应失败或被忽略
 *  10. 各模块失败模式：可配置随机失败率，用于测试重试与错误提示
 *
 * 【不需要】与真车逐字节一致；只需让工具的刷写、执行、对齐流程得到与真车同类的反馈。
 */
import fs from 'fs';
import { ProxiBlock, crc16Kermit, CRC_DATA_START } from '../src/proxi.js';

const readJson = (name) =>
    JSON.parse(fs.readFileSync(new URL(`../src/data/${name}`, import.meta.url), 'utf8'));

/** DATA1 长度：与 src/mock-adapter.js、src/demo-link.js 的模拟保持一致 */
const PROXI_LENGTH = 289;
/** 车身电脑（BODY33/BODY30）的 PROXI 写入计数基准：各模块与它一致 = 已对齐 */
const BODY_COUNTER = 12;
/**
 * 初始块的研磨目标 CRC（5 位十进制 '20275'）。
 * DATA1[6..10] 既是 CRC ASCII 区，又落在对齐节点在场位（Byte1..16）之内，
 * 二者天然冲突；选定目标 CRC 使这 5 个数字节的位模式恰好给出一套合理的在场位，
 * 再对 DATA1[25..] 尾部研磨出该 CRC，使「CRC 自洽」与「在场位正确」同时成立。
 */
const CRC_TARGET = 16758;

/**
 * 本车配置：以下对齐节点视为未安装（其余非 excluded 节点均已安装）。
 * 注：startByte 落在 CRC 区（Byte7..11 = 内部 6..10）的节点，其在场位由 CRC 数字位决定。
 * ASCII 数字位特征（byte = 0x30 + d）：bit4-5 恒 1、bit6-7 恒 0，因此
 *   · mask 落在 bit6/7 的节点恒未安装（AMP/OCM/CDM/CMM）
 *   · mask 落在 bit4/5 的节点恒已安装（SRM 等，物理上标不了未安装）
 *   · SCRM(bit1) 与 VPAM(bit3) 同占内部[10]，ASCII 数字无法两者同时置 1
 *     → 汽油车取 SCRM 未安装、VPAM 已安装（与实车 CRC 14778 的位型一致）
 * 此清单须与 CRC_TARGET 的数字位一致（init 会断言核对）。
 */
const ABSENT_NODES = new Set([
    'Compact Disk Node (CDM)',                       // 无 CD 换碟机（bit7 恒 0，恰好一致）
    'Amplifier Node (AMP)',                          // 受 CRC 数字位约束只能取未安装（bit6 恒 0）
    'Selective Catalytic Reduction Module (SCRM)',   // 汽油车无 SCR；与 VPAM 同字节位冲突，取未安装
    'Rear Left Climate Control Node (RLCM)',         // 无后排独立空调
    'Additional Heater Node (CTM)',                  // 无驻车加热器
    'Driver monitoring system module (DMSM)',        // 无驾驶员监测
    'Passenger Occupant Classification Node (OCM)',  // 受 CRC 数字位约束只能取未安装（bit6 恒 0）
    'Left Blind Spot Sensor Node (LBSS)',            // 无盲区监测
    'Vehicle Tracking Module (VTM)',                 // 无车辆追踪
    'Collision Mitigation Module (CMM)',             // 无碰撞缓解（bit7 恒 0）
    'Drive Train Control Node (DTCM)',               // 后驱（无耦合控制）
    'Passenger Door Latch Module (PDML)',            // 受 CRC 数字位约束只能取未安装
    'Engine control Module 2 (ECM2)',                // 2.0T 单 ECU
    'Torque vectoring module (TVM)',                 // 无扭矩矢量
    'Active aerodynamic module Left (AAML)',         // 无主动空气动力
    'Active aerodynamic module Right (AAMR)',
    'Haptical Lane Feedback Node (HALF)',            // 无车道保持触觉反馈
    'Coupling Control Node (CCM)',                   // 后驱
    'Traffic message module (TMM)',                  // 无 TMC
]);
// 注：SRM（卫星收音）语义上本车没有，但它的 mask 0x20 落在 bit5（ASCII 数字恒 1），
// 数字位永远报「已安装」——放进清单只会自相矛盾，故留在已安装集合。

/** 默认初始未对齐的节点地址（ABS / EPS / DASM）：让里程表一开始就闪，便于测试对齐流程 */
const DEFAULT_MISALIGNED = ['28', '30', '2A'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 在场位解析（与 app.js / test/align.test.js 一致）："0101Present|0100Not present" */
function presenceInfo(node) {
    let mask = 0, presentVal = null, absentVal = null;
    for (const part of String(node.presence || '').split('|')) {
        const m = /^([0-9A-Fa-f]{4})(.*)$/.exec(part.trim());
        if (!m) continue;
        const maskByte = parseInt(m[1].slice(0, 2), 16);
        const val = parseInt(m[1].slice(2, 4), 16);
        mask |= maskByte;
        const label = m[2].trim();
        if (/^not\s/i.test(label)) absentVal = val; else presentVal = val;
    }
    return { mask, presentVal, absentVal };
}

/** 单字节喂入 CRC-16/KERMIT 状态机 */
function crc16Byte(crc, byte) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
    }
    return crc & 0xffff;
}

/**
 * 在 DATA1[25..] 尾部找 3 个自由字节，把 CRC 研磨成目标值。
 * CRC-16 是线性码，给定前缀状态后穷举 2 字节尾几乎必然命中。
 */
function grindCrc(bytes, target) {
    const len = bytes.length;
    for (let a = 0; a < 256; a++) {
        bytes[len - 3] = a;
        let crc = crc16Kermit(bytes, CRC_DATA_START, len - 2);
        for (let b = 0; b < 256; b++) {
            const c1 = crc16Byte(crc, b);
            for (let c = 0; c < 256; c++) {
                if (crc16Byte(c1, c) === target) {
                    bytes[len - 2] = b;
                    bytes[len - 1] = c;
                    return true;
                }
            }
        }
    }
    return false;
}

/** 数值规格：format 形如 "num[,小数位[,scale[,offset]]]"，缺失时回落到 spec 字段 */
function numScale(spec) {
    const f = String(spec.format || 'num').split(',');
    const dec = f[1] !== undefined && f[1] !== '' ? Number(f[1]) : (spec.decimals || 0);
    const scale = f[2] !== undefined && f[2] !== '' ? Number(f[2]) : (spec.scale || 1);
    const offset = f[3] !== undefined && f[3] !== '' ? Number(f[3]) : (spec.offset || 0);
    return { dec: Number.isFinite(dec) ? dec : 0, scale: Number.isFinite(scale) && scale !== 0 ? scale : 1, offset: Number.isFinite(offset) ? offset : 0 };
}

/** 物理值 → 原始值（小端编码用） */
function encodeNum(physical, spec) {
    const { dec, scale, offset } = numScale(spec);
    return Math.round((physical * Math.pow(10, dec) - offset) / scale);
}

/** 原始值 → 物理值（自测与换算校验用） */
function decodeNum(raw, spec) {
    const { dec, scale, offset } = numScale(spec);
    return (raw * scale + offset) / Math.pow(10, dec);
}

function toLeBytes(value, n) {
    const out = [];
    let v = Math.max(0, Math.round(value));
    for (let i = 0; i < n; i++) { out.push(v & 0xff); v >>>= 8; }
    return out;
}

function asciiBytes(text, n, pad = 0x20) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const c = text.charCodeAt(i);
        out.push(Number.isFinite(c) && i < text.length ? c : pad);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 模拟车
// ---------------------------------------------------------------------------

export class GiuliaCar {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.failRate = opts.failRate || 0;      // 0..1，随机返回 NRC 22/78
        this.rng = opts.rng || Math.random;
        /**
         * 写入不完整概率：模拟 EEPROM 部分字节没写进去 —— 写入仍回正响应，
         * 但回读校验 22 10 2A 会报出 (字节号, 异或掩码) 差异组（真实车的常见现象）。
         */
        this.partialWriteRate = opts.partialWriteRate || 0;
        this.partialWriteBytes = opts.partialWriteBytes || [87, 114, 201];   // 内部索引（Byte88/115/202，与出厂示意值同字节）
        this.platform = opts.platform || '952';
        this.bodyCode = this.platform === '949' ? 'BODY30' : 'BODY33';

        this.modulesData = readJson('modules.json');
        this.cablesData = readJson('cables.json');
        this.paramsData = readJson('params.json');
        this.dtcData = readJson('dtc.json');
        this.funcsData = readJson('functions.json');

        this.ecus = new Map();
        this.installed = new Map();      // 节点名 → 是否已安装（在场位）
        this.excluded = new Map();       // 节点名 → 是否 excluded（其它平台专属）
        this.writeRules = new Map();     // DID → functions.json 的 input 规格
        this.ioRules = new Map();        // 控制标识 → functions.json 的 input 规格
        this.init(opts);
    }

    init(opts = {}) {
        const nodes = this.modulesData.alignmentNodes;

        // ---- 1) 在场位意图（excluded 视为未安装） ----
        for (const n of nodes) {
            this.excluded.set(n.name, !!n.excluded);
            const want = !n.excluded && !ABSENT_NODES.has(n.name);
            this.installed.set(n.name, want);
        }

        // ---- 2) 构造 DATA1：在场位 + CRC 研磨 ----
        const bytes = new Uint8Array(PROXI_LENGTH);
        for (const n of nodes) {
            const idx = n.startByte - 1;                 // 社区编号（1-based） → 内部索引
            if (idx >= 6 && idx <= 10) continue;         // CRC ASCII 区（内部 6..10 = Byte7..11），稍后由数字位决定
            const { mask, presentVal, absentVal } = presenceInfo(n);
            if (!mask || presentVal === null) continue;
            const on = this.installed.get(n.name);
            const bits = on ? presentVal : ((absentVal !== null && absentVal !== presentVal) ? absentVal : 0);
            bytes[idx] = (bytes[idx] & ~mask) | bits;
        }
        // CRC 区先放目标数字，再研磨数据尾部使计算值等于目标
        const digits = String(CRC_TARGET).padStart(5, '0');
        for (let i = 0; i < 5; i++) bytes[6 + i] = digits.charCodeAt(i);
        // 数据区给一点“出厂”示意值（与 demo-link 同位置，便于肉眼核对）
        // 出厂值按社区编号写入（内部索引 = 编号 - 1）；Race Type1=0xAC 在 Byte88 → 内部[87]
        bytes[57] = 0x00; bytes[58] = 0x00; bytes[65] = 0x00; bytes[87] = 0xAC;
        bytes[114] = 0x14; bytes[148] = 0x04; bytes[155] = 0x10; bytes[158] = 0x00;
        bytes[165] = 0x04; bytes[176] = 0x00; bytes[201] = 0x00;
        if (!grindCrc(bytes, CRC_TARGET)) {
            throw new Error('PROXI 初始块 CRC 研磨失败');
        }
        const blk = new ProxiBlock(bytes);
        blk.seal();                                     // 计算值 = 目标，数字位不变
        if (!blk.verify().ok) throw new Error('PROXI 初始块 CRC 校验未通过');
        this.bodyProxi = Uint8Array.from(blk.bytes);

        // ---- 3) 以块内实际位为准回读在场位（内部 6..10 由 CRC 数字位决定） ----
        for (const n of nodes) {
            const { mask, presentVal } = presenceInfo(n);
            if (!mask || presentVal === null) continue;
            const on = ((this.bodyProxi[n.startByte - 1] & mask) === presentVal) && !n.excluded;
            this.installed.set(n.name, on);
        }
        // 断言：CRC 区节点的数字位在场位必须与 ABSENT_NODES 意图一致。
        // 不一致 = CRC_TARGET 与清单配错（或字节号口径又错位），直接起不来，别拖到对齐测试才炸。
        for (const n of nodes) {
            const idx = n.startByte - 1;
            if (idx < 6 || idx > 10) continue;
            const want = !n.excluded && !ABSENT_NODES.has(n.name);
            const got = !!this.installed.get(n.name);
            if (want !== got) {
                throw new Error(
                    `CRC 数字位与未安装清单冲突：${n.name}（Byte${n.startByte}）`
                    + ` 清单=${want ? '已安装' : '未安装'} 数字位=${got ? '已安装' : '未安装'}`
                    + `——请调整 CRC_TARGET（当前 ${CRC_TARGET}）或 ABSENT_NODES`
                );
            }
        }

        // ---- 4) 建立 ECU（模块 tx + 对齐节点 addr 全部可寻址） ----
        for (const m of this.modulesData.modules) {
            const addr = parseInt(m.tx, 16) & 0xff;
            const ecu = this.#ecu(addr);
            ecu.modules.push(m.code);
            if (!ecu.bus) ecu.bus = m.bus;
        }
        for (const n of nodes) {
            const addr = parseInt(n.addr, 16) & 0xff;
            const ecu = this.#ecu(addr);
            ecu.nodes.push(n);
        }

        // ---- 5) 每个 ECU 的初始状态 ----
        for (const ecu of this.ecus.values()) {
            ecu.proxiStored = Uint8Array.from(this.bodyProxi);
            // 基准块（0x102A 比对参照）= 车辆基准 = 车身电脑当前 PROXI
            ecu.proxiExpected = Uint8Array.from(this.bodyProxi);
            ecu.writeCounter = BODY_COUNTER;
            ecu.coupons = 5;                    // 保养券张数初值
            ecu.serviceInterval = 255;          // 保养周期（原始值，500km/档）
            ecu.writes = new Map();
            ecu.unlocked = false;
            ecu.seed = [0x12, 0x34];
            ecu.dtcs = this.#buildDtcs(ecu);
            ecu.paramIndex = this.#buildParams(ecu);
        }
        this.bodyEcu = this.#ecu(parseInt(this.modulesData.modules.find((m) => m.code === this.bodyCode).tx, 16));

        // ---- 6) 默认几处未对齐（计数少 1 + 配置有旧字节）→ 里程表闪烁 ----
        // 注意：只改 proxiStored（存储块），proxiExpected 保持车辆基准，
        // 这样 22 10 2A 会如实报出这些节点与基准的差异。
        const mis = (opts.misaligned || DEFAULT_MISALIGNED).map((a) => (typeof a === 'number' ? a : parseInt(a, 16)));
        for (const addr of mis) {
            const ecu = this.ecus.get(addr & 0xff);
            if (!ecu) continue;
            ecu.writeCounter = BODY_COUNTER - 1;
            const stale = Uint8Array.from(this.bodyProxi);
            stale[88] ^= 0xff;                  // 旧配置与车身电脑不一致
            const sb = new ProxiBlock(stale);
            sb.seal();
            ecu.proxiStored = Uint8Array.from(sb.bytes);
        }

        // ---- 7) functions.json 的输入规格 → 写入/执行校验规则 ----
        for (const cat of this.funcsData.categories || []) {
            for (const it of cat.items || []) {
                if (!it.input || !it.commands) continue;
                for (const part of String(it.commands).split(',')) {
                    const raw = part.trim();
                    // 命令模板首字节是长度，剥掉后才是 UDS 载荷（2E/2F…）
                    const body = raw.slice(2);
                    const m2e = /^2E([0-9A-Fa-f]{4})/i.exec(body);
                    if (m2e && !this.writeRules.has(parseInt(m2e[1], 16))) {
                        this.writeRules.set(parseInt(m2e[1], 16), it.input);
                    }
                    const m2f = /^2F([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/i.exec(body);
                    if (m2f && !this.ioRules.has(parseInt(m2f[1] + m2f[2], 16))) {
                        this.ioRules.set(parseInt(m2f[1] + m2f[2], 16), it.input);
                    }
                }
            }
        }

        this.log(`模拟车就绪：${this.ecus.size} 个可寻址 ECU，DATA1 ${PROXI_LENGTH} 字节，`
            + `已安装节点 ${[...this.installed.values()].filter(Boolean).length} 个`);
    }

    #ecu(addr) {
        addr = addr & 0xff;
        if (!this.ecus.has(addr)) {
            this.ecus.set(addr, {
                addr,
                modules: [],
                nodes: [],
                bus: null,
            });
        }
        return this.ecus.get(addr);
    }

    /** 该 ECU 的故障码：取其第一个在 dtc.json 里有条目的模块，取前几条真实码值 */
    #buildDtcs(ecu) {
        for (const code of ecu.modules) {
            const table = this.dtcData.modules && this.dtcData.modules[code];
            if (!table) continue;
            const keys = Object.keys(table).slice(0, 3);
            return keys.map((k, i) => ({
                raw: [parseInt(k.slice(0, 2), 16) & 0xff, parseInt(k.slice(2, 4), 16) & 0xff],
                status: i === 0 ? 0x09 : 0x08,
                code: k,
                name: table[k].name,
            }));
        }
        return [];
    }

    /** 该 ECU 的可读参数索引：DID → params.json 条目（同 DID 多条时取第一条） */
    #buildParams(ecu) {
        const idx = new Map();
        for (const code of ecu.modules) {
            const list = (this.paramsData.modules && this.paramsData.modules[code]) || [];
            for (const it of list) {
                const did = parseInt(it.did, 16);
                if (!idx.has(did)) idx.set(did, it);
            }
        }
        return idx;
    }

    // ---- 契约接口 ----

    /** 按 CAN 目标地址（tx）取 ECU；未知地址返回 null */
    ecuByAddress(addr) {
        return this.ecus.get((Number(addr) || 0) & 0xff) || null;
    }

    /** 处理一帧 UDS 请求，返回应答字节（无应答返回 null） */
    handle(ecu, payload) {
        const p = Array.from(payload || []);
        if (!ecu || p.length === 0) return [0x7f, 0x00, 0x13];
        const svc = p[0];

        // 失败模式：随机返回 NRC 22（条件不满足）或 78（pending），用于测试重试与错误提示
        if (this.failRate > 0 && svc !== 0x3e && this.rng() < this.failRate) {
            const nrc = this.rng() < 0.5 ? 0x22 : 0x78;
            this.log(`[失败模式] 0x${svc.toString(16)} → NRC 0x${nrc.toString(16)}`);
            return [0x7f, svc, nrc];
        }

        switch (svc) {
            case 0x3e:  // 在线保活：0x80 为抑制正响应
                return (p[1] & 0x80) ? null : [0x7e, p[1] || 0x00];
            case 0x10:  // 会话控制
                return [0x50, p[1] || 0x01];
            case 0x22:
                return this.#readDid(ecu, p);
            case 0x2e:
                return this.#writeDid(ecu, p);
            case 0x2f:
                return this.#ioControl(ecu, p);
            case 0x31:
                return this.#routine(ecu, p);
            case 0x19:
                return this.#readDtc(ecu, p);
            case 0x14:
                return this.#clearDtc(ecu, p);
            case 0x27:
                return this.#security(ecu, p);
            default:
                return [0x7f, svc, 0x11];       // 服务不支持
        }
    }

    /**
     * 整车状态快照。
     * odoFlash：任一已安装节点与车身电脑（配置或写入计数）不一致 → true，即里程表闪烁。
     */
    snapshot() {
        const body = this.bodyEcu;
        const nodes = {};
        let odoFlash = false;
        for (const n of this.modulesData.alignmentNodes) {
            const ecu = this.ecus.get(parseInt(n.addr, 16) & 0xff);
            const installed = !!this.installed.get(n.name);
            const excluded = !!this.excluded.get(n.name);
            const counter = ecu ? ecu.writeCounter : null;
            const configMatches = ecu
                ? ecu.proxiStored.length === body.proxiStored.length
                    && ecu.proxiStored.every((b, i) => b === body.proxiStored[i])
                : false;
            const aligned = installed && counter === body.writeCounter && configMatches;
            if (installed && !aligned) odoFlash = true;
            nodes[n.name] = {
                addr: n.addr,
                bus: n.baud === 125 ? 'BHCAN29' : 'CCAN29',
                excluded,
                installed,
                counter,
                configMatches,
                aligned,
            };
        }

        const modules = {};
        for (const m of this.modulesData.modules) {
            const ecu = this.ecus.get(parseInt(m.tx, 16) & 0xff);
            modules[m.code] = {
                name: m.name,
                tx: m.tx,
                rx: m.rx,
                bus: m.bus,
                cable: (this.cablesData.modules[m.code] || {}).cable || 'none',
                writeCounter: ecu ? ecu.writeCounter : null,
                aligned: ecu ? ecu.writeCounter === body.writeCounter
                    && ecu.proxiStored.every((b, i) => b === body.proxiStored[i]) : false,
                dtc: (ecu ? ecu.dtcs : []).map((d) => d.code),
                coupons: ecu ? ecu.coupons : null,
            };
        }

        return {
            odoFlash,
            bodyCounter: body.writeCounter,
            proxiLength: PROXI_LENGTH,
            crc: CRC_TARGET,
            modules,
            nodes,
            couponCount: this.ecus.get(0x60) ? this.ecus.get(0x60).coupons : null,
        };
    }

    // ---- UDS 服务实现 ----

    #readDid(ecu, p) {
        const did = ((p[1] || 0) << 8) | (p[2] || 0);

        if (did === 0x2023) return [0x62, 0x20, 0x23, ...ecu.proxiStored];
        if (did === 0x102A) return this.#verifyProxi(ecu);
        if (did === 0x292E) return [0x62, 0x29, 0x2e, ecu.writeCounter & 0xff];
        if (did === 0x40A1 || did === 0x40A2) {
            return [0x62, p[1], p[2], ...new Array(32).fill(0)];
        }

        const entry = ecu.paramIndex.get(did);
        if (!entry) return [0x7f, 0x22, 0x31];       // 请求超出范围（没有这个 DID）
        return [0x62, p[1], p[2], ...this.#encodeParam(ecu, entry)];
    }

    /** 按 params.json 的 spec 生成合理数值（电压 12-14V、车速 0-200、转速 800-6000 等） */
    #encodeParam(ecu, entry) {
        const spec = entry.spec || {};
        const n = bytesOf(spec);
        const fmt = String(spec.format || 'num');
        const name = String(entry.name || '');

        if (fmt.startsWith('num')) {
            return toLeBytes(encodeNum(this.#pickPhysical(ecu, name, spec), spec), n);
        }
        if (fmt === 'str') {
            if (/vin/i.test(name)) return asciiBytes('ZAR95200001234567', n);
            if (/serial/i.test(name)) return asciiBytes('000123456789012', n);
            if (/spare|drawing|part number/i.test(name)) return asciiBytes('68275421AA', n);
            if (/hardware number/i.test(name)) return asciiBytes('51882345AB', n);
            if (/software number/i.test(name)) return asciiBytes('00010002003', n);
            if (/homologation/i.test(name)) return asciiBytes('e3*952', n);
            return asciiBytes('00000000000', n);
        }
        if (fmt === 'date') {
            // BCD 年月日（+1 字节备用）
            const out = [0x24, 0x06, 0x15, 0x00];
            return out.slice(0, Math.max(1, n));
        }
        if (fmt.startsWith('hex') || fmt === 'bits') {
            const out = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
            return out.slice(0, Math.max(1, n));
        }
        return new Array(Math.max(1, n)).fill(0);
    }

    /** 按参数名挑一个合理物理值（确定性，便于自测断言） */
    #pickPhysical(ecu, name, spec) {
        const n = name.toLowerCase();
        const unit = String(spec.unit || '').toLowerCase();
        if (/write counter/.test(n)) return BODY_COUNTER;
        if (/coupon|number of services/.test(n)) return ecu.coupons;
        if (/engine speed|rpm/.test(n) || (unit === 'rpm')) return 850;
        if (/vehicle speed/.test(n) || unit === 'km/h') return 0;
        if (/voltage|power supply/.test(n) || unit === 'v') return 13.8;
        if (/odometer|mileage/.test(n)) return 12345;
        if (/distance/.test(n)) return 2345;
        if (/temperature|temp/.test(n) || unit.includes('°c')) return 25;
        if (/days/.test(n) || unit === 'days') return 120;
        if (/%|status|sensitivity/.test(n) || unit === '%') return 50;
        if (/time|minute|hour|operating|functioning/.test(n)) return 100;
        if (/counter|startups|services/.test(n)) return 42;
        return 0;
    }

    /** 回读校验 DID 0x102A：存储块与车辆基准块（车身电脑当前 PROXI）逐字节比对 */
    #verifyProxi(ecu) {
        const exp = ecu.proxiExpected, got = ecu.proxiStored;
        const diffs = [];
        const n = Math.min(exp.length, got.length);
        for (let i = 0; i < n && diffs.length < 3; i++) {
            if (got[i] !== exp[i]) diffs.push({ byte: i + 1, xorMask: got[i] ^ exp[i] });
        }
        // 应答 13 字节：62 10 2A + 10 数据，差异组 (字节号, 异或掩码) 位于 [5,6]、[8,9]；
        // 第 3 组位于 [11,12]（与 src/uds.js 的槽位一致，需 16 字节应答）
        const data = new Array(diffs.length >= 3 ? 13 : 10).fill(0);
        const slots = [[5, 6], [8, 9], [11, 12]];
        diffs.forEach((d, i) => {
            data[slots[i][0]] = d.byte;
            data[slots[i][1]] = d.xorMask;
        });
        return [0x62, 0x10, 0x2a, ...data];
    }

    #writeDid(ecu, p) {
        const did = ((p[1] || 0) << 8) | (p[2] || 0);
        const data = p.slice(3);

        if (did === 0x2023) return this.#writeProxi(ecu, data);

        // —— 业务规则：保养券张数（SVCRST29 DID 2800）禁止写入更大值（防回拨）——
        if (did === 0x2800) {
            if (data.length < 1) return [0x7f, 0x2e, 0x13];
            const v = data[0];
            if (v > ecu.coupons) {
                this.log(`保养券张数拒写：${ecu.coupons} → ${v}（禁止更大值）`);
                return [0x7f, 0x2e, 0x31];
            }
            ecu.coupons = v;
            return [0x6e, 0x28, 0x00];
        }
        // 同样的防回拨规则：PROXI 写入计数禁止写入更大值
        if (did === 0x292E) {
            if (data.length < 1) return [0x7f, 0x2e, 0x13];
            if (data[0] > ecu.writeCounter) return [0x7f, 0x2e, 0x31];
            ecu.writeCounter = data[0];
            return [0x6e, 0x29, 0x2e];
        }

        // —— functions.json 带输入的写入：校验长度与取值范围 ——
        const rule = this.writeRules.get(did);
        if (rule) {
            if (rule.bytes && data.length !== rule.bytes) return [0x7f, 0x2e, 0x13];
            const bad = this.#validateInput(rule, data);
            if (bad) {
                this.log(`写入 DID 0x${did.toString(16)} 被拒：${bad}`);
                return [0x7f, 0x2e, 0x31];
            }
        }

        ecu.writes.set(did, data);
        return [0x6e, p[1], p[2]];
    }

    /** PROXI 配置块写入：CRC 校验 + 在场位校验 */
    #writeProxi(ecu, data) {
        if (data.length !== PROXI_LENGTH) return [0x7f, 0x2e, 0x13];
        let blk;
        try {
            blk = new ProxiBlock(data);
        } catch {
            return [0x7f, 0x2e, 0x13];
        }
        const v = blk.verify();
        if (!v.ok) {
            this.log(`PROXI 拒写：CRC 不符（存 ${v.stored} / 算 ${v.computed}）`);
            return [0x7f, 0x2e, 0x31];
        }
        // 在场位：地址上必须有已安装的非 excluded 节点，否则视为未安装/其它平台节点
        if (!this.#addrHasInstalledNode(ecu) && ecu !== this.bodyEcu) {
            this.log(`PROXI 拒写：地址 0x${ecu.addr.toString(16)} 无已安装节点`);
            return [0x7f, 0x2e, 0x31];
        }
        const prev = ecu.proxiStored;
        ecu.proxiStored = Uint8Array.from(data);
        // 基准块语义：写入车身电脑 → 刷新全车基准（各模块的 0x102A 参照）；
        // 写入某模块 → 只改该模块存储块，基准不变（存储 ≠ 基准即未对齐）
        if (ecu === this.bodyEcu) {
            for (const e of this.ecus.values()) e.proxiExpected = Uint8Array.from(data);
        }
        ecu.writeCounter = this.bodyEcu.writeCounter;   // 与车身电脑一致（辅助判据）
        // 写入不完整：个别字节保持旧值，回读校验将报出差异
        if (this.partialWriteRate > 0 && this.rng() < this.partialWriteRate) {
            for (const idx of this.partialWriteBytes) {
                if (idx < ecu.proxiStored.length) ecu.proxiStored[idx] = prev[idx];
            }
            this.log(`模拟写入不完整：字节 ${this.partialWriteBytes.join(',')} 未更新`);
        }
        this.log(`PROXI 已写入 0x${ecu.addr.toString(16)}（${data.length} 字节，计数 ${ecu.writeCounter}）`);
        return [0x6e, 0x20, 0x23];
    }

    #addrHasInstalledNode(ecu) {
        return ecu.nodes.some((n) => this.installed.get(n.name) && !n.excluded);
    }

    /** 输入规格校验：长度/范围/选项；通过返回 null，否则返回原因 */
    #validateInput(rule, data) {
        if (rule.kind === 'number') {
            const raw = data.reduce((a, b, i) => a + b * Math.pow(256, i), 0);
            const phys = decodeNum(raw, { format: rule.format || 'num', scale: rule.scale, offset: rule.offset, decimals: rule.decimals });
            if (rule.min !== undefined && phys < rule.min) return `小于下限 ${rule.min}`;
            if (rule.max !== undefined && phys > rule.max) return `大于上限 ${rule.max}`;
            return null;
        }
        if (rule.kind === 'enum' && Array.isArray(rule.options) && rule.options.length) {
            const okVals = new Set(rule.options.map((o) => o.value & (o.mask ?? 0xff)));
            for (const b of data) {
                if (b === 0xff) continue;               // 通配（如 VIN 的 *）
                if (!okVals.has(b & 0xff)) return `字节 0x${b.toString(16)} 不在可选值内`;
            }
        }
        return null;
    }

    /** 执行器 0x2F：正响应（回显控制参数） */
    #ioControl(ecu, p) {
        if (p.length < 4) return [0x7f, 0x2f, 0x13];
        const id = ((p[1] || 0) << 8) | (p[2] || 0);
        const rule = this.ioRules.get(id);
        if (rule) {
            const bad = this.#validateInput(rule, p.slice(3));
            if (bad) {
                this.log(`执行器 0x${id.toString(16)} 拒绝：${bad}`);
                return [0x7f, 0x2f, 0x31];
            }
        }
        this.log(`执行器测试 0x${id.toString(16)} 选项 0x${(p[3] || 0).toString(16)}`);
        return [0x6f, p[1], p[2], ...p.slice(3)];
    }

    /** 例程 0x31：正响应 71 <子功能> <例程号> 00 */
    #routine(ecu, p) {
        if (p.length < 4) return [0x7f, 0x31, 0x13];
        this.log(`例程 0x${(((p[2] || 0) << 8) | (p[3] || 0)).toString(16)} 子功能 0x${(p[1] || 0).toString(16)}`);
        return [0x71, p[1], p[2], p[3], 0x00];
    }

    /** 读故障码 0x19 02 FF：59 02 FF + [码高 码低 状态]…（码值取自 dtc.json） */
    #readDtc(ecu, p) {
        const sub = p[1] || 0;
        if (sub !== 0x02 && sub !== 0x01 && sub !== 0x03) return [0x7f, 0x19, 0x12];
        const out = [0x59, sub, 0xff];
        for (const d of ecu.dtcs) out.push(d.raw[0], d.raw[1], d.status);
        return out;
    }

    /** 清故障码 0x14 FF FF FF → 54 */
    #clearDtc(ecu, p) {
        ecu.dtcs = [];
        return [0x54];
    }

    /**
     * 安全访问 0x27：
     *   03/04 = PIN 路径（5 位 PIN 的 BCD 密钥）→ 可用；
     *   05/06 = SECURITY0529 服务器算密钥 → 返回 NRC（工具侧应显示「不支持」）
     */
    #security(ecu, p) {
        const sub = p[1] || 0;
        if (sub === 0x03) return [0x67, 0x03, ...ecu.seed];
        if (sub === 0x04) {
            if (p.length < 5) return [0x7f, 0x27, 0x13];
            ecu.unlocked = true;
            return [0x67, 0x04];
        }
        return [0x7f, 0x27, 0x12];      // 子功能不支持（服务器密钥 / 其它）
    }
}

function bytesOf(spec) {
    return Math.max(1, Number(spec.bytes) || 1);
}

export { PROXI_LENGTH, BODY_COUNTER, CRC_TARGET, ABSENT_NODES, presenceInfo, encodeNum, decodeNum, numScale };
