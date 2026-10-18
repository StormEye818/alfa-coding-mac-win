#!/usr/bin/env node
/**
 * 语法门禁：对前端/协议层/沙箱/测试的全部脚本跑 `node --check`。
 *
 * 为什么需要它：2026-10-18 审查发现 `app/smoke.js` 多了一个 `}`，
 * 语法错误一路带进了 v0.2.10 的 asar —— 前端每次启动抛 SyntaxError，
 * 移动端 e2e 冒烟（依赖 smoke.js 输出 [SMOKE] PASS）实际上从未跑起来过。
 * 这类问题用 `node --check` 一秒就能拦住。
 *
 * 用法：node tools/check-syntax.mjs   （npm test 的第一道工序）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TARGETS = ['app', 'src', 'sandbox', 'test', 'test-agent1', 'tools', 'bridge', 'electron'];
const EXTS = new Set(['.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of list) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (EXTS.has(path.extname(e.name))) out.push(p);
    }
    return out;
}

const files = [];
for (const t of TARGETS) files.push(...walk(path.join(ROOT, t)));
// 根目录的独立脚本（*.mjs）
for (const e of fs.readdirSync(ROOT)) {
    if (EXTS.has(path.extname(e)) && fs.statSync(path.join(ROOT, e)).isFile()) files.push(path.join(ROOT, e));
}

let bad = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
        bad++;
        const rel = path.relative(ROOT, f);
        const err = (r.stderr || '').split('\n').filter((l) => /Error|error/.test(l)).slice(0, 2).join(' ');
        console.log(`✗ ${rel}\n    ${err || (r.stderr || '').trim().split('\n')[0]}`);
    }
}
console.log(`语法检查：${files.length - bad}/${files.length} 通过`);
process.exit(bad ? 1 : 0);
