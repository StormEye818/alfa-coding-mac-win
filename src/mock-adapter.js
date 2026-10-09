'use strict';
/**
 * 模拟适配器：把 ELM327 + 一台 952 的 Body Computer 仿真出来。
 * 用途：① UI 的模拟模式 ② 协议层离车单测 ③ 演示给车友看
 *
 * 仿真车的 PROXI 块用一份可配置的初始字节（默认来自实车照片结构 + 全零配置）。
 */

import { ProxiBlock, CRC_OFFSET, CRC_DIGITS } from './proxi.js';
import { Emitter } from './emitter.js';

class MockAdapter extends Emitter {
    /**
     * @param {{proxi?: Uint8Array, nodes?: Array<{addr:string,baud:number}>, dtc?: Array}} opts
     */
    constructor(opts = {}) {
        super();
        this.at = { echo: true, headers: true, protocol: 0, address: null, autoFormat: true };
        this.proxi = opts.proxi ? Uint8Array.from(opts.proxi) : MockAdapter.defaultProxi();
        this.nodes = opts.nodes || [];
        this.dtc = opts.dtc || [];
        this.log = opts.log || (() => {});
        this.txLog = [];          // 记录上位机发了什么，便于断言
    }

    /** 造一块结构正确的 PROXI：ASCII 头 + 零配置 + 已封缄的 CRC */
    static defaultProxi() {
        const b = new Uint8Array(289);
        const head = '06639064587OUTPUT-SIT #0000000000';  // 实车样例头部（CRC 区 00000 由 seal 重算）
        for (let i = 0; i < 24; i++) b[i] = head.charCodeAt(i);
        const blk = new ProxiBlock(b);
        blk.seal();
        return blk.bytes;
    }

    // ---- PortLike ----
    write(data) {
        const cmd = String(data).replace(/\r/g, '').trim();
        this.txLog.push(cmd);
        // 异步回包，模拟串口
        setImmediate(() => {
            const out = this.#handle(cmd);
            if (out !== null) this.emit('data', out + '\r\n>');
        });
    }

    #handle(cmd) {
        const up = cmd.toUpperCase();
        if (up.startsWith('AT')) {
            if (up === 'ATZ') return 'ELM327 v1.5';
            if (up === 'ATE0') { this.at.echo = false; return 'OK'; }
            if (up === 'ATE1') { this.at.echo = true; return 'OK'; }
            if (up === 'ATH1') { this.at.headers = true; return 'OK'; }
            if (up === 'ATH0') { this.at.headers = false; return 'OK'; }
            if (up === 'ATL0' || up === 'ATS0' || up === 'ATCAF0' || up === 'ATSW00' || up.startsWith('ATST')) return 'OK';
            if (up.startsWith('ATSP')) { this.at.protocol = parseInt(up.slice(4), 10) || 0; return 'OK'; }
            if (up.startsWith('ATSH')) { this.at.address = up.slice(4); return 'OK'; }
            if (up.startsWith('ATCRA')) return 'OK';
            return 'OK';
        }
        // 数据帧
        const bytes = cmd.replace(/[^0-9A-Fa-f]/g, '');
        if (bytes.length < 2) return 'NO DATA';
        const pci = parseInt(bytes.substr(0, 2), 16);
        const type = pci >> 4;
        const body = [];
        for (let i = 1; i * 2 < bytes.length; i++) body.push(parseInt(bytes.substr(i * 2, 2), 16));

        if (type === 0x0) {                                   // 单帧
            const resp = this.#uds(body.slice(0, pci & 0x0f));
            return resp ? this.#frame(resp) : 'NO DATA';
        }
        if (type === 0x1) {                                   // 首帧 → 回流控
            const total = ((pci & 0x0f) << 8) | body[0];
            this.rxPending = { total, chunks: body.slice(1), got: body.length - 1 };
            return this.#frame([0x30, 0x00, 0x00]);           // FC: continue, BS=0, STmin=0
        }
        if (type === 0x3) {
            return null;                                      // 流控帧：工具→ECU 方向，不应答（真车语义）
        }
        if (type === 0x2 && this.rxPending) {                 // 连续帧
            this.rxPending.chunks.push(...body);
            this.rxPending.got += body.length;
            if (this.rxPending.got >= this.rxPending.total) {
                const payload = this.rxPending.chunks.slice(0, this.rxPending.total);
                this.rxPending = null;
                const resp = this.#uds(payload);
                return resp ? this.#frame(resp) : 'NO DATA';
            }
            return '';                                        // 还没收满：不回内容（只剩提示符）
        }
        return 'NO DATA';
    }

    /** 响应 CAN ID：请求 18DA<TX><RX> → 响应 18DA<RX><TX> */
    #respId() {
        if (!this.at.address || this.at.address.length < 8) return '';
        const a = this.at.address.toLowerCase();
        // 18DA + tx + rx  →  18DA + rx + tx
        return (a.slice(0, 4) + a.slice(6, 8) + a.slice(4, 6)).toUpperCase();
    }

    /** 按 ISO-TP 封帧：≤7 字节单帧；否则首帧(6B)+连续帧(7B)，每行一帧 */
    #frame(payload) {
        const h = (b) => b.toString(16).toUpperCase().padStart(2, '0');
        const id = this.#respId();
        const lines = [];
        if (payload.length <= 7) {
            lines.push(id + h(payload.length) + payload.map(h).join(''));
            return lines.join('\n');
        }
        const total = payload.length;
        lines.push(id + h(0x10 | ((total >> 8) & 0x0f)) + h(total & 0xff) +
            payload.slice(0, 6).map(h).join(''));
        let idx = 1, off = 6;
        while (off < total) {
            const chunk = payload.slice(off, off + 7);
            lines.push(id + h(0x20 | (idx & 0x0f)) + chunk.map(h).join(''));
            off += 7;
            idx = (idx + 1) & 0x0f;
        }
        return lines.join('\n');
    }

    #uds(p) {
        const svc = p[0];
        if (svc === 0x3e) return [0x7e, 0x00];                    // tester present
        if (svc === 0x22) {                                       // readDataByIdentifier
            const did = (p[1] << 8) | p[2];
            const data = this.#did(did);
            if (!data) return [0x7f, 0x22, 0x31];
            return [0x62, p[1], p[2], ...data];
        }
        if (svc === 0x2e) {                                       // writeDataByIdentifier
            const did = (p[1] << 8) | p[2];
            const body = p.slice(3);
            if (did === 0x2023) {
                if (body.length !== this.proxi.length) return [0x7f, 0x2e, 0x13];
                this.proxi = Uint8Array.from(body);
                this.log(`[模拟车] PROXI 已写入 ${body.length} 字节`);
                return [0x6e, p[1], p[2]];
            }
            return [0x7f, 0x2e, 0x31];
        }
        if (svc === 0x2f) {                                       // IOControl（执行器测试）
            this.log(`[模拟车] 执行器控制 0x${((p[1] << 8) | p[2]).toString(16)} 选项 0x${(p[3] || 0).toString(16)}`);
            return [0x6f, p[1], p[2], p[3] || 0];
        }
        if (svc === 0x31) {                                       // RoutineControl
            this.log(`[模拟车] 例程 0x${((p[2] << 8) | p[3]).toString(16)} 子功能 0x${(p[1] || 0).toString(16)}`);
            return [0x71, p[1], p[2], p[3], 0x00];
        }
        if (svc === 0x10) {                                       // 会话控制
            return [0x50, p[1]];
        }
        if (svc === 0x19) {                                       // readDtc
            const out = [0x59, 0x02, 0xff];
            for (const d of this.dtc) out.push(d.raw[0], d.raw[1], d.status);
            return out;
        }
        if (svc === 0x14) return [0x54];                          // clearDtc
        if (svc === 0x27) {                                       // security access
            if (p[1] === 0x03) return [0x67, 0x03, 0x12, 0x34];   // 种子
            if (p[1] === 0x04) return [0x67, 0x04];
            return [0x7f, 0x27, 0x12];
        }
        return [0x7f, svc, 0x11];
    }

    #did(did) {
        switch (did) {
            case 0x2023: return Array.from(this.proxi);
            case 0x40A1: return new Array(32).fill(0);
            case 0x40A2: return new Array(32).fill(0);
            case 0x102A: return Array.from(this.proxi.slice(CRC_OFFSET, CRC_OFFSET + CRC_DIGITS)).map((c) => c - 0x30);
            case 0xF190: return Array.from('ZAR95200001234567').map((c) => c.charCodeAt(0));
            case 0xF1A5: return [0x01, 0x02, 0x03, 0x04, 0x05];
            default: return null;
        }
    }

    /** 测试/演示用：把当前 PROXI 读出来 */
    snapshot() {
        return new ProxiBlock(this.proxi).toHexText();
    }
}

export { MockAdapter };
