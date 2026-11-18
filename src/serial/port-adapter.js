/**
 * 把桥接客户端适配成 Elm327 需要的端口接口（write + on('data')），
 * 使真实适配器与演示链路复用同一套协议层。
 */
import { Emitter } from '../emitter.js';

class BridgePort extends Emitter {
    /** @param {import('./bridge-client.js').BridgeClient} bridge */
    constructor(bridge) {
        super();
        this.bridge = bridge;
        // ⚠️ 必须**链式**接管 onData：InterfaceTester 也会挂自己的接收缓存，
        //    直接赋值会把前面的处理器整体覆盖（谁后建谁赢），导致对方永远收不到数据。
        const prev = bridge.onData;
        bridge.onData = (hex) => {
            if (prev) { try { prev(hex); } catch { /* 上游处理器异常不影响协议层 */ } }
            const out = new Uint8Array(hex.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
            this.emit('data', out);
        };
    }
    /**
     * 写入字节。
     * Q3：写失败必须**双通道暴露**——
     *   1) emit('error') 给已注册的监听者（Elm327 构造时会挂，记进 lastPortError/日志）；
     *   2) 上抛为 rejected promise 交给调用方（app 侧）处理。
     * 旧实现只有 1) 没有 2)，且当时 Elm327 根本没监听 'error' → 静默吞掉
     * （写 PROXI 实际没发出去却一路报成功）。现在 Elm327.#send 会 await 并转成
     * Elm327Error('WRITE')，链路与 UI 都能拿到真实错误。
     * @returns {Promise} 桥接写入结果；失败时 reject
     */
    write(data) {
        const bytes = typeof data === 'string'
            ? Array.from(data).map((c) => c.charCodeAt(0) & 0xff)
            : Array.from(data);
        const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
        return this.bridge.writeHex(hex).catch((e) => {
            this.emit('error', e);
            throw e;
        });
    }
}

export { BridgePort };
