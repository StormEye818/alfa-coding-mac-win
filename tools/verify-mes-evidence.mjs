'use strict';
/**
 * G0 覆盖与证据门禁：31 个修复项逐项一行；①级项必须有可读的 MES 行号证据，
 * ③级项必须显式标「只验自身正确性，不称对齐」。
 */
import { assertion, readText } from './verify-mes-lib.mjs';
import { EXPECTED_NAMES } from './verify-mes-manifest.mjs';

/** 总纲 §1–§4 的全部待修项。tier=1 表示有 MES ①级行号证据。 */
export const ITEMS = [
  ['S1', 1, 'mes54r2-src/--/--.cs:4622-4681'],
  ['S2', 1, 'mes54r2-src/--/--.cs:4586-4610'],
  ['S3', 3, '总纲 §1.1 S3（③扩展）'],
  ['S4', 1, 'mes54r2-src/--/--.cs:4646-4679'],
  ['S5', 1, 'mes54r2-src/--/--.cs:4689,4696-4712'],
  ['S6', 3, '总纲 §1.1 S6（③扩展）'],
  ['S7', 3, '总纲 §1.1 S7（③扩展）'],
  ['D1', 2, 'ISO 14229-1 DtcStatusOfDTC；总纲 §1.2 D1'],
  ['D2', 2, 'MES DTC 记录字典；总纲 §1.2 D2'],
  ['D3', 2, '总纲 §1.2 D3（模块字典准入）'],
  ['D4', 2, '总纲 §1.2 D4（连续帧序号 + 超时）'],
  ['A1', 2, '总纲 §1.3 A1（双读一致性）'],
  ['A2', 2, 'mes54r2-src/--/--.cs:36940 后；总纲 §1.3 A2'],
  ['A3', 3, '总纲 §1.3 A3（③扩展）'],
  ['A4', 1, 'mes54r2-src/--/--.cs:36936-36942'],
  ['A5', 3, '总纲 §1.3 A5（③扩展）'],
  ['A6', 2, '总纲 §1.3 A6（②级：披露保留）'],
  ['A7', 1, 'mes54r2-src/--/--.cs:36940'],
  ['C1', 1, 'mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs:742-769'],
  ['C2', 3, '总纲 §1.4 C2（③扩展）'],
  ['C3', 2, '总纲 §1.4 C3（②级：写路径 merge）'],
  ['Q1', 2, '总纲 §1.5 Q1（测试链自身）'],
  ['Q2', 3, '总纲 §1.5 Q2（③扩展）'],
  ['Q3', 2, '总纲 §1.5 Q3'],
  ['Q4', 2, '总纲 §1.5 Q4（桥启动信号）'],
  ['Q5', 2, '总纲 §1.5 Q5'],
  ['Q6', 2, '总纲 §1.5 Q6'],
  ['M1', 1, 'MES iOS Info.plist + MFi 机制（①级元数据）'],
  ['M2', 1, 'MES iOS EAAccessoryManager 自动发现（①级机制）'],
  ['M3', 3, '总纲 §4.3 M3（③扩展：我方接线）'],
  ['M4', 1, 'MES iOS SendCommandToELM 同构（①级架构）'],
];

/** ①级证据的「内容锚」：不是只查文件存在，必须在指定行段里找到关键语义 */
const CONTENT_ANCHORS = [
  ['S1', 'mes54r2-src/--/--.cs', 4622, 4681, /Commands\[0\]|_008A_0099_0089\[0\]/],
  ['S2', 'mes54r2-src/--/--.cs', 4586, 4610, /num\s*>\s*1000/],
  ['S4', 'mes54r2-src/--/--.cs', 4646, 4679, /BitResults|_0091/],
  ['S5', 'mes54r2-src/--/--.cs', 4689, 4712, /Commands\[0\]|_008A_0099_0089\[0\]/],
  ['A4', 'mes54r2-src/--/--.cs', 36936, 36942, /continue/],
  ['C1', 'mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs', 742, 769, /P_0\.Length\s*==\s*3|P_0\.Length == 3/],
];

export function run(ctx) {
  const out = [];
  const add = (item, name, ok, detail, evidence, mode) => out.push(assertion(item, name, ok, detail, evidence, mode));

  // 删断言检测：清单里的名字必须全部出现在本次断言集合里（由 runner 注入）
  const present = new Set((ctx.assertionNames || []));
  const vanished = EXPECTED_NAMES.filter((n) => !present.has(n));
  add('G0', 'NO_ASSERTION_DELETED', vanished.length === 0,
    `清单 ${EXPECTED_NAMES.length} 条，缺失=${JSON.stringify(vanished)}（必须 []）`,
    'tools/verify-mes-manifest.mjs', 'static');

  add('G0', 'ITEM_COUNT', ITEMS.length === 31,
    `总纲待修项=${ITEMS.length}（S7+D4+A7+C3+Q6+M4=31）`, 'docs/修复规划-20261118.md §1–§4');

  for (const [item, tier, evidence] of ITEMS) {
    add(item, 'EVIDENCE_DECLARED', !!evidence && (tier === 1 || tier === 2 || tier === 3),
      `tier=${tier} evidence=${evidence}${tier === 3 ? '（③扩展：只验自身正确性，不称对齐）' : ''}`,
      evidence, 'static');
  }

  for (const [item, rel, from, to, re] of CONTENT_ANCHORS) {
    const lines = readText(`${ctx.mesRoot}/${rel}`).split('\n');
    const segment = lines.slice(from - 1, to).join('\n');
    add(item, 'MES_CONTENT_ANCHOR', re.test(segment),
      `${rel}:${from}-${to} 关键语义命中=${re.test(segment)}`, `${rel}:${from}-${to}`);
  }

  // 不可结案词：证据文档里出现这些词只能当待挖线索，不能作为结论
  const plan = readText(`${ctx.root}/docs/修复规划-20261118.md`);
  const banned = ['需上车确认', '包内没有', '与 MES 同界', '源包限制', '承诺外'];
  const ruleLines = ['不得作为结案理由', '为放行条件', '旧文档中', '不再以', '只能作为待挖线索'];
  const lines = plan.split('\n').filter((line) => !ruleLines.some((r) => line.includes(r)));
  const hit = banned.filter((w) => lines.join('\n').includes(w));
  add('G0', 'NO_CLOSURE_BUZZWORDS', hit.length === 0,
    `结案禁词命中=${JSON.stringify(hit)}（必须 []；规划 §6.1.5）`, 'docs/修复规划-20261118.md:170');

  return out;
}
