/**
 * 桥接客户端：界面 ↔ 本地串口/TCP 桥（ws://127.0.0.1:8850）。
 * 浏览器无法直接访问串口，所有硬件 I/O 经由该桥。
 */
class BridgeClient {
    constructor(url = 'ws://127.0.0.1:8850') {
        this.url = url;
        this.ws = null;
        this.seq = 0;
        this.pending = new Map();
        this.onData = null;      // (hex: string) => void
        this.onClosed = null;
        this.onError = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error('无法连接串口桥服务。请先运行：node bridge/server.js'));
            this.ws.onclose = () => { this.onClosed && this.onClosed(); };
            this.ws.onmessage = (ev) => {
                let m;
                try { m = JSON.parse(ev.data); } catch { return; }
                if (m.id && this.pending.has(m.id)) {
                    const p = this.pending.get(m.id);
                    this.pending.delete(m.id);
                    m.ok ? p.resolve(m) : p.reject(new Error(m.error || '桥接返回失败'));
                } else if (m.op === 'data' && this.onData) {
                    this.onData(m.hex);
                } else if (m.op === 'error' && this.onError) {
                    this.onError(m.message);
                }
            };
        });
    }

    call(op, extra = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== 1) return reject(new Error('串口桥未连接'));
            const id = ++this.seq;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('桥接调用超时：' + op));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.ws.send(JSON.stringify({ id, op, ...extra }));
        });
    }

    listPorts() { return this.call('listPorts').then((r) => r.ports || []); }
    open(port, baud) { return this.call('open', { port, baud }); }
    tcpOpen(host, port) { return this.call('tcpOpen', { host, port }); }
    writeHex(hex) { return this.call('write', { data: hex }); }
    writeText(t) { return this.call('writeText', { text: t }); }
    setBaud(b) { return this.call('setBaud', { baud: b }); }
    close() { return this.call('close').catch(() => {}); }
}

export { BridgeClient };
