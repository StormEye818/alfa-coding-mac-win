/**
 * 接口识别 / 测试。
 * 按通用诊断工具的做法：对选定端口发识别指令，按回显判定接口类型与版本，
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
        // 2) 发送并等待本条应答。Q5：await 所有写；写失败重试一次（桥接瞬时故障），
        //    重试耗尽后抛错由 identify/test 记录，绝不静默吞。
        for (let attempt = 0; ; attempt++) {
            try {
                await this.bridge.writeText(cmd + '\r');
                break;
            } catch (e) {
                if (attempt >= 1) throw e;
                await sleep(100);
            }
        }
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (this.rx.includes('>')) {
                await sleep(80);              // 收尾窗口，接住分片到达的尾部
                return this.rx;
            }
            await sleep(20);
        }
        throw new Error(`接口无应答（${cmd}，${timeoutMs}ms 超时）`);
    }

    async identify(spec) {
        const out = { kind: null, name: '', version: '', ok: false, log: [] };
        const push = (s) => out.log.push(s);

        try {
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
        } catch (e) {
            // Q5：探测异常（写失败/超时）必须落到结论里，不许抛成未捕获异常或静默。
            out.err = `接口探测失败：${e && e.message ? e.message : String(e)}`;
            push(out.err);
        }
        return out;
    }

    /** 纯往返延迟：不计排空与收尾窗口；超时返回 null 让调用方判失败。 */
    async latencyTest(timeoutMs = 3000) {
        // Q5：先排空再写，避免迟到的上一条应答被当成自己的；所有写都 await。
        this.rx = '';
        await sleep(450);
        this.rx = '';
        await this.bridge.writeText('ATI\r');
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (this.rx.includes('>')) {
                await sleep(80);              // 与 exchange 一致的收尾窗口
                return Date.now() - t0;
            }
            await sleep(5);
        }
        return null;   // 不再把超时耗时伪装成延迟值
    }

    /** 完整测试：识别 + 延迟 + 结论 */
    async test(spec, opts = {}) {
        const target = spec.transport === 'wifi' ? `${opts.host}:${opts.port}` : opts.port;
        const result = { spec, port: target, steps: [], ok: false };
        const step = (s) => { result.steps.push(s); return s; };
        let opened = false;

        step(`正在打开 ${target}${opts.baud ? `（${opts.baud}bps）` : ''}…`);
        try {
            if (spec.transport === 'wifi') await this.bridge.tcpOpen(opts.host, opts.port);
            else await this.bridge.open(opts.port, opts.baud || spec.baud || 38400);
            opened = true;
            step('✓ 端口已打开');

            // Q5：识别偶发未命中时重试一次；identify 自身已把异常写进 out.err。
            let id = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                id = await this.identify(spec);
                if (id.ok || attempt === 1 || /探测失败/.test(id.err || '')) break;
                step('识别未命中，重试一次…');
            }
            id.log.forEach(step);
            result.identify = id;
            if (!id.ok) {
                step(`✗ ${id.err || '识别失败'}`);
                result.error = id.err || '识别失败';
                return result;
            }
            step(`✓ 识别为 ${id.name}${id.version ? '（' + id.version + '）' : ''}`);
            if (id.warn) step(id.warn);

            const lat = await this.latencyTest();
            if (lat === null) {
                step('✗ 端口往返延迟测试超时（无应答）');
                result.error = '延迟测试超时';
                return result;
            }
            step(`端口往返延迟 ${lat}ms${lat > 200 ? '（偏高，建议 USB 直连并调低缓冲）' : ''}`);
            result.latency = lat;
            step('✓ 测试通过，接口可用');
            result.ok = true;
            return result;
        } catch (e) {
            // 任何未预期异常都落到结论，不静默、不留悬空端口。
            const msg = e && e.message ? e.message : String(e);
            step(`✗ 测试异常：${msg}`);
            result.error = msg;
            return result;
        } finally {
            // Q5：所有路径（成功/识别失败/异常/超时）都释放端口；close 自身失败不盖过主结论。
            if (opened) await this.bridge.close().catch(() => {});
        }
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
