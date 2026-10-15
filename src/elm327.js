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
     * @param {{adapter?: 'elm327'|'vlinker-ms'|'cantiecar'|'sim', log?: Function}} opts
     */
    constructor(port, opts = {}) {
        this.port = port;
        this.adapter = opts.adapter || 'elm327';
        this.log = opts.log || (() => {});
        this.rx = new Uint8Array(0);
        this.segQueue = [];   // 已到但无人认领的应答段（逐 '>' 分包）
        this.altProtocols = [];   // 备选协议（NO DATA 时回退，探测式恢复）
        this.lastRaw = '';
        this.waiters = [];
        port.on('data', (chunk) => this.#onData(chunk));
    }

    /**
     * 多路 CAN 自动切换能力——决定对齐/进模块时要不要提示换适配线。
     * 实证（2026-10-10）：
     *   免换线 = CANtieCAR（USB/BT/WiFi，引脚软件路由）/ vLinker MS（多路 CAN 自动切换）；
     *   其余（ELM327 / OBDKey / OBDLink 等）需按线号（5 蓝 / 6 灰）换适配线。
     */
    get autoSwitchesBus() {
        return this.adapter === 'vlinker-ms' || this.adapter === 'cantiecar';
    }

    #onData(chunk) {
        this.rx = concatBytes(this.rx, toBytes(chunk));
        let s = '';
        for (const b of this.rx) s += String.fromCharCode(b);
        // 多帧应答流控（实车必需）：收到响应首帧（PCI 0x1x）立即回 FC 30 00 00 …，
        // 否则真车 ECU 发完首帧就停——模拟车曾"一口气发完"掩盖了此缺口
        // ❌ 手动 FC 已禁用（2026-10-09 实车日志定论）：ELM 收应答窗口内收到任何输入
        //    都会中止接收并回 STOPPED——FC 必须由适配器内建机制发（ATCFC1+ATFC*，见 setAddress）
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

    /** 清空接收流：残留段、未认领余量、末段缓存（连接/重连时调用） */
    #flush() {
        this.rx = new Uint8Array(0);
        this.segQueue = [];
        this.lastRaw = '';
        this.fcSent = false;
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
        this.#flush();                 // 清残留应答/错位余量（多次连接后必做）
        await this.#send('ATZ', 8000);
        await this.#send('ATE0');
        await this.#send('ATL0');
        await this.#send('ATS0');
        await this.#send('ATH1');           // 要 CAN ID，才能做 ISO-TP 重组
        await this.#send('ATCAF0');         // 关自动格式化，拿原始帧
        await this.#send('ATSP' + protocol);
        this.protocol = protocol;
        await this.#send('ATST32');         // 帧间超时
        await this.#send('ATCFC1');         // 自动流控 ON（适配器内建发 FC）
        // 链路参数：ATAL 允许长消息、ATCP18 29 位优先级域、ATAT0 关自适应
        await this.#send('ATAL');
        await this.#send('ATCP18');
        await this.#send('ATAT0');
    }

    /**
     * 设定目标 ECU（= 连模块）。
     *
     * 对齐标准 init 语义（2026-10-15 全链路审计定论）——核心是 **USER 协议 B 通道模型**：
     *   - `VTSET_CAN B,<fmt>,<baud>,<CHAN>` 给 USER 协议 B 槽编程（格式/波特/物理通道）
     *     （vLinker 专有；普通 ELM 用 `AT PP 2C/2D` 编程同一组参数）
     *   - `VTSWGPGT1` 应用通道（vLinker 专有，漏发=配置不生效）
     *   - `ATSPB` 激活协议 B——**不选它前面的编程全是白发**（此前用 ATSP7 永远走
     *     默认 HS 通道，底盘/舒适总线模块 NO DATA 的根因）
     *   - 连接收尾发 `02 10 03` 并校验 50 03（NRC 0x12 时回退 02 10 92）——ECU 在
     *     默认会话下可能不应答任何请求（表现为 NO DATA）
     *
     * @param {{tx:number|string, rx:number|string, baud?:number, busGroup?:string, busProfile?:string}} addr
     *   tx/rx = 诊断地址（0x40/0xF1）；busGroup = none(主6/14)/swap(底盘12/13)/comfort(舒适3/11)；
     *   busProfile = CCAN29/BCAN29/BHCAN29（决定波特档：01=500k/0A=250k/04=125k）。
     */
    async setAddress({ tx, rx, baud, busGroup = 'none', busProfile = 'CCAN29' }) {
        const t = typeof tx === 'number' ? tx : parseInt(tx, 16);
        const r = typeof rx === 'number' ? rx : parseInt(rx, 16);
        this.busGroup = busGroup;
        const pp = { CCAN29: '01', BCAN29: '0A', BHCAN29: '04' }[busProfile] || '01';
        const CHAN = { none: 'HS_CAN', swap: 'CH_CAN', comfort: 'MS_CAN' }[busGroup] || 'HS_CAN';
        const TOKEN = { none: '6E', swap: 'CD', comfort: '3B' };

        // ① 协议参数 + 物理通道（按适配器能力分流；不支持的命令回 '?' 容忍）
        if (this.adapter === 'vlinker-ms') {
            await this.#send('VTSET_CAN B,01,' + pp + ',' + CHAN);
            await this.#send('VTSWGPGT1');
            await this.#send('ATSPB');
        } else if (this.adapter === 'cantiecar') {
            await this.#send('ATMC' + (TOKEN[busGroup] || '6E'));
            await this.#send('ATSPB');
        } else {
            // 普通 ELM327/OBDLink：PP 编程 USER 协议 B 参数（每次连模块都编，与标准流程一致）
            await this.#send('AT PP 2C SV 01').catch(() => {});
            await this.#send('AT PP 2C ON').catch(() => {});
            await this.#send('AT PP 2D SV ' + pp).catch(() => {});
            await this.#send('AT PP 2D ON').catch(() => {});
            await this.#send('ATSPB');
        }
        this.protocol = 'B';
        // 备选协议回退停用：USER 协议模型下切 ATSP0 会丢掉通道配置（实车教训）
        this.altProtocols = [];

        this.target = t; this.tester = r;
        const reqId = 0x18DA0000 | (t << 8) | r;
        this.reqId = reqId;
        this.respId = 0x18DA0000 | (r << 8) | t;
        // ② 链路状态重申 + 寻址（ATCP18+4 字节 ATSH 与 CP18+3 字节 DA<t><r> 等价）
        for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH1', 'ATCAF0', 'ATAL', 'ATCP18', 'ATAT1', 'ATST99']) await this.#send(c);
        await this.#send('ATSH' + reqId.toString(16).toUpperCase().padStart(8, '0'));
        await this.#send('ATCRA' + this.respId.toString(16).toUpperCase().padStart(8, '0'));
        // 流控配方：FC 必须由适配器内建发（手动注入会在收应答窗口触发 STOPPED 中止）。
        // ATFCSD 必须带空格（无空格回 '?'）
        await this.#send('ATCFC1');
        await this.#send('ATFCSH' + reqId.toString(16).toUpperCase().padStart(8, '0'));
        await this.#send('ATFCSD 30 00 00 00 00 00 00 00');
        await this.#send('ATFCSM0');
        // ③ 连接验证：10 03 → 50 03（NRC 0x12 → 10 92；无应答 → ATV0 后重试一次）
        await this.#connectProbe();
    }

    /** 连接验证（每次连模块的硬前置）：10 03/10 92 扩展会话 + 校验正响应 */
    async #connectProbe() {
        let resp = null;
        try {
            resp = await this.request(new Uint8Array([0x10, 0x03]), { timeoutMs: 3000 });
        } catch {
            await this.#send('ATV0').catch(() => {});            // 无应答：关 verbose 重试（标准恢复）
            try {
                resp = await this.request(new Uint8Array([0x10, 0x03]), { timeoutMs: 3000 });
            } catch { /* fallthrough */ }
        }
        if (resp && resp[0] === 0x7f && resp[2] === 0x12) {
            // 子功能不支持：换 10 92（部分模块的扩展会话号不同）
            resp = await this.request(new Uint8Array([0x10, 0x92]), { timeoutMs: 3000 }).catch(() => null);
        }
        if (!resp || resp[0] !== 0x50) {
            const why = resp ? bytesToHex(resp) : '无应答';
            throw new Elm327Error(`模块会话建立失败：10 03 期望 50 03，实得 ${why}`, 'CONNECT');
        }
    }

    /**
     * 发一帧 UDS 请求，返回重组后的响应字节。
     * ≤7 字节走单帧；更长（如写 PROXI 的 2E 20 23 <DATA1>）走 ISO-TP 多帧 + 流控。
     * @param {Uint8Array} payload 例如 0x22 0x20 0x23
     */
    /**
     * 发一帧 UDS 请求。
     *
     * 重试语义（对齐标准发送原语）：
     *   - 服务 0x22/0x19/0x14 空应答 → 100ms 后重试（最多 3 次）
     *   - 任意服务 NRC 0x21（请求过于频繁）→ 100ms 后重试 1 次
     */
    async request(payload, { timeoutMs = ELM_TIMEOUT_MS } = {}) {
        this.fcSent = false;   // 每次请求独立计流控
        const svc = payload[0];
        const isReadFamily = svc === 0x22 || svc === 0x19 || svc === 0x14;
        const maxTries = isReadFamily ? 3 : 1;
        let lastErr = null;
        for (let attempt = 0; attempt < maxTries; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 100));
            try {
                const resp = await this.#requestOnce(payload, timeoutMs);
                if (resp && resp[0] === 0x7f && resp[2] === 0x21 && attempt === 0) {
                    lastErr = null;
                    continue;                      // NRC 0x21：重试一次
                }
                return resp;
            } catch (e) {
                lastErr = e;
                if (!(e && e.code === 'NO_DATA') || attempt === maxTries - 1) throw e;
            }
        }
        throw lastErr;
    }

    async #requestOnce(payload, timeoutMs) {
        this.fcSent = false;
        const t0 = Date.now();
        let raw = payload.length > 7
            ? await this.#sendMulti(payload, timeoutMs)
            : await this.#send(bytesToHex(this.#singleFrame(payload)), timeoutMs);
        // 多帧应答可能被假提示符截断（FC 发送引出的 '>'）——收集到完整消息或预算用尽
        for (;;) {
            const msgs = reassembleIsoTp(this.#parseFrames(raw));
            // 7F <svc> 78 = 响应挂起（pending）：ECU 还在处理，跳过它继续等真实响应
            const real = msgs.filter((m) => !(m.length >= 3 && m[0] === 0x7f && m[2] === 0x78));
            if (real.length > 0) return real[0];
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
        // 真车 ELM 用 \r 分隔帧、以 \r\r> 结尾（无 \n）——必须按 [\r\n]+ 切帧，
        // 否则 cleanLines 删 \r 后所有帧粘成一条（实车日志 dump 全连在一起就是证据）
        return String(raw).split(/[\r\n]+/)
            // 真车 ELM 结尾是「\r\r>」无换行——'>' 粘在最后一帧行尾（实车踩坑），
            // 必须先剥掉提示符再做 hex 校验，否则多帧应答永远缺最后一帧
            .map((l) => l.replace(/[\s>]/g, '').replace(respIdRe, ''))
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
     *
     * 节奏（实车定论 2026-10-10）：ECU 流控常给 STmin=0（要求背靠背发完），
     * 逐帧等 NO DATA 会让每帧卡 250ms、36 帧传 10 秒，超出 N_Cr 帧间超时边缘。
     * 解法：连续帧期间切 ATST03（适配器 12ms 超时，帧间隙压到 ~15ms），
     * 尾帧前恢复 ATST99 等最终响应——标准多帧发送节奏。
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

        // 连续帧用短超时快发（ATST03=12ms），避免逐帧卡满响应超时
        await this.#send('ATST03');

        let idx = 1, off = 6, sinceFc = 0;
        let lastResp = '';
        let restored = false;   // ATST99 下发即已恢复长超时，成功路径不再插命令（避免吞响应）
        try {
            while (off < total) {
                // ISO-TP 最后一帧用短帧（不足 7 字节不填充），与 ECU 发送风格一致；
                // 实车教训（2026-10-09）：填充到 8 字节会被严格校验的 ECU 拒（NRC 0x31）
                const remaining = total - off;
                const dataLen = Math.min(7, remaining);
                const cf = new Uint8Array(1 + dataLen);
                cf[0] = 0x20 | (idx & 0x0f);
                cf.set(payload.slice(off, off + dataLen), 1);
                const isLast = off + dataLen >= total;
                if (isLast) {
                    // 尾帧前恢复正常超时，等 ECU 的最终 UDS 响应（ATST99）
                    await this.#send('ATST99');
                    restored = true;
                }
                const raw = await this.#send(bytesToHex(cf), isLast ? timeoutMs : 2000);
                if (isLast) lastResp = this.lastRaw || raw || '';
                off += dataLen;
                idx = (idx + 1) & 0x0f;
                sinceFc++;
                if (fc.blockSize && sinceFc >= fc.blockSize && off < total) {
                    const fc2 = this.#parseFlowControl(raw);
                    sinceFc = 0;
                    if (fc2.flowStatus === 0x02) throw new Elm327Error('ECU 流控：溢出，写入中止', 'OVERFLOW');
                }
                if (fc.stMin > 0) await new Promise((r) => setTimeout(r, fc.stMin));
            }
        } finally {
            // 仅中途出错时补恢复；成功路径已由 ATST99 恢复，不再插命令
            if (!restored) await this.#send('ATST32').catch(() => {});
        }
        // 最后一帧的应答里可能已带响应，也可能还要再取
        return lastResp;
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

    /**
     * CANtieCAR 软件引脚路由（免换线）——供换线提示回退逻辑试路由用。
     * PINS = 成对引脚字节（6E=6/14、CD=12/13、3B=3/11）。
     *
     * @param {string} busGroup 'none' | 'comfort' | 'swap'
     * @returns {Promise<boolean>} 路由命令是否被适配器接受
     */
    async routePins(busGroup) {
        if (this.adapter !== 'cantiecar') return true;
        const token = { none: '6E', swap: 'CD', comfort: '3B' }[busGroup];
        if (!token) return true;
        try {
            const r = await this.#send('ATMC' + token);
            return !/\?/.test(String(r || ''));
        } catch {
            return false;
        }
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
