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

function strToBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
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
        this.segQueue = [];   // 已到但无人认领的应答段（逐 '>' 分包）
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
        // 多帧应答流控（实车必需）：收到响应首帧（PCI 0x1x）立即回 FC 30 00 00 …，
        // 否则真车 ECU 发完首帧就停——模拟车曾"一口气发完"掩盖了此缺口
        if (!this.fcSent && this.respId) {
            const flat = s.replace(/\s+/g, '');
            const ffRe = new RegExp(this.respId.toString(16) + '1[0-9A-F]', 'i');
            if (ffRe.test(flat)) {
                this.fcSent = true;
                this.#log('>> [FC] 30 00 00 00 00 00 00 00（应答首帧流控）');
                try { this.port.write('3000000000000000\r'); } catch {}
            }
        }
        // 逐提示符分包：一个 '>' 只交付一段，余量留给下一个命令
        // （此前整包交付一个等待者，造成 OK>OK> 等应答错位）
        let idx;
        while ((idx = s.indexOf('>')) >= 0) {
            const one = s.slice(0, idx + 1);
            const rest = s.slice(idx + 1);
            this.rx = strToBytes(rest);
            this.lastRaw = one;             // 供 #sendMulti 读取"最后一帧应答"
            const w = this.waiters.shift();
            this.#log('<< ' + one.trim());
            if (w) w.resolve(one);
            else this.segQueue.push(one);   // 无等待者先存队列（假提示符/错位余量）
            s = rest;
            if (!s.includes('>')) break;
        }
    }

    /** 轻量诊断日志（供界面「复制/导出日志」） */
    #log(line) {
        const g = globalThis;
        if (!g.__apxLog) g.__apxLog = [];
        const t = new Date();
        const ts = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') +
            ':' + String(t.getSeconds()).padStart(2, '0') + '.' + String(t.getMilliseconds()).padStart(3, '0');
        g.__apxLog.push(`${ts} ${line}`);
        if (g.__apxLog.length > 4000) g.__apxLog.splice(0, g.__apxLog.length - 4000);
    }

    #send(cmd, timeoutMs = ELM_TIMEOUT_MS) {
        this.log('>> ' + cmd);
        this.#log('>> ' + cmd);
        try { this.port.write(cmd + '\r'); } catch (e) {
            return Promise.reject(new Elm327Error('写失败：' + e.message, 'WRITE'));
        }
        return this.#nextSeg(timeoutMs, cmd);
    }

    /** 取一段应答（到下一个 '>' 为止）；先消费积压队列，FIFO 保序 */
    #nextSeg(timeoutMs, cmd = '等待响应') {
        return new Promise((resolve, reject) => {
            if (this.segQueue.length) return resolve(this.segQueue.shift());
            const timer = setTimeout(() => {
                const i = this.waiters.findIndex((w) => w.resolve === done);
                if (i >= 0) this.waiters.splice(i, 1);
                reject(new Elm327Error(`适配器超时：${cmd}`, 'TIMEOUT'));
            }, timeoutMs);
            const done = (v) => { clearTimeout(timer); resolve(v); };
            this.waiters.push({ resolve: done });
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
        await this.#send('ATCFC0');         // 关自动流控：多帧应答的 FC 由本层 #onData 手动回
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
        // 每次寻址前重申链路状态（实车踩坑：ATZ/界面探测把适配器重置回默认态——
        // 空格输出+回显+CAN 格式化——导致"无法解析响应"与 7F 03 11 假服务号）
        for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATCAF0']) await this.#send(c);
        await this.#send('ATSH' + reqId.toString(16).toUpperCase().padStart(8, '0'));
        await this.#send('ATCRA' + this.respId.toString(16).toUpperCase().padStart(8, '0'));
    }

    /**
     * 发一帧 UDS 请求，返回重组后的响应字节。
     * ≤7 字节走单帧；更长（如写 PROXI 的 2E 20 23 <DATA1>）走 ISO-TP 多帧 + 流控。
     * @param {Uint8Array} payload 例如 0x22 0x20 0x23
     */
    async request(payload, { timeoutMs = ELM_TIMEOUT_MS } = {}) {
        this.fcSent = false;   // 每次请求独立计流控
        const t0 = Date.now();
        let raw = payload.length > 7
            ? await this.#sendMulti(payload, timeoutMs)
            : await this.#send(bytesToHex(this.#singleFrame(payload)), timeoutMs);
        // 多帧应答可能被假提示符截断（FC 发送引出的 '>'）——收集到完整消息或预算用尽
        for (;;) {
            const msgs = reassembleIsoTp(this.#parseFrames(raw));
            if (msgs.length > 0) return msgs[0];
            const flat = raw.replace(/\s+/g, '');
            const remain = timeoutMs - (Date.now() - t0);
            const sawResp = this.respId && flat.includes(this.respId.toString(16));
            if (!sawResp || remain <= 200) break;
            raw += await this.#nextSeg(Math.min(remain, 3000), '应答续传');
        }
        if (/NO DATA|UNABLE|ERROR|STOPPED/i.test(raw)) {
            throw new Elm327Error('ECU 无响应：' + raw.trim(), 'NO_DATA');
        }
        throw new Elm327Error('无法解析响应：' + raw.trim(), 'BAD_FRAME');
    }

    /** 从原始应答提取合法 ISO-TP 帧（容错：空格/响应 ID/回显混杂） */
    #parseFrames(raw) {
        const respIdRe = new RegExp(this.respId.toString(16), 'gi');
        return cleanLines(raw)
            .map((l) => l.replace(/\s+/g, '').replace(respIdRe, ''))
            .filter((l) => /^[0-9A-Fa-f]+$/.test(l) && l.length >= 2 && l.length % 2 === 0);
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
