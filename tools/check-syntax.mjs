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

/**
 * 扫描集必须是 HEAD 的函数，而不是工作树的函数：
 * 2026-11-18 终验发现工作树里被 gitignore 的本地调试脚本（dbg2.mjs / verify2.mjs 等）
 * 会被工作树扫描计入，导致同一 HEAD 在工作树 69/69、干净 clone 62/62，
 * 违反「同一 HEAD 逐字节一致」。因此以 `git ls-files` 的入库清单为准，
 * 并沿用原扫描范围（8 个目标目录 + 根目录独立脚本；mobile/ 不在原范围内）。
 * 非 git 环境降级为工作树扫描并**显式标记**，绝不静默当作确定性结果。
 */
function trackedJs() {
    const r = spawnSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs'],
        { cwd: ROOT, encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;   // 非 git / git 不可用 → 走降级分支
    return r.stdout.split('\0').filter(Boolean).sort();
}

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
const missing = [];
const tracked = trackedJs();
let degraded = false;
if (tracked) {
    for (const rel of tracked) {
        if (!EXTS.has(path.extname(rel))) continue;
        const slash = rel.indexOf('/');
        const top = slash === -1 ? null : rel.slice(0, slash);
        // 保持原扫描范围：8 个目标目录 + 根目录脚本；mobile/ 等不在范围内
        if (top !== null && !TARGETS.includes(top)) continue;
        const p = path.join(ROOT, rel);
        // 入库脚本在工作树缺失：缺依赖不得静默跳过
        if (!fs.existsSync(p)) { missing.push(`入库脚本缺失：${rel}`); continue; }
        files.push(p);
    }
} else {
    degraded = true;
    for (const t of TARGETS) {
        const dir = path.join(ROOT, t);
        if (!fs.existsSync(dir)) { missing.push(`目标目录缺失：${t}`); continue; }
        files.push(...walk(dir));
    }
    for (const e of fs.readdirSync(ROOT)) {
        if (EXTS.has(path.extname(e)) && fs.statSync(path.join(ROOT, e)).isFile()) files.push(path.join(ROOT, e));
    }
}
files.sort();

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
if (degraded) console.error('⚠ 非 git 环境：git ls-files 不可用，已降级为工作树扫描；本次扫描集可能与干净 clone 不一致，输出不保证逐字节确定');
for (const m of missing) console.error(`✗ ${m}（缺依赖不得静默跳过）`);
console.log(`语法检查：${files.length - bad}/${files.length} 通过`);
process.exit(bad || missing.length ? 1 : 0);
