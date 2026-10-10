/**
 * 会话与模块连接管理。
 *
 * 诊断流程的通用做法是「先连上某个模块，再在该模块上做操作」——这是协议层的硬约束：
 * 不同 ECU 的 CAN 地址不同（如 BODY33=0x40、ABSMMKC1=0x28），请求帧里的
 * ATSH 必须指向目标模块，否则根本收不到应答。
 *
 * 本模块把这件事收口成 ensureModule(code)：
 *   1) 解析模块 → 需要哪条适配线
 *   2) ELM327：当前线与目标不符 → 发出换线事件并等待确认（与诊断软件一致）
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
    }

    /** 车型对应的车身电脑 */
    get bodyModule() {
        return this.platform === '949' ? 'BODY30' : 'BODY33';
    }

    /** 某模块是否需要人工换适配线 */
    needsCableSwap(code) {
        const m = this.cables.modules[code];
        if (!m) throw new SessionError(`未知模块：${code}`);
        return !this.link.autoSwitchesBus && m.group !== 'none';
    }

    /**
     * 确保已连上指定模块。必要时提示换适配线。
     * @param {string} code 模块代号，如 BODY33 / ABSMMKC1
     */
    async ensureModule(code) {
        const m = this.cables.modules[code];
        if (!m) throw new SessionError(`未知模块：${code}`);

        // 已经连着就不重复设地址
        if (this.current && this.current.code === code) return this.current;

        // ELM327：换线提示（vLinker 自动切，不提示）。
        // CANtieCAR：先试软件引脚路由（免换线），失败回退换线提示——绝不静默。
        const wantGroup = m.group;
        let mustSwap = !this.link.autoSwitchesBus
            && wantGroup !== 'none'
            && this.currentGroup !== wantGroup;

        if (!mustSwap && this.link.routePins
            && wantGroup !== 'none' && this.currentGroup !== wantGroup) {
            const routed = await this.link.routePins(wantGroup);
            if (!routed) {
                this.log(`CANtieCAR 引脚路由失败，回退换线提示`);
                mustSwap = true;
            }
        }

        if (mustSwap) {
            this.log(`需要换适配线：${m.hint}`);
            // 先建立等待句柄，再发事件：回调里同步 confirmCable() 才不会丢
            const wait = this.waitForCableConfirm();
            this.emit('cableRequired', { module: m, hint: m.hint, group: wantGroup });
            await wait;
            this.emit('cableDone', { module: m });
        }

        await this.link.setAddress({ tx: parseInt(m.tx, 16), rx: parseInt(m.rx, 16), baud: m.baud, code });
        this.current = m;
        this.currentGroup = wantGroup;
        this.log(`已连接 ${m.name}（${code} @ 0x${m.tx}，${m.baud}k）`);
        this.emit('moduleConnected', { module: m });
        return m;
    }

    /** 等用户点「已换好」 */
    waitForCableConfirm() {
        return new Promise((resolve) => { this._cableResolve = resolve; });
    }

    /** 由 UI 调用：用户确认已换线 */
    confirmCable() {
        if (this._cableResolve) { this._cableResolve(); this._cableResolve = null; }
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
        const group = node.swapCable ? 'swap' : (node.baud === 125 ? 'comfort' : 'none');
        let mustSwap = !this.link.autoSwitchesBus
            && group !== 'none'
            && this.currentGroup !== group;
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
            const hint = group === 'swap' ? '请更换为 6 号灰色适配线' : '请接 5 号蓝色适配线';
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
        });
        this.currentGroup = group;
        this.current = { code: node.addr, name: node.name, zh: node.name, tx: node.addr, baud: node.baud };
        this.log(`已连接 ${node.name}（地址 0x${node.addr}，${node.baud}k）`);
        this.emit('moduleConnected', { module: this.current });
        return this.current;
    }

    /** 断开（保留适配器，只清模块状态） */
    disconnectModule() {
        this.current = null;
        this.currentGroup = null;
        this.emit('moduleDisconnected', {});
    }

    /** 给 UI 用：把功能条目映射到目标模块 */
    moduleForFunction(item) {
        if (item && item.module) return item.module;
        return this.bodyModule;
    }
}

export { Session, SessionError };
