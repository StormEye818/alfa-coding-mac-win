'use strict';
/**
 * ELM327 / vLinker MS 传输层 + ISO-TP 收发。
 *
 * 适配器共用同一套 AT 指令（vLinker 是 ELM327 超集），差别只在：
 *   - ELM327 走 29 位 CAN 时，对齐过程中换总线要**手动换适配线** → 由上层发提示
 *   - vLinker MS 支持多路 CAN 自动切换 → 不打扰用户
 *
 * 寻址（来自诊断数据源，Body Computer Marelli 952/949）：
 *   目标地址 0x40，测试仪地址 0xF1
 *   29 位 CAN 请求 ID = 0x18DA<TX><RX>  → 0x18DA40F1
 *                  响应 ID = 0x18DA<RX><TX> → 0x18DAF140
 *   单帧 PCI = 0x0<n>，首帧 0x1<nnn>，连续帧 0x2<idx>
 */

const ELM_TIMEOUT_MS = 5000;

/** 字节拼接（浏览器/Node 通用，不用 Buffer） */
function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
}
function toBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === 'string') {
        const out = new Uint8Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) out[i] = chunk.charCodeAt(i) & 0xff;
        return out;
    }
    return new Uint8Array(chunk);
}

/** 串口抽象：只要能 write(Buffer|string) + 有 data 事件即可（真实串口/蓝牙 SPP/模拟器都行） */
class PortLike {
    write(_data) { throw new Error('not implemented'); }
    on(_event, _cb) { throw new Error('not implemented'); }
}

class Elm327Error extends Error {
    constructor(msg, code) { super(msg); this.code = code; }
}

/** 解析 ELM327 的一行响应（去掉回车/提示符，识别 '?' 与 'NO DATA' 等） */
function cleanLines(buf) {
    return String(buf)
        .replace(/\r/g, '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== '>');
}

/** 把 ELM327 返回的原始帧拼成完整 ISO-TP 报文 */
function reassembleIsoTp(frames) {
    const out = [];
    let pending = null; // { total, chunks:[] }
    for (const frame of frames) {
        const hex = frame.replace(/[^0-9A-Fa-f]/g, '');
        if (hex.length < 2) continue;
        // 无头模式下只有 PCI；有头模式下前面还有 CAN ID（29 位 = 8 hex）
        // 这里由调用方先剥掉 ID
        const pci = parseInt(hex.substr(0, 2), 16);
        const type = pci >> 4;
        const data = hex.slice(2);
        if (type === 0x0) {                       // 单帧
            const len = pci & 0x0f;
            out.push(hexToBytes(data.slice(0, len * 2)));
            pending = null;
        } else if (type === 0x1) {                // 首帧
            const len = ((pci & 0x0f) << 8) | parseInt(data.substr(0, 2), 16);
            pending = { total: len, chunks: [data.slice(2)], got: data.length / 2 - 1 };
        } else if (type === 0x2 && pending) {     // 连续帧
            pending.chunks.push(data);
            pending.got += data.length / 2;
            if (pending.got >= pending.total) {
                const all = pending.chunks.join('').slice(0, pending.total * 2);
                out.push(hexToBytes(all));
                pending = null;
            }
        }
    }
    return out;
}

function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

class Elm327 {
    /**
     * @param {PortLike} port 串口/蓝牙/模拟器
     * @param {{adapter?: 'elm327'|'vlinker-ms'|'sim', log?: Function}} opts
     */
    constructor(port, opts = {}) {
        this.port = port;
        this.adapter = opts.adapter || 'elm327';
        this.log = opts.log || (() => {});
        this.rx = new Uint8Array(0);
        this.lastRaw = '';
        this.waiters = [];
        port.on('data', (chunk) => this.#onData(chunk));
    }

    /** 只有 vLinker MS 支持多路 CAN 自动切换；ELM327 与模拟模式都要提示换适配线 */
    get autoSwitchesBus() {
        return this.adapter === 'vlinker-ms';
    }

    #onData(chunk) {
        this.rx = concatBytes(this.rx, toBytes(chunk));
        let s = '';
        for (const b of this.rx) s += String.fromCharCode(b);
        if (s.includes('>')) {
            this.rx = new Uint8Array(0);
            const w = this.waiters.shift();
            if (w) w.resolve(s);
        }
    }

    #send(cmd, timeoutMs = ELM_TIMEOUT_MS) {
        this.log('>> ' + cmd);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.waiters.findIndex((w) => w.resolve === resolve);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Elm327Error(`适配器超时：${cmd}`, 'TIMEOUT'));
            }, timeoutMs);
            this.waiters.push({
                resolve: (s) => { clearTimeout(timer); this.log('<< ' + s.replace(/\s+/g, ' ').trim()); this.lastRaw = s; resolve(s); },
            });
            this.port.write(cmd + '\r');
        });
    }

    /** 初始化适配器。
     *  protocol（ELM327 ATSP 编号）：6=CAN 11bit/500k，7=CAN 29bit/500k，8=CAN 11bit/250k，9=CAN 29bit/250k。
     *  952/949 全部 29 位：主总线 500k 用 7，舒适总线 125k 用 9（connectNode 会按节点 baud 自动切）。
     *  ⚠️ 历史坑：曾误用 8（11 位 250k）——沙箱不校验故长期未暴露，实车直接 CAN ERROR。
     */
    async init({ protocol = 7 } = {}) {
        await this.#send('ATZ', 8000);
        await this.#send('ATE0');
        await this.#send('ATL0');
        await this.#send('ATS0');
        await this.#send('ATH1');           // 要 CAN ID，才能做 ISO-TP 重组
        await this.#send('ATCAF0');         // 关自动格式化，拿原始帧
        await this.#send('ATSP' + protocol);
        this.protocol = protocol;
        await this.#send('ATST32');         // 帧间超时
        await this.#send('ATSW00');         // 不自动发流控，由我们控制
    }

    /**
     * 设定目标 ECU。
     * @param {{tx:number|string, rx:number|string, baud?:number}} addr
     *   tx/rx = 诊断数据里的地址（如 0x40 / 0xF1）；baud = 该总线速率（500/125），
     *   给了就按速率切 ATSP（500k→7、125k→9，均 29 位），协议变化时才下发。
     */
    async setAddress({ tx, rx, baud }) {
        const t = typeof tx === 'number' ? tx : parseInt(tx, 16);
        const r = typeof rx === 'number' ? rx : parseInt(rx, 16);
        if (baud) {
            const proto = baud === 125 ? 9 : 7;
            if (this.protocol !== proto) {
                await this.#send('ATSP' + proto);
                this.protocol = proto;
            }
        }
        this.target = t; this.tester = r;
        const reqId = 0x18DA0000 | (t << 8) | r;
        this.reqId = reqId;
        this.respId = 0x18DA0000 | (r << 8) | t;
        await this.#send('ATSH' + reqId.toString(16).toUpperCase().padStart(8, '0'));
        await this.#send('ATCRA' + this.respId.toString(16).toUpperCase().padStart(8, '0'));
    }

    /**
     * 发一帧 UDS 请求，返回重组后的响应字节。
     * ≤7 字节走单帧；更长（如写 PROXI 的 2E 20 23 <DATA1>）走 ISO-TP 多帧 + 流控。
     * @param {Uint8Array} payload 例如 0x22 0x20 0x23
     */
    async request(payload, { timeoutMs = ELM_TIMEOUT_MS } = {}) {
        const raw = payload.length > 7
            ? await this.#sendMulti(payload, timeoutMs)
            : await this.#send(bytesToHex(this.#singleFrame(payload)), timeoutMs);
        const frames = cleanLines(raw)
            .map((l) => l.replace(new RegExp('^' + this.respId.toString(16), 'i'), ''))
            .filter((l) => /^[0-9A-Fa-f]+$/.test(l));
        const msgs = reassembleIsoTp(frames);
        if (msgs.length === 0) {
            if (/NO DATA|UNABLE|ERROR|STOPPED/i.test(raw)) {
                throw new Elm327Error('ECU 无响应：' + raw.trim(), 'NO_DATA');
            }
            throw new Elm327Error('无法解析响应：' + raw.trim(), 'BAD_FRAME');
        }
        return msgs[0];
    }

    #singleFrame(payload) {
        const frame = new Uint8Array(payload.length + 1);
        frame[0] = payload.length;
        frame.set(payload, 1);
        return frame;
    }

    /**
     * ISO-TP 多帧发送：
     *   首帧(0x1L LL, 6字节) → 等流控帧(0x30/0x31/0x32) → 按 BS/STmin 连续帧(0x2X, 7字节)
     */
    async #sendMulti(payload, timeoutMs) {
        const total = payload.length;
        const ff = new Uint8Array(8);
        ff[0] = 0x10 | ((total >> 8) & 0x0f);
        ff[1] = total & 0xff;
        ff.set(payload.slice(0, 6), 2);

        const fcRaw = await this.#send(bytesToHex(ff), timeoutMs);
        const fc = this.#parseFlowControl(fcRaw);
        if (fc.flowStatus === 0x02) throw new Elm327Error('ECU 流控：溢出，写入中止', 'OVERFLOW');

        let idx = 1, off = 6, sinceFc = 0;
        while (off < total) {
            const cf = new Uint8Array(8);
            cf[0] = 0x20 | (idx & 0x0f);
            cf.set(payload.slice(off, off + 7), 1);
            const raw = await this.#send(bytesToHex(cf), timeoutMs);
            off += 7;
            idx = (idx + 1) & 0x0f;
            sinceFc++;
            if (fc.blockSize && sinceFc >= fc.blockSize && off < total) {
                const fc2 = this.#parseFlowControl(raw);
                sinceFc = 0;
                if (fc2.flowStatus === 0x02) throw new Elm327Error('ECU 流控：溢出，写入中止', 'OVERFLOW');
            }
            if (fc.stMin > 0) await new Promise((r) => setTimeout(r, fc.stMin));
        }
        // 最后一帧的应答里可能已带响应，也可能还要再取
        return this.lastRaw || '';
    }

    /** 从 ELM327 响应里挑出流控帧（PCI 高 4 位 = 3） */
    #parseFlowControl(raw) {
        for (const line of cleanLines(raw)) {
            const hex = line.replace(new RegExp('^' + (this.respId || '').toString(16), 'i'), '')
                .replace(/[^0-9A-Fa-f]/g, '');
            if (hex.length < 2) continue;
            const pci = parseInt(hex.substr(0, 2), 16);
            if ((pci >> 4) === 0x3) {
                const stRaw = parseInt(hex.substr(4, 2), 16);
                const stMin = stRaw <= 0x7f ? stRaw : (stRaw <= 0xf0 ? 0 : 1);
                return { flowStatus: pci & 0x0f, blockSize: parseInt(hex.substr(2, 2), 16) || 0, stMin };
            }
        }
        // 没有显式流控也允许继续（部分适配器自动处理）
        return { flowStatus: 0, blockSize: 0, stMin: 0 };
    }

    /** 切总线/换适配线提示（ELM327 需要人工换线，vLinker 自动） */
    async switchBus(busGroup) {
        if (this.autoSwitchesBus) return { swapped: false, auto: true };
        return { swapped: false, auto: false, hint: `请更换适配线：${busGroup}` };
    }
}

export {
    Elm327,
    Elm327Error,
    PortLike,
    reassembleIsoTp,
    cleanLines,
    hexToBytes,
    bytesToHex,
};
