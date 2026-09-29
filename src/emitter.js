/** 极简事件器（浏览器/Node 通用，不依赖 Node 的 events 模块） */
class Emitter {
    constructor() { this._h = {}; }
    on(ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); return this; }
    off(ev, cb) {
        const a = this._h[ev] || [];
        const i = a.indexOf(cb);
        if (i >= 0) a.splice(i, 1);
        return this;
    }
    emit(ev, ...args) { (this._h[ev] || []).slice().forEach((cb) => cb(...args)); }
}

export { Emitter };

/** 通用延时（浏览器/Node 通用） */
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
