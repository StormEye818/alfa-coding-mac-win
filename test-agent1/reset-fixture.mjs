#!/usr/bin/env node
/**
 * e2e 夹具复位：重启模拟车 harness，把测试夹具恢复到出厂状态。
 *
 * 为什么必须重启进程：sandbox/harness.mjs 内的 GiuliaCar 是跨 TCP 连接保留状态的单例，
 * 前序脚本会改变它且无法通过 UDS 完全还原——
 *   · t02 把车身 Byte88 从 Type 1(0xAC) 改成 Type 3(0xEC)；
 *   · t03/t05 逐节点写入 PROXI 并刷新写计数，清掉出厂三处失配；
 *   · t04 清空故障码（0x14），而车端没有「新增故障码」的 UDS 服务。
 * 因此整套 e2e 必须在一辆出厂态模拟车上跑；复用旧 harness 会得到 5/6 之类的假红。
 *
 * 用法：node test-agent1/reset-fixture.mjs
 * 位置：应在 t01..t06 之前运行。QA 可把它接进 package.json 的 test:e2e 前置
 *       （"test:e2e": "node test-agent1/reset-fixture.mjs && node test-agent1/t01-..."）。
 * 本脚本只管理模拟车夹具，不启动/清理串口桥（bridge/server.js 按 README 单独前置）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.SANDBOX_PORT || 35001);
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8850);
const HARNESS = path.join(ROOT, 'sandbox', 'harness.mjs');
const LOG = path.join(process.env.TMPDIR || '/tmp', 'alfa-harness-reset.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口当前是否有进程监听（TCP 连接探测） */
function portOpen(port) {
    return new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port });
        const done = (v) => { sock.destroy(); resolve(v); };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.setTimeout(400, () => done(false));
    });
}

/** 找出监听该端口的 PID（lsof 不可用时不静默：报明确错误） */
function pidsOnPort(port) {
    const r = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (r.error) {
        console.error('[reset-fixture] 致命：lsof 不可用，无法定位并复位旧 harness（不静默跳过）');
        process.exit(1);
    }
    if (r.status !== 0) return [];   // 无监听 = 正常（首次运行）
    return r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

console.log(`[reset-fixture] 复位模拟车夹具（端口 ${PORT}）`);

// 0) 前置：串口桥必须已在跑（README 前置，本脚本不负责启动）
if (!(await portOpen(BRIDGE_PORT))) {
    console.error(`[reset-fixture] 前置未满足：串口桥 ws://127.0.0.1:${BRIDGE_PORT} 未监听，请先 node bridge/server.js`);
    process.exit(2);
}

// 1) 停止占用模拟车端口的旧 harness
for (const pid of pidsOnPort(PORT)) {
    console.log(`[reset-fixture] 停止旧 harness PID ${pid}`);
    try { process.kill(pid, 'SIGTERM'); }
    catch (e) { console.error(`[reset-fixture] 无法停止 PID ${pid}：${e.message}`); process.exit(1); }
}
for (let i = 0; i < 50 && (await portOpen(PORT)); i++) await sleep(100);
if (await portOpen(PORT)) {
    console.error(`[reset-fixture] 端口 ${PORT} 未能释放，夹具复位失败`);
    process.exit(1);
}

// 2) 起一个全新的 harness（出厂态）
const logFd = fs.openSync(LOG, 'a');
const child = spawn(process.execPath, [HARNESS], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
});
child.unref();
fs.closeSync(logFd);

let ready = false;
for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await portOpen(PORT)) { ready = true; break; }
}
if (!ready) {
    console.error(`[reset-fixture] harness 未能在 10s 内监听 ${PORT}，日志：${LOG}`);
    process.exit(1);
}
console.log(`[reset-fixture] 出厂态 harness 已就绪（PID ${child.pid}，日志 ${LOG}）`);
// 子进程已 unref、日志 fd 已关，事件循环自然退出即为成功；
// 这里刻意不写死退出码，保持 test-agent1/*.mjs 中「无条件成功退出」恒为 0 的门禁性质。
