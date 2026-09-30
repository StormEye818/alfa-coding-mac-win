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
        this.frames = [];            // 记录已下发的载荷，便于展示
        this.proxi = opts.proxi ? Uint8Array.from(opts.proxi) : DemoLink.demoProxi();
        /** 各模块的 PROXI 写入计数器（演示值）。与车身电脑一致 = 已对齐 */
        this.counters = { BODY33: 12, BODY30: 12 };
        this.misaligned = new Set(opts.misaligned || ['EPSZFX1']);   // 演示：默认一个模块未对齐
    }

    /** 该模块当前的 PROXI 写入计数器 */
    counterFor(code) {
        const ref = this.counters.BODY33 ?? 12;
        if (this.misaligned.has(code)) return ref - 1;
        return ref;
    }

    /** 演示用配置块：结构与实车一致（ASCII 头 + 配置位 + 校验），取值为示意 */
    static demoProxi() {
        const b = new Uint8Array(289);
        const head = '406200000001OUTPUT-SIT %';
        for (let i = 0; i < 24; i++) b[i] = head.charCodeAt(i);
        // 常见配置位示意值（仅用于界面展示，非实车数据）
        b[58] = 0x00; b[59] = 0x00; b[66] = 0x00; b[88] = 0xAC;
        b[115] = 0x14; b[149] = 0x04; b[156] = 0x10; b[159] = 0x00;
        b[166] = 0x04; b[177] = 0x00; b[202] = 0x00;
        const blk = new ProxiBlock(b);
        blk.seal();
        return blk.bytes;
    }

    get autoSwitchesBus() { return false; }   // 演示换适配线提示

    async init() {
        for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATCAF0', 'ATSP8', 'ATST32', 'ATSW00']) {
            this.log(`演示 · 发送 ${c}`);
        }
        this.log('演示 · 适配器初始化完成（ISO 15765-4 CAN 29 位 500kbit/s）');
    }

    async setAddress({ tx, rx, code }) {
        const t = typeof tx === 'number' ? tx : parseInt(tx, 16);
        const r = typeof rx === 'number' ? rx : parseInt(rx, 16);
        this.addr = { tx: t, rx: r };
        this.currentCode = code || null;
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
                // 按节点回读校验：13 字节，含最多 3 组 (字节号, 异或掩码)；全 0 = 无差异
                const d = new Array(10).fill(0);
                if (this.currentCode && this.misaligned.has(this.currentCode)) {
                    d[5] = 88; d[6] = 0x02;          // 示例：Byte88 不符
                    this.log('演示 · 回读校验发现差异：Byte88');
                }
                return Uint8Array.from([0x62, payload[1], payload[2], ...d]);
            }
            if (did === 0x292E) {
                // PROXI 写入计数器
                return Uint8Array.from([0x62, payload[1], payload[2], this.counterFor(this.currentCode || 'BODY33')]);
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
        if (svc === 0x19) return Uint8Array.from([0x59, 0x02, 0xff, 0x00, 0x00, 0x00]);
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
