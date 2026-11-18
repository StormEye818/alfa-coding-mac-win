#!/usr/bin/env node
'use strict';
/**
 * G0 —— alfaproxi 与 MES 的字节级对齐门禁。
 *
 * 退出码三态：0=全 A；2=仅前置未满足（未构建 / 缺 MES 证据源，未判内容）；1=其它真缺陷。
 * 每条断言的行首是状态：A（通过）/ F（真缺陷）。覆盖表逐项列出 31 个修复项。
 * 输出逐字节确定：只 hash 报告体；机器相关的自述以 NONFP 前缀打印，明确不进指纹。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// env 钉死：必须在任何被测代码执行前设定
process.env.TZ = 'UTC';
process.env.LANG = 'C';
process.env.NC_LANG = 'C';
process.env.NO_COLOR = '1';
process.env.NODE_OPTIONS = '';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(ROOT);
const MES_ROOT = process.env.ALIGN_MES_ROOT || '/Users/se818/mes-reverse';

const PREFLIGHT_FILES = [
  ['修复总纲（验收口径来源）', `${ROOT}/docs/修复规划-20261118.md`],
  ['MES 5.4 反编译源码', `${MES_ROOT}/mes54r2-src/--/--.cs`],
  ['MES 5.5 decompiled', `${MES_ROOT}/mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs`],
  ['功能数据', `${ROOT}/src/data/functions.json`],
  ['DTC 字典', `${ROOT}/src/data/dtc.json`],
  ['PROXI 实现', `${ROOT}/src/proxi.js`],
  ['对齐实现', `${ROOT}/src/alignment.js`],
  ['换算实现', `${ROOT}/src/scale.js`],
  ['UDS 实现', `${ROOT}/src/uds.js`],
  ['app 主链', `${ROOT}/app/app.js`],
];

const missing = PREFLIGHT_FILES.filter(([, p]) => !existsSync(p));
if (missing.length) {
  for (const [name, p] of missing) console.log(`前置未满足 ${name}：${p.replace(ROOT, '<ROOT>').replace(MES_ROOT, '<MES>')}`);
  console.log('退出码=2（仅前置未满足，未对内容作任何判定）');
  process.exit(2);
}

const { ITEMS } = await import('./verify-mes-evidence.mjs');
const GATES = [
  './verify-mes-protocol.mjs',
  './verify-mes-features.mjs',
  './verify-mes-app.mjs',
  './verify-mes-evidence.mjs',
];

const ctx = {
  root: ROOT,
  mesRoot: MES_ROOT,
  assertionNames: [],
  listFiles(dir, re) {
    try { return readdirSync(join(ROOT, dir)).filter((f) => re.test(f)).sort(); } catch { return []; }
  },
};

const report = [];
const nonFp = [];
report.push('=== G0 alfaproxi × MES 字节级对齐门禁（先建门禁，修复未开始时必须红） ===');
report.push('退出码三态：0=全A；2=仅前置未满足（未判内容）；1=其它真缺陷');

// 通用指纹护栏：任何断言 detail 里出现 epoch 毫秒都必须打码并移到 NONFP 段。
// 教训：G1 给 verifyProxi 加了 auxCheck.at，它随每次运行变化，直接进 detail 就毁掉逐字节确定性。
const EPOCH_RE = /\b(?:at|ts|timestamp|time):\d{10,}\b/g;
let scrubbedEpochs = 0;
function scrubDetail(text) {
  const hits = String(text).match(EPOCH_RE) || [];
  scrubbedEpochs += hits.length;
  return String(text).replace(EPOCH_RE, (h) => `${h.split(':')[0]}:<epoch>`);
}

const assertions = [];
let isolatedTmp = 0;
const savedTmp = process.env.TMPDIR;
for (const g of GATES) {
  const name = g.replace(/^\.\//, '').replace(/\.mjs$/, '');
  ctx.assertionNames = assertions.map((a) => a.name);
  const dir = mkdtempSync(join(tmpdir(), 'align-mes-'));
  process.env.TMPDIR = dir;
  isolatedTmp++;
  try {
    const mod = await import(g);
    const got = await mod.run(ctx);
    if (!Array.isArray(got)) throw new Error('gate 未返回断言数组');
    assertions.push(...got.map((a) => ({ ...a, gate: name })));
  } catch (e) {
    assertions.push({ item: 'G0', name: 'GATE_CRASH', ok: false, gate: name,
      detail: String(e && e.message ? e.message : e).split('\n')[0].slice(0, 160),
      evidence: 'G0 自身', mode: 'behavior' });
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响判定 */ }
  }
}

assertions.sort((a, b) => String(a.item).localeCompare(String(b.item)) || String(a.name).localeCompare(String(b.name)));
const byItem = new Map();
for (const a of assertions) {
  report.push(`${a.ok ? 'A' : 'F'} ${a.item.padEnd(2)} ${a.gate} ${a.name} ${scrubDetail(a.detail)}｜证据 ${a.evidence}${a.mode === 'static' ? ' [静态契约]' : a.mode === 'extension' ? ' [③扩展]' : ''}`);
  if (!byItem.has(a.item)) byItem.set(a.item, []);
  byItem.get(a.item).push(a.ok);
}

// 覆盖表：31 项逐个一行；缺断言本身就是缺陷，防止「删断言变绿」
report.push('--- 覆盖表（31 项逐个一行） ---');
for (const [item, tier, evidence] of ITEMS) {
  const results = byItem.get(item) || [];
  const ok = results.length > 0 && results.every(Boolean);
  report.push(`${ok ? 'A' : 'F'} ${item.padEnd(2)} tier=${tier} 断言=${results.length} ${evidence}`);
  if (!results.length) assertions.push({ item, name: 'COVERAGE_MISSING', ok: false });
}
const self = byItem.get('G0') || [];
report.push(`${self.every(Boolean) && self.length ? 'A' : 'F'} G0  门禁自身断言=${self.length}`);

const fails = assertions.filter((a) => !a.ok);
const allOk = fails.length === 0 && byItem.get('G0')?.every(Boolean) && ITEMS.every(([id]) => (byItem.get(id) || []).length > 0);
const body = report.join('\n');
const sha = createHash('sha256').update(body, 'utf8').digest('hex');

report.push('--- 汇总 ---');
report.push(`断言总数=${assertions.length} 通过=${assertions.length - fails.length} 失败=${fails.length}`);
report.push(`gate 数=${GATES.length} 独立 TMPDIR=${isolatedTmp} cwd=<ROOT> TZ=UTC LANG=C NO_COLOR=1 NODE_OPTIONS=''`);
report.push(`结论：${allOk ? '全 A' : `发现 ${fails.length} 条真缺陷`}，退出码=${allOk ? 0 : 1}`);
report.push(`sha256=${sha}`);
nonFp.push('（不进指纹）MES 证据根路径与本机安装位置有关，仅作自述，不参与判定');
nonFp.push(`（不进指纹）本次报告有 ${scrubbedEpochs} 个 epoch 毫秒字段被打码为 <epoch>，不参与指纹`);
nonFp.push(`（不进指纹）${process.env.TMPDIR || '(unset)'} 为运行期临时目录，逐次不同，已排除`);

// sha 必须覆盖「汇总」之前的报告体；重算并固定输出（汇总行本身不进指纹，避免自指）
const finalBody = report.join('\n');
console.log(finalBody);
for (const n of nonFp) console.log(n);
process.exit(allOk ? 0 : 1);
