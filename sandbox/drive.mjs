/**
 * 工具操作驱动层：把界面里的每一步操作暴露成可脚本调用的函数，
 * 供测试员按《使用教程》逐项执行并断言结果。
 *
 * 用法示例：
 *   import { Tool } from './drive.mjs';
 *   const t = new Tool({ adapter: 'vlinker-ms', port: '/tmp/giulia-vlinker' });
 *   await t.connect(); await t.readConfig();
 *   await t.selectNamed('Dynamic control selector', 'Type 3/DNA/Sport');
 *   await t.applySelected(); await t.writeToEcu();
 *   const st = await t.checkAlignment();
 */
import { Elm327 } from '../src/elm327.js';
import { BridgePort } from '../src/serial/port-adapter.js';
import { BridgeClient } from '../src/serial/bridge-client.js';
import { Session } from '../src/session.js';
import { Uds, DID } from '../src/uds.js';
import { ProxiBlock } from '../src/proxi.js';
import { DemoLink } from '../src/demo-link.js';
import fs from 'fs';

const readJson = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

/** 在场位基线文件：在场位是车辆硬件属性，但 DATA1[6..10]（CRC 数字区）与部分
 *  节点的在场位重叠——seal() 重算 CRC 就会改写这些位。因此本工具把「首次读取时
 *  判定出的在场位」冻结为基线并持久化，之后的配置改动/CRC 重算一律不影响装/卸判定。 */
const PRESENCE_BASELINE = new URL('./.presence-baseline.json', import.meta.url);

export class Tool {
    constructor(opts = {}) {
        this.opts = opts;
        this.log = opts.log || ((m) => console.log('  · ' + m));
        this.state = { readDone: false, selected: new Map(), namedPicks: new Map() };
    }

    /** 第 1 步：连接（教程 §二） */
    async connect() {
        const cables = readJson('../src/data/cables.json');
        if (this.opts.adapter === 'sim') {
            this.link = new DemoLink({ log: this.log });
        } else {
            this.bridge = new BridgeClient(this.opts.bridgeUrl || 'ws://127.0.0.1:8850');
            await this.bridge.connect();
            // port 形如 "127.0.0.1:35001" 视为 TCP（沙箱），否则走串口
            const hp = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(this.opts.port || '');
            if (hp) await this.bridge.tcpOpen(hp[1], Number(hp[2]));
            else await this.bridge.open(this.opts.port, this.opts.baud || 38400);
            this.link = new Elm327(new BridgePort(this.bridge), { adapter: 'vlinker-ms', log: this.log });
        }
        await this.link.init({ protocol: 8 });
        this.uds = new Uds(this.link);
        this.session = new Session(this.link, { cables, platform: this.opts.platform || '952', log: this.log });
        this.session.on('cableRequired', (e) => { this.log('换线提示: ' + e.hint); this.session.confirmCable(); });
        await this.session.ensureModule(this.session.bodyModule);
        this.log('已连接 ' + this.session.bodyModule);
        return true;
    }

    /** 第 2 步：读取车辆配置（教程 §三） */
    async readConfig() {
        const d1 = await this.uds.readProxi();
        this.block = new ProxiBlock(d1);
        this.baseline = this.block.clone();
        // 在场位是车辆硬件属性：首次读取时判定并冻结为基线（跨会话持久），
        // 避免 seal() 重算 CRC（DATA1[6..10] 与部分在场位重叠）导致装/卸状态漂移。
        if (!this.presenceMap) {
            const mods = readJson('../src/data/modules.json');
            const saved = this.#loadPresenceBaseline();
            this.presenceMap = new Map();
            for (const n of mods.alignmentNodes) {
                const v = saved && saved.has(n.name) ? saved.get(n.name) : this.#presenceFromBlock(n, this.block);
                this.presenceMap.set(n.name, v);
            }
            if (!saved) this.#savePresenceBaseline(this.presenceMap);
        }
        this.state.readDone = true;
        this.log(`已读取 ${d1.length} 字节，CRC ${this.block.verify().ok ? '自洽' : '异常'}`);
        return this.block;
    }

    /** 命名配置项：选值（教程 §3.1） */
    async selectNamed(name, label) {
        const ns = readJson('../src/data/named-settings.json');
        const st = ns.settings.find((x) => x.name === name);
        if (!st) throw new Error('未找到命名配置项: ' + name);
        const opt = st.options.find((o) => o.label === label || o.label.startsWith(label));
        if (!opt) throw new Error(`未找到选项 ${label}，可选：${st.options.map((o) => o.label).join(' / ')}`);
        this.state.namedPicks.set(name, { byte: st.startByte, mask: st.mask, value: opt.value, label: opt.label });
        this.log(`已选 ${name} → ${opt.label}`);
    }

    /** 扩展配置项：选中（教程 §3.2） */
    async selectFeature(id, optIdx = null) {
        const ft = readJson('../src/data/features.json');
        const f = ft.active.find((x) => x.id === id || x.name === id);
        if (!f) throw new Error('未找到扩展配置项: ' + id);
        this.state.selected.set(f.id, optIdx);
        this.log(`已选扩展配置 ${f.name}`);
    }

    /** 第 3 步：应用所选（教程 §3.3）→ 产生「待写入」 */
    async applySelected() {
        const changes = [];
        for (const [, pick] of this.state.namedPicks) {
            const before = this.block.getByte(pick.byte);
            const after = (before & ~pick.mask) | (pick.value & pick.mask);
            if (before !== after) { this.block.setByte(pick.byte, after); changes.push({ addr: pick.byte, before, after }); }
        }
        const ft = readJson('../src/data/features.json');
        for (const [fid, idx] of this.state.selected) {
            const f = ft.active.find((x) => x.id === fid);
            if (!f) continue;
            let patch = { bytes: f.patches };
            if (f.options && idx !== null) {
                const o = f.options[idx];
                patch = { bytes: (f.patches || []).map((p) => {
                    const out = { addr: p.addr, bits: { ...(o.bits || {}) } };
                    if (o.fixed !== undefined && o.fixed !== null) out.fixed = o.fixed;
                    return out;
                }) };
            }
            changes.push(...this.block.applyPatch(patch));
        }
        this.block.seal();
        this.log(`已应用：${changes.length} 处字节变更，CRC=${this.block.computedCrc()}`);
        return changes;
    }

    /** 第 4 步：写入 ECU（教程 §3.3）→ 应变「已写入」 */
    async writeToEcu() {
        await this.session.ensureModule(this.session.bodyModule);
        await this.uds.writeProxi(this.block.bytes);
        const back = new ProxiBlock(await this.uds.readProxi());
        const diff = back.diff(this.block);
        const ok = diff.length === 0;
        this.log(ok ? '写入完成，读回校验一致' : `写入后差异 ${diff.length} 处`);
        this.state.namedPicks.clear(); this.state.selected.clear();
        this.baseline = back.clone(); this.block = back;
        return { ok, diff };
    }

    /** 字节编辑：直接改位（教程 §四） */
    async editByte(addr, bit, value) {
        this.block.setBit(addr, bit, value);
        this.block.seal();
        this.log(`Byte${addr} bit${bit} → ${value}`);
    }

    /** 第 5 步：读取对齐状态（教程 §5.1）
     *  主判据：逐节点读 22 10 2A（基准 = 车身电脑当前 PROXI 块）——差异组非空即未对齐；
     *  辅助：0x292E 写入计数与车身电脑比对（不一致同样按未对齐计，与里程表闪烁真值一致）。
     */
    async checkAlignment() {
        const mods = readJson('../src/data/modules.json');
        const nodes = mods.alignmentNodes.filter((n) => !n.excluded);
        await this.session.ensureModule(this.session.bodyModule);
        const refBytes = await this.uds.readProxi();          // 基准块（车身电脑 PROXI）
        const ref = await this.uds.readProxiWriteCounter();   // 辅助参考
        let aligned = 0, misaligned = 0, absent = 0, failed = 0;
        const detail = [];
        for (const n of nodes) {
            const present = this.presenceOf(n);
            if (present === false) { absent++; detail.push({ name: n.name, status: 'absent' }); continue; }
            try {
                await this.session.connectNode(n);
                const v = await this.uds.verifyProxi(refBytes);   // 22 10 2A 回读校验
                const c = await this.uds.readProxiWriteCounter(); // 0x292E 辅助
                const ok = v.ok && c === ref;
                const reason = !v.ok
                    ? `配置差异 Byte${v.diffs.map((d) => d.byte).join('、Byte')}`
                    : `计数 ${c} / 车身 ${ref}`;
                ok ? aligned++ : misaligned++;
                detail.push({
                    name: n.name, status: ok ? 'aligned' : 'misaligned',
                    counter: c, ref, diffs: v.diffs, reason,
                });
            } catch (e) {
                failed++; detail.push({ name: n.name, status: 'fail', err: e.message });
            }
        }
        const verdict = misaligned === 0 && failed === 0
            ? '整车对齐正常，无里程表闪烁'
            : `有 ${misaligned} 个模块未对齐 → 里程表会闪烁${failed ? `（另有 ${failed} 个读取失败）` : ''}`;
        this.log('对齐状态: ' + verdict);
        return { ref, aligned, misaligned, absent, failed, verdict, detail };
    }

    /** 在场位判定：会话内以首次读取的块为准（冻结），避免 CRC 区重叠导致漂移 */
    presenceOf(node) {
        if (this.presenceMap && this.presenceMap.has(node.name)) return this.presenceMap.get(node.name);
        if (!this.block) return null;
        return this.#presenceFromBlock(node, this.block);
    }

    /** 按块内位模式解析在场位："0101Present|0100Not present" */
    #presenceFromBlock(node, block) {
        const parts = String(node.presence || '').split('|');
        let mask = 0, presentVal = null;
        for (const part of parts) {
            const m = /^([0-9A-Fa-f]{4})(.*)$/.exec(part.trim());
            if (!m) continue;
            mask |= parseInt(m[1].slice(0, 2), 16);
            const label = m[2].trim();
            if (!/^not\s/i.test(label)) presentVal = parseInt(m[1].slice(2, 4), 16);
        }
        if (presentVal === null || mask === 0) return null;
        return (block.getByte(node.startByte) & mask) === presentVal;
    }

    /** 读取在场位基线（文件不存在返回 null） */
    #loadPresenceBaseline() {
        try {
            const raw = JSON.parse(fs.readFileSync(PRESENCE_BASELINE, 'utf8'));
            return new Map(Object.entries(raw));
        } catch {
            return null;
        }
    }

    /** 冻结/更新在场位基线 */
    #savePresenceBaseline(map) {
        try {
            fs.writeFileSync(PRESENCE_BASELINE, JSON.stringify(Object.fromEntries(map), null, 2));
        } catch (e) {
            this.log('在场位基线保存失败：' + e.message);
        }
    }

    /** 对齐写入结果反哺在场位基线：NRC「无已安装节点」→ 学到未安装 */
    #learnPresence(node, installed) {
        if (!this.presenceMap || this.presenceMap.get(node.name) === installed) return;
        this.presenceMap.set(node.name, installed);
        this.#savePresenceBaseline(this.presenceMap);
    }

    /** 第 5 步：对齐所选节点（教程 §5.2） */
    async alignNodes(predicate) {
        const mods = readJson('../src/data/modules.json');
        const nodes = mods.alignmentNodes.filter((n) => !n.excluded && predicate(n, this.presenceOf(n)));
        let done = 0, fail = 0;
        for (const n of nodes) {
            try {
                await this.session.connectNode(n);
                await this.uds.writeProxi(this.block.bytes);
                this.#learnPresence(n, true);
                const v = await this.uds.verifyProxi(this.block.bytes);
                if (v.ok) done++; else { fail++; this.log(`对齐失败 ${n.name}: 差异 ${v.diffs.map((d) => 'Byte' + d.byte)}`); }
            } catch (e) {
                fail++;
                if (e && e.nrc === 0x31) this.#learnPresence(n, false);   // 车上无此节点（未安装）
                this.log(`对齐失败 ${n.name}: ${e.message}`);
            }
        }
        this.log(`对齐完成：成功 ${done} / 失败 ${fail}`);
        return { done, fail };
    }

    /** 第 6 步：执行特殊功能（教程 §六） */
    async runFunction(name) {
        const fn = readJson('../src/data/functions.json');
        const item = fn.categories.flatMap((c) => c.items).find((x) => x.name === name);
        if (!item) throw new Error('未找到功能: ' + name);
        if (item.security && item.security.level === 'server') throw new Error('该功能需服务器密钥，不支持');
        await this.session.runOn(item.module, async () => {
            for (const part of String(item.commands).split(',')) {
                const raw = part.trim();
                if (raw.length < 4) continue;
                const bytes = hexToBytes(raw);
                const len = bytes[0];
                if (len > 7) continue;
                await this.link.request(bytes.slice(1, 1 + len));
            }
        });
        this.log(`已执行 ${name}`);
        return true;
    }

    /** 第 7 步：读故障码（教程 §八）——按 dtc.json 联表出名称与说明 */
    async readDtc(moduleCode) {
        const out = await this.session.runOn(moduleCode, async () => this.uds.readDtc());
        this.dtcData = this.dtcData || readJson('../src/data/dtc.json');
        const table = (this.dtcData.modules && this.dtcData.modules[moduleCode]) || null;
        for (const d of out) {
            const key = d.raw.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
            const hit = table && (table[key] || table[key.toLowerCase()]);
            if (hit) { d.name = hit.name; d.desc = hit.desc; }
        }
        this.log(`读取 ${moduleCode} 故障码 ${out.length} 条`);
        return out;
    }

    /** 收尾：关闭桥接连接，避免 WebSocket 挂住事件循环（P3-6） */
    async close() {
        try { if (this.bridge) await this.bridge.close(); } catch { /* 忽略 */ }
    }

    /** 第 8 步：读实时参数（教程 §七） */
    async readParam(moduleCode, did) {
        return this.session.runOn(moduleCode, async () => this.uds.readDataByIdentifier(parseInt(did, 16)));
    }

    /** 里程表是否闪烁（核心判据） */
    async odoFlash() {
        const st = await this.checkAlignment();
        return st.misaligned > 0 || st.failed > 0;
    }
}

function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
