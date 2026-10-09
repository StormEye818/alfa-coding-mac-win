/**
 * 接口识别 / 测试。
 * 按诊断软件的做法：对选定端口发识别指令，按回显判定接口类型与版本，
 * 再测端口往返延迟，最后给出结论。
 */
import { sleep } from '../emitter.js';

class InterfaceTester {
    /** @param {import('./bridge-client.js').BridgeClient} bridge */
    constructor(bridge) {
        this.bridge = bridge;
        this.rx = '';
        const prevOnData = this.bridge.onData;   // 链式转发：不得劫持 Elm327 的数据通道（实车踩坑）
        this.bridge.onData = (hex) => {
            if (prevOnData) prevOnData(hex);
            let s = '';
            for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            this.rx += s;
        };
    }

    /**
     * 发一条指令，等以 '>' 结尾的完整应答。
     * 采用「发送前排空 + 发送后只认新数据」的方式，避免迟到的上一条应答串入本条。
     */
    async exchange(cmd, timeoutMs = 5000) {
        // 1) 排空：丢掉上一条的残留应答（适配器复位等场景会有滞后）
        this.rx = '';
        await sleep(450);
        this.rx = '';
        // 2) 发送并等待本条应答
        await this.bridge.writeText(cmd + '\r');
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (this.rx.includes('>')) {
                await sleep(80);              // 收尾窗口，接住分片到达的尾部
                return this.rx;
            }
            await sleep(20);
        }
        return this.rx;
    }

    async identify(spec) {
        const out = { kind: null, name: '', version: '', ok: false, log: [] };
        const push = (s) => out.log.push(s);

        push(`正在复位适配器（${spec.name}）…`);
        let r = await this.exchange('ATZ', 4000);
        push(`ATZ → ${(r.trim().split('\r')[0] || '(无应答)').slice(0, 50)}`);
        await this.exchange('ATE0');
        r = await this.exchange('ATI');
        const id = r.toUpperCase();
        push(`ATI → ${(r.trim().split('\r').filter(Boolean)[0] || '(无应答)').slice(0, 50)}`);

        if (/ELM32|OBDLINK|VLINKER|V-LINKER/i.test(id)) {
            out.kind = /VLINKER|V-LINKER/i.test(id) ? 'vlinker' : 'elm';
            const lines = r.split('\r')
                .map((x) => x.replace(/^>+/g, '').trim())
                .filter((x) => x && x !== '>' && !/^OK$/i.test(x) && x !== '?');
            out.name = lines.find((x) => /ELM|OBD|VLINK|V-LINK|KEY/i.test(x)) || lines[0] || spec.name;
            out.ok = true;
            const m = /V\s?(\d)[.\s]?(\d)/.exec(id);
            // vLinker 的固件版本号不是 ELM327 版本，不要标成「ELM327 x.y」
            if (m) out.version = out.kind === 'vlinker' ? `v${m[1]}.${m[2]}` : `ELM327 ${m[1]}.${m[2]}`;
            // 仅对 ELM327 兼容芯片做 1.3+ 版本告警；vLinker 自带多路 CAN，不受此限制
            if (out.kind === 'elm' && out.version && /ELM327 1\.[0-2]/.test(out.version)) {
                out.warn = '⚠ 该接口不兼容 ELM327 1.3+，无法连接 CAN 模块！';
            }
        } else if (/OBDKEY/i.test(id)) {
            out.kind = 'obdkey'; out.name = 'OBDKey'; out.ok = true;
        } else if (spec.expect === 'KKL') {
            const r2 = await this.exchange('01', 1500);
            if (r2 && !/NO DATA|\?/.test(r2)) {
                out.kind = 'vagcom'; out.name = 'VagCom/KKL'; out.ok = true;
                push('检测到 KKL 接口');
            } else {
                out.err = '不是 VagCom/KKL 接口';
            }
        } else {
            out.err = `未识别的接口（应答：${(id || '(无)').slice(0, 40).trim()}）`;
        }
        return out;
    }

    /** 纯往返延迟：不计排空与收尾窗口 */
    async latencyTest() {
        this.rx = '';
        const t0 = Date.now();
        await this.bridge.writeText('ATI\r');
        while (Date.now() - t0 < 3000) {
            if (this.rx.includes('>')) return Date.now() - t0;
            await sleep(5);
        }
        return Date.now() - t0;
    }

    /** 完整测试：识别 + 延迟 + 结论 */
    async test(spec, opts = {}) {
        const target = spec.transport === 'wifi' ? `${opts.host}:${opts.port}` : opts.port;
        const result = { spec, port: target, steps: [], ok: false };
        const step = (s) => { result.steps.push(s); return s; };

        step(`正在打开 ${target}${opts.baud ? `（${opts.baud}bps）` : ''}…`);
        try {
            if (spec.transport === 'wifi') await this.bridge.tcpOpen(opts.host, opts.port);
            else await this.bridge.open(opts.port, opts.baud || spec.baud || 38400);
        } catch (e) {
            step(`✗ 打开失败：${e.message}`);
            result.error = e.message;
            return result;
        }
        step('✓ 端口已打开');

        const id = await this.identify(spec);
        id.log.forEach(step);
        result.identify = id;
        if (!id.ok) {
            step(`✗ ${id.err || '识别失败'}`);
            result.error = id.err || '识别失败';
            await this.bridge.close();
            return result;
        }
        step(`✓ 识别为 ${id.name}${id.version ? '（' + id.version + '）' : ''}`);
        if (id.warn) step(id.warn);

        const lat = await this.latencyTest();
        step(`端口往返延迟 ${lat}ms${lat > 200 ? '（偏高，建议 USB 直连并调低缓冲）' : ''}`);
        result.latency = lat;
        step('✓ 测试通过，接口可用');
        result.ok = true;
        await this.bridge.close();
        return result;
    }

    /** 扫描所有串口，找出可用接口 */
    async scan(spec) {
        const ports = await this.bridge.listPorts();
        const found = [];
        for (const p of ports) {
            const r = await this.test(spec, { port: p.path, baud: spec.baud });
            if (r.ok) found.push({ ...r, path: p.path });
        }
        return found;
    }
}

export { InterfaceTester };
