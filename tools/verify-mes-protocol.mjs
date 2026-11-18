'use strict';
/**
 * G0 协议/数据层门禁：D1/D2/D4、A4/A7、C1，外加 PROXI 原语自检。
 * 全部断言都**调用真实模块的函数**，预期值来自 MES 证据行或独立参考实现。
 */
import { assertion, patternBytes, refCrcKermit, runSafe, stable } from './verify-mes-lib.mjs';
import { ProxiBlock, crc16Kermit, CRC_DATA_START } from '../src/proxi.js';
import { nodeAlignmentStatus, computeAlignment } from '../src/alignment.js';
import { applyScale, snapshotValue } from '../src/scale.js';
import { parseDtcList, isRoutineBusy } from '../src/uds.js';
import * as elm from '../src/elm327.js';

const MES_C1 = 'mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs:742-769';
const MES_A4 = 'mes54r2-src/--/--.cs:36936-36942（MES 5.5 同语义：mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs:50262）';
const MES_A7 = 'mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs:50731,51350（Length < 26 判空；5.4 对应 mes54r2-src/--/--.cs:37320）';
const MES_D2 = 'mes55-knowledge-pack/source/MULTIECUSCAN.decompiled.cs (DTC 记录表按模块字典定长)';

export function run(ctx) {
  const out = [];
  const add = (item, name, ok, detail, evidence, mode) => out.push(assertion(item, name, ok, detail, evidence, mode));

  // ── PROXI 原语：真算 CRC，与独立参考实现对照 ─────────────────────
  const vec = new TextEncoder().encode('123456789');
  const crcVec = runSafe(() => crc16Kermit(vec), -1);
  add('P0', 'CRC_KERMIT_VECTOR', crcVec === 0x2189,
    `CRC("123456789")=0x${crcVec.toString(16)}（必须 2189）`, 'CRC-16/KERMIT 标准向量');

  const block = patternBytes(289, 7);
  const sealed = runSafe(() => { block.fill(0x30, 6, 11); const b = new ProxiBlock(block); const v = b.seal(); return { v, v2: b.verify(), b }; }, null);
  const ref = refCrcKermit(block, CRC_DATA_START);
  add('P0', 'PROXI_SEAL_ROUNDTRIP', !!sealed && sealed.v === ref && sealed.v2.ok,
    `seal=${sealed ? sealed.v : 'ERR'} ref=${ref} verify=${sealed ? stable(sealed.v2) : 'ERR'}`,
    'src/proxi.js 注释:8-9 + 独立参考实现');

  // A7：MES 以 <26 判空；25 字节块不得被当成可写正式块
  const shortBlock = runSafe(() => {
    const b = new ProxiBlock(patternBytes(25, 3));
    return { threw: false, isEmpty: typeof b.isEmpty === 'function' ? b.isEmpty() : (b.empty === true || b.isEmpty === true) };
  }, { threw: true, isEmpty: false });
  add('A7', 'PROXI_EMPTY_THRESHOLD_26', shortBlock.threw || shortBlock.isEmpty === true,
    `25B 块：threw=${shortBlock.threw} isEmpty=${shortBlock.isEmpty}（必须拒收或显式判空）`,
    MES_A7);

  // A4：MES 写入循环先查 E 位图，E=0 直接 continue —— 即使实际位图为 1 也不写
  const bm = {
    window: 16,
    configured: new Uint8Array(16), actual: new Uint8Array(16),
    eol: new Uint8Array(16), eolDone: new Uint8Array(16), eolConfigured: new Uint8Array(16),
  };
  bm.actual[0] = 0x01;                 // 实际有这个节点
  bm.eol[0] = 0x00;                    // 但 E 期望位为 0 → MES 必须跳过
  bm.configured[0] = 0x00;
  const st = runSafe(() => nodeAlignmentStatus({ name: 'BCM', startByte: 1, bitMask: '01' }, bm), null);
  add('A4', 'EOL_GATE_SKIPS_WRITE', !!st && st.alignable === false,
    `C=1/E=0 节点 alignable=${st ? st.alignable : 'ERR'}（必须 false）`, MES_A4);

  // 位图反序窗口：真造 DATA1/DATA3，验证 startByte=1 落在窗口末字节
  const d1 = patternBytes(120, 11); const d3 = patternBytes(80, 13);
  d3[47] = 0x01; d3[32] = 0x80;
  const al = runSafe(() => computeAlignment(d1, d3, [
    { name: 'SGW', startByte: 1, bitMask: '01' },
    { name: 'BCM', startByte: 16, bitMask: '80' },
  ]), null);
  const sgw = al && al.byName.get('SGW');
  const bcm = al && al.byName.get('BCM');
  add('A4', 'BITMAP_REVERSED_WINDOW', !!sgw && !!bcm && sgw.actual === true && bcm.actual === true,
    `startByte=1→DATA3[47]=${sgw ? sgw.actual : 'ERR'} startByte=16→DATA3[32]=${bcm ? bcm.actual : 'ERR'}`,
    'src/alignment.js:16-18 + 实测位图反序口径');

  // ── C1：MES 5.5 明确 1/2 字节补码、3/4 字节无符号大端 ──────────────
  const nums4 = runSafe(() => applyScale(new Uint8Array([0xff, 0xef, 0x01, 0x23]), { spec: { bytes: 4, format: 'nums' } }), null);
  add('C1', 'NUMS_4B_UNSIGNED', nums4 === 0xffef0123,
    `nums 4B FF EF 01 23 → ${nums4}（必须 ${0xffef0123}）`, MES_C1);
  const nums3 = runSafe(() => applyScale(new Uint8Array([0xff, 0xff, 0xff]), { spec: { bytes: 3, format: 'nums' } }), null);
  add('C1', 'NUMS_3B_UNSIGNED', nums3 === 0xffffff,
    `nums 3B FF FF FF → ${nums3}（必须 16777215）`, MES_C1);
  const nums1 = runSafe(() => applyScale(new Uint8Array([0xef]), { spec: { bytes: 1, format: 'nums' } }), null);
  const nums2 = runSafe(() => applyScale(new Uint8Array([0xff, 0xef]), { spec: { bytes: 2, format: 'nums' } }), null);
  add('C1', 'NUMS_1B_2B_SIGNED', nums1 === -17 && nums2 === -17,
    `1B EF→${nums1}（必须 -17） 2B FF EF→${nums2}（必须 -17）`, MES_C1);
  const scaled = runSafe(() => applyScale(new Uint8Array([0x01, 0x2c]), { spec: { bytes: 2, start: 0, format: 'num', scale: 1, offset: 0, decimals: 1 } }), null);
  add('C1', 'SCALE_DECIMALS', scaled === 30,
    `012C decimals=1 → ${scaled}（必须 30）`, 'src/scale.js 头注释：value=(raw×scale+offset)/10^decimals');

  // 冻结帧 6 字节头 + DID 二次定位：用真实应答样本形态
  const resp = Uint8Array.from([0x59, 0x04, 0x01, 0x33, 0x00, 0x01, 0x08, 0x85, 0x02, 0x7f, 0xff]);
  const snap = runSafe(() => snapshotValue(resp, { did: '0885', start: 3, bytes: 1, format: 'num' }), null);
  add('C1', 'SNAPSHOT_DID_RELOCATION', snap === 0xff,
    `59 04 … 0885 02 7F FF，start=3 → ${snap}（必须 255；错则 DID 定位口径有问题）`,
    'src/scale.js:26-30 冻结帧数据区 6 字节头');

  // ── D1：状态位必须能并存、独立成维度 ─────────────────────────────
  const mkResp = (status) => Uint8Array.from([0x59, 0x02, 0xff, 0x01, 0x23, 0x00, status]);
  const bit20 = runSafe(() => parseDtcList(mkResp(0x20))[0] || null, null);
  const bit80 = runSafe(() => parseDtcList(mkResp(0x80))[0] || null, null);
  const bit40 = runSafe(() => parseDtcList(mkResp(0x40))[0] || null, null);
  add('D1', 'STATUS_0x20_STORED', !!bit20 && bit20.stored === true,
    `status=0x20 stored=${bit20 ? bit20.stored : 'ERR'}（必须 true，bit5=自上次清码后失败过）`,
    'ISO 14229-1 DtcStatusOfDTC bit5；总纲 §1.2 D1');
  add('D1', 'STATUS_0x80_MIL', !!bit80 && bit80.mil === true,
    `status=0x80 mil=${bit80 ? bit80.mil : 'ERR'}（必须 true，bit7=警告灯请求）`,
    'ISO 14229-1 DtcStatusOfDTC bit7；总纲 §1.2 D1');
  add('D1', 'STATUS_0x40_NOT_FAULT', !!bit40 && bit40.stored === false,
    `status=0x40 stored=${bit40 ? bit40.stored : 'ERR'}（必须 false：仅本周期自检未运行）`,
    'src/uds.js:360-372 注释 + 实车 859B 样本');

  // ── D2：记录长度必须由字典/结构给出，不能靠整除猜 ─────────────────
  // 12 字节 payload 既可被 4 整除也可被 3 整除，构造 4 条 3 字节记录
  const legacy12 = Uint8Array.from([
    0x59, 0x02, 0xff,
    0x01, 0x01, 0x00, 0x02, 0x02, 0x00,
    0x03, 0x03, 0x00, 0x04, 0x04, 0x00,
  ]);
  const withStride = runSafe(() => parseDtcList(legacy12, { stride: 3 }), null);
  const codes = withStride ? withStride.map((r) => r.code).join(',') : 'ERR';
  add('D2', 'DTC_STRIDE_FROM_DICTIONARY', !!withStride && withStride.length === 4 && codes === 'P0101,P0202,P0303,P0404',
    `12B payload + stride=3 → ${withStride ? withStride.length : 'ERR'} 条：${codes}（必须 4 条且逐条对号）`, MES_D2);

  // ── D4：连续帧序号不连续必须报 BAD_FRAME ─────────────────────────
  const seqGood = runSafe(() => elm.validateFrameSequence([0, 1, 2, 3]), null);
  const seqBad = runSafe(() => elm.validateFrameSequence([0, 1, 3, 4]), null);
  add('D4', 'ISOTP_SEQUENCE_VALIDATION', seqGood === true && seqBad === false,
    `seq[0,1,2,3]=${seqGood}（必须 true） seq[0,1,3,4]=${seqBad}（必须 false）`,
    '总纲 §1.2 D4：连续帧序号不连续必须报 BAD_FRAME');
  const busy = isRoutineBusy(Uint8Array.from([0x7f, 0x31, 0x21]));
  add('D4', 'ROUTINE_BUSY_NRC', busy === true,
    `7F 31 21 isRoutineBusy=${busy}（必须 true）`, 'src/uds.js:410-414 剥长度前缀后的 NRC 口径');

  return out;
}
