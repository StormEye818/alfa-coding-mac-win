/**
 * 会话与模块连接管理。
 *
 * 诊断流程的通用做法是「先连上某个模块，再在该模块上做操作」——这是协议层的硬约束：
 * 不同 ECU 的 CAN 地址不同（如 BODY33=0x40、ABSMMKC1=0x28），请求帧里的
 * ATSH 必须指向目标模块，否则根本收不到应答。
 *
 * 本模块把这件事收口成 ensureModule(code)：
 *   1) 解析模块 → 需要哪条适配线
 *   2) ELM327：当前线与目标不符 → 发出换线事件并等待确认（与通用诊断流程一致）
 *      vLinker MS：自动切总线，不打扰
 *   3) 设定 CAN 地址（ATSH 18DA<TX><RX>）
 *   4) 之后该模块上的所有操作直接复用这条连接
 *
 * 业务代码一律通过 session.runOn(moduleCode, async () => {...}) 执行，
 * 保证「先连模块、后操作」的顺序不会被绕过。
 */

import { Emitter } from './emitter.js';

class SessionError extends Error {}

class Session extends Emitter {
    /**
     * @param {import('./elm327').Elm327} link
     * @param {{cables: object, log?: Function, platform?: string}} opts
     */
    constructor(link, opts) {
        super();
        this.link = link;
        this.cables = opts.cables;          // src/data/cables.json
        this.log = opts.log || (() => '');
        this.platform = opts.platform || '952';
        this.current = null;                // 当前已连接的模块信息
        this.currentGroup = null;
        this.cableAborted = false;          // 用户取消过换线 → 后续连接立即失败，不再弹提示
    }

    /** 车型对应的车身电脑 */
    get bodyModule() {
        return this.platform === '949' ? 'BODY30' : 'BODY33';
    }

    /** 某模块是否需要人工换适配线 */
    needsCableSwap(code) {
        const m = this.cables.modules[code];
        if (!m) throw new SessionError(`未知模块：${code}`);
        return this.needsPhysicalSwap(m.group || 'none');
    }

    /**
     * 当前物理适配线是否必须换到目标总线。
     *
     * ⚠️ 不能只判「目标是 swap/comfort 才提示」：从 6 号灰线/5 号蓝线回到主总线
     *    （group=none）同样要换线；旧判据 `wantGroup !== 'none'` 会静默留在
     *    非主总线上，随后主总线模块全部 NO DATA。首次连接（currentGroup=null）
     *    只在目标非主总线时提示。
     */
    needsPhysicalSwap(wantGroup) {
        if (!wantGroup || this.link.autoSwitchesBus) return false;
        if (this.currentGroup === null) return wantGroup !== 'none';
        return this.currentGroup !== wantGroup;
    }

    /** 用户取消过换线后，下一次用户主动操作应重新获得提示/连接机会 */
    resetCableAbort() {
        this.cableAborted = false;
    }

    /**
     * 确保已连上指定模块。必要时提示换适配线。
     * @param {string} code 模块代号，如 BODY33 / ABSMMKC1
     * @param {{cableConfirmed?: boolean}} opts cableConfirmed=调用方已在进入前提过换线并获确认
     */
    async ensureModule(code, opts = {}) {
        if (this.cableAborted) throw new SessionError('已取消：未确认换线');
        const m = this.cables.modules[code];
        if (!m) throw new SessionError(`未知模块：${code}`);

        // 已经连着就不重复设地址
        if (this.current && this.current.code === code) return this.current;

        // ELM327：换线提示（vLinker 自动切，不提示）。
        // CANtieCAR：先试软件引脚路由（免换线），失败回退换线提示——绝不静默。
        const wantGroup = m.group;
        let mustSwap = this.needsPhysicalSwap(wantGroup);

        if (!mustSwap && this.link.routePins
            && wantGroup !== 'none' && this.currentGroup !== wantGroup) {
            const routed = await this.link.routePins(wantGroup);
            if (!routed) {
                this.log(`CANtieCAR 引脚路由失败，回退换线提示`);
                mustSwap = true;
            }
        }

        if (mustSwap && !opts.cableConfirmed) {
            // group=none 的模块 hint 为空；从 swap/comfort 回主总线时必须给出明确提示
            const hint = m.hint || (wantGroup === 'swap' ? '请更换为 6 号灰色适配线'
                : wantGroup === 'comfort' ? '请接 5 号蓝色适配线'
                    : '请换回主总线（6/14 脚，无需适配线）');
            this.log(`需要换适配线：${hint}`);
            // 先建立等待句柄，再发事件：回调里同步 confirmCable() 才不会丢
            const wait = this.waitForCableConfirm();
            this.emit('cableRequired', { module: m, hint, group: wantGroup });
            await wait;
            this.emit('cableDone', { module: m });
        } else if (mustSwap) {
            this.log(`换线已确认：${m.hint || wantGroup}`);
            this.emit('cableDone', { module: m });
        }

        await this.link.setAddress({
            tx: parseInt(m.tx, 16), rx: parseInt(m.rx, 16), baud: m.baud, code,
            busGroup: m.group || 'none', busProfile: m.bus || 'CCAN29',
        });
        this.current = m;
        this.currentGroup = wantGroup;
        this.log(`已连接 ${m.name}（${code} @ 0x${m.tx}，${m.baud}k）`);
        this.emit('moduleConnected', { module: m });
        return m;
    }

    /**
     * 等用户点「已换好」。
     * ⚠️ 必须同时留**取消**出口：换线提示是阻塞式等待，用户拔了线/放弃对齐时
     *    没有任何按钮能结束它 → 整个对齐流程永久挂起（`state.aligning` 一直为 true，界面锁死）。
     */
    waitForCableConfirm() {
        if (this.cableAborted) {
            return Promise.reject(new SessionError('已取消：未确认换线'));
        }
        // 并发进入两个换线请求时，旧的等待必须结束，不能把上一个 Promise 永久悬空
        if (this._cableReject) {
            const old = this._cableReject;
            this._cableResolve = null;
            this._cableReject = null;
            old(new SessionError('换线请求已被新的操作取代'));
        }
        return new Promise((resolve, reject) => {
            this._cableResolve = resolve;
            this._cableReject = reject;
        });
    }

    /** 由 UI 调用：用户确认已换线 */
    confirmCable() {
        this.cableAborted = false;
        if (this._cableResolve) {
            const r = this._cableResolve;
            this._cableResolve = null; this._cableReject = null;
            r();
        }
    }

    /** 由 UI 调用：用户放弃本次换线（中止当前流程，后续连接不再弹提示） */
    cancelCable() {
        this.cableAborted = true;
        if (this._cableReject) {
            const rj = this._cableReject;
            this._cableResolve = null; this._cableReject = null;
            rj(new SessionError('已取消：未确认换线'));
        }
    }

    /**
     * 在指定模块上执行一段操作（自动先连模块）。
     * @param {string} code 模块代号
     * @param {Function} fn  async (module) => result
     */
    async runOn(code, fn) {
        const m = await this.ensureModule(code);
        return fn(m);
    }

    /**
     * 按对齐节点连接（节点有自己的地址与所属总线）。
     * 跨总线分组时会提示换适配线 —— 与逐节点写入的真实流程一致。
     */
    async connectNode(node) {
        if (this.cableAborted) throw new SessionError('已取消：未确认换线');
        // 源数据里 ResultFormat=`00125` 的节点没有独立诊断地址（addr=00）：
        // 18DA00F1 无人应答，硬连只会抛 CONNECT，把「工具没地址」伪装成「节点不可用」。
        if (node.addrUnknown || !node.addr || String(node.addr).toUpperCase() === '00') {
            throw new SessionError(`${node.name}：源数据无独立诊断地址（0x00），不能单独写入 PROXI`);
        }
        const group = node.swapCable ? 'swap' : (node.baud === 125 ? 'comfort' : 'none');
        let mustSwap = this.needsPhysicalSwap(group);
        // CANtieCAR：先试软件引脚路由（免换线），失败回退换线提示——绝不静默
        if (!mustSwap && this.link.routePins
            && group !== 'none' && this.currentGroup !== group) {
            const routed = await this.link.routePins(group);
            if (!routed) {
                this.log(`CANtieCAR 引脚路由失败，回退换线提示`);
                mustSwap = true;
            }
        }
        if (mustSwap) {
            const hint = group === 'swap' ? '请更换为 6 号灰色适配线'
                : group === 'comfort' ? '请接 5 号蓝色适配线'
                    : '请换回主总线（6/14 脚，无需适配线）';
            this.log(`需要换适配线：${hint}`);
            const wait = this.waitForCableConfirm();
            this.emit('cableRequired', {
                module: { code: node.name, name: node.name, group },
                hint, group,
            });
            await wait;
            this.emit('cableDone', {});
        }
        await this.link.setAddress({
            tx: parseInt(node.addr, 16), rx: 0xf1, baud: node.baud, code: node.addr,
            busGroup: group, busProfile: group === 'comfort' ? 'BHCAN29' : 'CCAN29',
        });
        this.currentGroup = group;
        this.current = { code: node.addr, name: node.name, zh: node.name, tx: node.addr, baud: node.baud };
        this.log(`已连接 ${node.name}（地址 0x${node.addr}，${node.baud}k）`);
        this.emit('moduleConnected', { module: this.current });
        return this.current;
    }

    /**
     * 断开（保留适配器，只清模块状态）。
     * ⚠️ currentGroup 表示**物理适配线所在总线**，断开逻辑模块不等于线已回到主总线：
     *    保留它，下一次连主总线模块才能提示换回 6/14；物理断开/重连用 resetLink()。
     */
    disconnectModule() {
        this.current = null;
        this.emit('moduleDisconnected', {});
    }

    /** 物理链路断开/重连：模块与总线状态都复位 */
    resetLink() {
        // 断开时仍在等「已换好」的流程必须结束，否则调用方永远挂在 await，busy 闸也永远不释放
        if (this._cableReject) {
            const rj = this._cableReject;
            this._cableResolve = null;
            this._cableReject = null;
            rj(new SessionError('连接已断开：换线流程已取消'));
        }
        this.current = null;
        this.currentGroup = null;
        this.cableAborted = false;
        this.emit('moduleDisconnected', {});
    }

    /** 给 UI 用：把功能条目映射到目标模块 */
    moduleForFunction(item) {
        if (item && item.module) return item.module;
        return this.bodyModule;
    }
}

export { Session, SessionError };
