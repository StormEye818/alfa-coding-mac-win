#!/usr/bin/env node
/**
 * 从 diagnost 数据源生成 `src/data/dtc-snapshots.json`（19 04 冻结帧快照参数表）。
 *
 * 用法：node tools/build-dtc-snapshots.cjs
 *
 * 取值口径（2026-10-18 按车端已验证行为源码实证，详见 docs/修复记录-20261018.md）：
 *   1. 车端已验证行为 `qv()`：`P_2++; value = buffer[StartByte+1]` → StartByte 是
 *      **1-based、相对数据区**。实时参数 `03220885`（转向角）StartByte=1、2 字节已实车验证。
 *   2. 冻结帧参数与实时参数**共用同一套 StartByte 口径**（同一参数在两张表里
 *      StartByte/NumOfBytes/格式完全一致）。
 *   3. `19 04` 应答头 `59 04` + DTC(3) + 记录号(1) = 6 字节 → 数据区从 6 开始。
 *   4. 源 Commands 有第二个 token（`…,0885,02`）时表示**按 DID 定位**：
 *      在数据区找到该 DID，跳过 2 字节，再按 StartByte-1 取 NumOfBytes 字节。
 *
 * 输出字段：name / did?（有 DID 形态才有）/ start（1-based 原样）/ bytes / format /
 *          decimals / scale / offset / signed? / options? / unit?
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TSV = path.join(process.env.HOME || '', 'diag-data', 'data', 'params_all.tsv');
const PARAMS = path.join(ROOT, 'src', 'data', 'params.json');
const OUT = path.join(ROOT, 'src', 'data', 'dtc-snapshots.json');

function readTsv(file) {
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split('\n').filter((l) => l.length > 0);
    const hdr = lines[0].split('\t');
    return lines.slice(1).map((l) => {
        const c = l.split('\t');
        const o = {};
        hdr.forEach((h, i) => { o[h] = c[i] !== undefined ? c[i] : ''; });
        return o;
    });
}

/** 与 patch-params-spec.py 的 parse_format 同口径：family[,decimals[,scale[,offset[,mask]]]] */
function parseFormat(fmt) {
    const raw = String(fmt || '').trim();
    const parts = raw.split(',');
    const family = parts[0] || '';
    const out = { format: raw };
    const num = (i, d) => {
        const v = Number(parts[i]);
        return Number.isFinite(v) ? v : d;
    };
    if (family === 'nm') {
        out.decimals = Math.trunc(num(1, 0));
        out.scale = num(2, 1);
        out.offset = num(3, 0);
    }
    if (family === 'num' || family === 'nums') {
        out.decimals = Math.trunc(num(1, 0));
        out.scale = num(2, 1);
        out.offset = num(3, 0);
        if (family === 'nums') out.signed = true;
    }
    return out;
}

function main() {
    const params = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
    const known = new Set(Object.keys(params.modules || {}));
    const rows = readTsv(TSV).filter((r) => r.CmdType === '9' && known.has(r.ModuleID));

    const modules = {};
    let withDid = 0;
    for (const r of rows) {
        const cmd = String(r.Commands || '').replace(/\s/g, '').toUpperCase();
        const tokens = cmd.split(',').filter(Boolean);
        const spec = {
            name: r.ParamName,
        };
        // 第二个 token = DID（有则按 DID 定位，否则按数据区绝对偏移）
        const didTok = tokens[1] && /^[0-9A-F]{1,4}$/.test(tokens[1]) ? tokens[1].padStart(4, '0') : null;
        if (didTok) { spec.did = didTok; withDid++; }
        spec.start = parseInt(r.StartByte, 10) || 1;     // 1-based，原样保留
        spec.bytes = parseInt(r.NumOfBytes, 10) || 1;
        Object.assign(spec, parseFormat(r.ResultFormat));
        const unit = String(r.Units || '').trim();
        if (unit) spec.unit = unit;
        const bits = String(r.BitResults || '').trim();
        if (bits) spec.options = bits.split('|').filter(Boolean);
        (modules[r.ModuleID] = modules[r.ModuleID] || []).push(spec);
    }

    const total = Object.values(modules).reduce((n, a) => n + a.length, 0);
    fs.writeFileSync(OUT, JSON.stringify({
        generatedFrom: 'params_all.tsv CmdType=9（19 04 冻结帧）；取值口径见 tools/build-dtc-snapshots.cjs 头注释',
        note: 'start 为 1-based：无 did 时相对 19 04 数据区（59 04+DTC3+记录号=6 字节之后）；有 did 时相对该 DID 的值区',
        modules,
    }, null, 1) + '\n');
    console.log(`冻结帧：${total} 项 / ${Object.keys(modules).length} 模块（按 DID 定位 ${withDid} 项）`);
}

main();
