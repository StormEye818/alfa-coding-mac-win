/**
 * 演示链路（DemoLink）。
 *
 * 与 Elm327 暴露同一套接口（init / setAddress / request / autoSwitchesBus），
 * 所以 Session、Uds、界面流程一行不用改 —— 真实与演示走的是同一条代码路径。
 *
 * 差别只有一点：不与 ECU 收发，而是：
 *   · 把「本应下发的帧」逐帧打印出来（含 AT 指令与 UDS 载荷）
 *   · 读类请求返回一份结构合法的演示数据
 *   · 写类请求返回正响应，并提示写入后应做读回校验
 *
 * 这样整套流程（连接 → 换线 → 连模块 → 读取 → 修改 → 写入 → 校验 → 对齐）
 * 与实车完全一致，且每一步都能看到真实会发出什么，便于核对操作顺序。
 */

import { ProxiBlock } from './proxi.js';

const SERVICE = {
    0x10: '会话控制', 0x14: '清除故障码', 0x19: '读取故障码',
    0x22: '按标识读数据', 0x27: '安全访问', 0x2E: '按标识写数据',
    0x2F: '输入输出控制（执行器）', 0x31: '例程控制', 0x3E: '在线保活',
};

class DemoLink {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.addr = null;
        this.cables = opts.cables || null;   // 地址 → 模块代号（对齐逐节点连接时只有地址）
        this.nodes = opts.nodes || [];       // 对齐节点表（用于生成 DATA1/DATA3 位图）
        this.frames = [];            // 记录已下发的载荷，便于展示
        this.proxi = opts.proxi ? Uint8Array.from(opts.proxi)
            : DemoLink.demoProxi(this.nodes, opts.extraActual || 'Electric Steering');
        /** 演示用 DATA3（80B）：实际位图 = 配置位图，另把 EPS 设成“只在车上存在” */
        this.data3 = opts.data3 ? Uint8Array.from(opts.data3)
            : DemoLink.demoData3(this.proxi, this.nodes, opts.extraActual || 'Electric Steering');
        /** 各模块的 PROXI 写入计数器（演示值）。与车身电脑一致 = 已对齐 */
        this.counters = { BODY33: 12, BODY30: 12 };
        this.misaligned = new Set(opts.misaligned || []);   // 写后 22 10 2A 回读演示（默认全部一致）
    }

    /** 连接的模块代号：ensureModule 传代号，connectNode 只传节点地址 → 按 tx+baud 反查 */
    #resolveCode(code, tx, baud) {
        const known = this.cables && this.cables.modules;
        if (known) {
            if (code && known[code]) return code;
            const hex = (tx & 0xff).toString(16).toUpperCase().padStart(2, '0');
            for (const [c, m] of Object.entries(known)) {
                if (String(m.tx).toUpperCase() === hex && (!baud || m.baud === baud)) return c;
            }
        }
        return code || null;
    }

    /** 该模块当前的 PROXI 写入计数器 */
    counterFor(code) {
        const ref = this.counters.BODY33 ?? 12;
        if (this.misaligned.has(code)) return ref - 1;
        return ref;
    }

    /**
     * 演示用配置块：结构与实车一致（ASCII 头 + 配置位图 + 校验）。
     * 在场位图在 DATA1[25..40]，**反序**：节点 startByte=1 → 索引 40，startByte=16 → 索引 25。
     * （与 src/alignment.js 同口径；SGW startByte=2 ↔ Byte40 已交叉验证）
     */
    static demoProxi(nodes = [], excludeName = '') {
        const b = new Uint8Array(289);
        const head = '406200000001OUTPUT-SIT %';
        for (let i = 0; i < 24; i++) b[i] = head.charCodeAt(i);
        for (const n of nodes) {
            if (!n || n.excluded) continue;
            if (excludeName && String(n.name).includes(excludeName)) continue;  // 演示“只在车上、不在配置里”
            const sb = Number(n.startByte);
            const mask = parseInt(n.bitMask || (n.presence || '').slice(0, 2) || '0', 16) & 0xff;
            if (!mask || sb < 1 || sb > 16) continue;
            b[41 - sb] |= mask;
        }
        // 常见配置位示意值（仅用于界面展示，非实车数据）
        b[57] = 0x00; b[58] = 0x00; b[65] = 0x00; b[87] = 0xAC;
        b[114] = 0x14; b[148] = 0x04; b[155] = 0x10; b[158] = 0x00;
        b[165] = 0x04; b[176] = 0x00; b[201] = 0x00;
        const blk = new ProxiBlock(b);
        blk.seal();
        return blk.bytes;
    }

    /**
     * 演示用 DATA3（80B，PROXIX 家族）：
     *   [32..47] 实际位图 = DATA1[25..40] 配置位图的同向拷贝（两者都是反序窗口）
     *   [48..63]/[64..79] EOL 位默认 0（状态为 Ok）
     * 另把 extraActualName 指定的节点补进实际位图 → 演示「待添加」。
     */
    static demoData3(proxi, nodes = [], extraActualName = '') {
        const d3 = new Uint8Array(80);
        for (let i = 0; i < 16; i++) d3[32 + i] = proxi[25 + i] ?? 0;
        const n = extraActualName
            ? nodes.find((x) => x && String(x.name).includes(extraActualName))
            : null;
        if (n) {
            const sb = Number(n.startByte);
            const mask = parseInt(n.bitMask || '0', 16) & 0xff;
            if (mask && sb >= 1 && sb <= 16) d3[48 - sb] |= mask;
        }
        return d3;
    }

    get autoSwitchesBus() { return false; }   // 演示换适配线提示

    async init() {
        // ⚠️ 与 src/elm327.js init() 同口径，别再各写各的：
        //   ATSP7 = ISO 15765-4 CAN 29 位 500k（误用 ATSP8 = 11 位 250k，实车会 CAN ERROR）
        //   ATAL / ATCP18 / ATAT0 = 链路参数（此前缺失）
        for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATCAF0',
                         'ATAL', 'ATCP18', 'ATAT0', 'ATSP7', 'ATST20']) {
            this.log(`演示 · 发送 ${c}`);
        }
        this.log('演示 · 适配器初始化完成（ISO 15765-4 CAN 29 位 500kbit/s）');
    }

    async setAddress({ tx, rx, baud, code }) {
        const t = typeof tx === 'number' ? tx : parseInt(tx, 16);
        const r = typeof rx === 'number' ? rx : parseInt(rx, 16);
        this.addr = { tx: t, rx: r };
        this.currentCode = this.#resolveCode(code, t, baud);
        const reqId = 0x18DA0000 | (t << 8) | r;
        this.log(`演示 · 发送 ATSH${reqId.toString(16).toUpperCase()}  ATCRA${(0x18DA0000 | (r << 8) | t).toString(16).toUpperCase()}`);
    }

    /** 发一帧，返回演示应答 */
    async request(payload) {
        const bytes = Array.from(payload).map((x) => x.toString(16).toUpperCase().padStart(2, '0'));
        // 长帧（如 PROXI 整块写入）只显示首尾，避免刷屏；完整内容在 frames 里
        const hex = bytes.length > 12
            ? `${bytes.slice(0, 8).join(' ')} …（共 ${bytes.length} 字节）… ${bytes.slice(-4).join(' ')}`
            : bytes.join(' ');
        const svc = payload[0];
        const name = SERVICE[svc] || '未知服务';
        this.frames.push(bytes.join(' '));
        this.log(`演示 · 下发 [${name}] ${hex}`);

        if (svc === 0x22) {
            const did = (payload[1] << 8) | payload[2];
            if (did === 0x2023) {
                this.log(`演示 · 返回 PROXI 配置块（${this.proxi.length} 字节）`);
                return Uint8Array.from([0x62, payload[1], payload[2], ...this.proxi]);
            }
            if (did === 0x102A) {
                // 按节点回读校验：12 字节 = 62 10 2A + 9 字节数据；数据区三组
                // [标志, 字节号, 异或掩码]，差异组为 (字节号, 掩码) 在 [1,2]/[4,5]/[7,8]。
                // 全 0 = 无差异。此前把 Byte88 写进了 d[5]/d[6]（应为 d[4]/d[5]），
                // 差异组落在"字节号=0"上被解析器跳过 → 演示模式永远显示已对齐。
                const d = new Array(9).fill(0);
                if (this.currentCode && this.misaligned.has(this.currentCode)) {
                    d[4] = 88; d[5] = 0x02;          // 示例：Byte88 与基准块不符
                    this.log('演示 · 回读校验发现差异：Byte88');
                }
                return Uint8Array.from([0x62, payload[1], payload[2], ...d]);
            }
            if (did === 0x292E) {
                // PROXI 写入计数器
                return Uint8Array.from([0x62, payload[1], payload[2], this.counterFor(this.currentCode || 'BODY33')]);
            }
            if (did === 0x40A1) {
                return Uint8Array.from([0x62, payload[1], payload[2], ...new Array(32).fill(0)]);
            }
            if (did === 0x40A2) {
                // CAN 配置块（80B）：对齐状态的实际位图来源
                return Uint8Array.from([0x62, payload[1], payload[2], ...this.data3]);
            }
            return Uint8Array.from([0x62, payload[1], payload[2], 0x01, 0x02, 0x03, 0x04, 0x05]);
        }
        if (svc === 0x2E) {
            const n = payload.length - 3;
            const did = (payload[1] << 8) | payload[2];
            // 真正保存写入内容，这样读回校验才有意义
            if (did === 0x2023) {
                this.proxi = Uint8Array.from(payload.slice(3));
                this.log(`演示 · PROXI 已写入 ${n} 字节（读回将返回新内容）`);
            } else {
                this.log(`演示 · 写入 DID 0x${did.toString(16)} ${n} 字节`);
            }
            // 写入成功即视为该模块已对齐（计数与基准一致）
            if (this.currentCode) {
                this.misaligned.delete(this.currentCode);
                this.counters[this.currentCode] = this.counters.BODY33 ?? 12;
            }
            return Uint8Array.from([0x6e, payload[1], payload[2]]);
        }
        if (svc === 0x19) {
            // 19 04 冻结帧：`59 04` + DTC(3) + 记录号(1) + 数据区
            // 演示数据区里预置一批常见 DID（1008/1009/200A/1002/1004/0885/1921），
            // 让「冻结帧快照」页在模拟模式下也能看到值（DID 定位与绝对偏移两种形态都覆盖）
            if (payload[1] === 0x04) {
                const data = new Array(64).fill(0);
                const entries = [[0x1008, 4], [0x1009, 2], [0x200a, 2], [0x1002, 1], [0x1004, 1], [0x0885, 2], [0x1921, 9]];
                let off = 0;
                for (const [did, n] of entries) {
                    data[off] = (did >> 8) & 0xff;
                    data[off + 1] = did & 0xff;
                    for (let i = 2; i < 2 + n; i++) data[off + i] = i % 2 ? 0x64 : 0x00;
                    off += 2 + n;
                }
                // 绝对偏移形态（AAML1 之类）：Operating time 在数据区第 8 字节起
                data[7] = 0x00; data[8] = 0x00; data[9] = 0x04; data[10] = 0xd2;
                this.log('演示 · 返回冻结帧快照（合成数据区 64 字节）');
                return Uint8Array.from([0x59, 0x04, 0x00, 0x00, 0x00, 0x01, ...data]);
            }
            // 演示模式无故障：59 02 <avail>（无记录，UDS 空列表形态）
            return Uint8Array.from([0x59, 0x02, 0xff, 0x00]);
        }
        if (svc === 0x14) return Uint8Array.from([0x54]);
        if (svc === 0x27) return Uint8Array.from([0x67, payload[1], 0x12, 0x34]);
        if (svc === 0x2f) return Uint8Array.from([0x6f, payload[1], payload[2], payload[3] || 0]);
        if (svc === 0x31) return Uint8Array.from([0x71, payload[1], payload[2], payload[3], 0x00]);
        if (svc === 0x10) return Uint8Array.from([0x50, payload[1]]);
        if (svc === 0x3e) return Uint8Array.from([0x7e, 0x00]);
        return Uint8Array.from([0x7f, svc, 0x11]);
    }
}

export { DemoLink, SERVICE };
