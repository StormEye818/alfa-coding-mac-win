'use strict';
/**
 * G0 门禁公共工具（QA 独占）。
 *
 * 这里只做三件事：读文件、从**真实源码**里取出函数体并真执行、把断言结果规整成可排序的行。
 * 不在本文件里放任何「预期值」——预期值必须来自 MES 证据或真正的参考实现，
 * 否则门禁就成了「拿自己的实现验证自己的实现」。
 */
import { readFileSync } from 'node:fs';

export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

export function readJson(path) {
  const t = readText(path);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** 稳定化任意值：对象按 key 排序，避免 Map/对象插入顺序造成字节抖动 */
export function stable(v) {
  if (v instanceof Uint8Array) return Array.from(v).join(' ');
  if (v instanceof Map) return JSON.stringify([...v.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
  }
  return String(v);
}

export function assertion(item, name, ok, detail, evidence, mode = 'behavior') {
  return { item, name, ok: !!ok, detail: String(detail), evidence: String(evidence), mode };
}

/**
 * 从真实源码中切出一个函数声明（含 async），返回源码文本。
 * 这里不是「搜字符串就算通过」——切出来的文本会被 instantiate() 编译成函数真跑。
 * 扫描时跳过字符串/模板串/正则字面量/注释，避免把 } 误判成函数结尾。
 */
export function extractFunction(source, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) return null;
  const openParen = m.index + m[0].lastIndexOf('(');
  let depth = 0;
  let i = openParen;
  let seenClose = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { seenClose = true; break; } }
  }
  if (!seenClose) return null;
  let brace = -1;
  for (let j = i + 1; j < source.length; j++) {
    if (/\s/.test(source[j])) continue;
    if (source[j] === '{') { brace = j; break; }
    return null; // 非块体（箭头表达式）不支持
  }
  if (brace < 0) return null;
  let n = 0;
  let state = 'code';
  let quote = '';
  for (let j = brace; j < source.length; j++) {
    const c = source[j];
    const d = source[j + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; j++; continue; }
      if (c === '/' && d === '*') { state = 'block'; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; continue; }
      if (c === '{') n++;
      else if (c === '}') { n--; if (n === 0) return source.slice(m.index, j + 1).trim(); }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; j++; }
    } else if (state === 'str') {
      if (c === '\\') { j++; continue; }
      if (c === quote) state = 'code';
    }
  }
  return null;
}

/** 与 extractFunction 同构，但切 class/对象声明；用于无法直接 import 的移动端源码 */
export function extractBlock(source, headerPattern) {
  const m = headerPattern.exec(source);
  if (!m) return null;
  const brace = source.indexOf('{', m.index);
  if (brace < 0) return null;
  let n = 0;
  let state = 'code';
  let quote = '';
  for (let j = brace; j < source.length; j++) {
    const c = source[j]; const d = source[j + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; j++; continue; }
      if (c === '/' && d === '*') { state = 'block'; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; continue; }
      if (c === '{') n++;
      else if (c === '}') { n--; if (n === 0) return source.slice(m.index, j + 1).trim(); }
    } else if (state === 'line') { if (c === '\n') state = 'code'; }
    else if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; j++; } }
    else if (state === 'str') { if (c === '\\') { j++; continue; } if (c === quote) state = 'code'; }
  }
  return null;
}

/** 把切出的真实函数体编译成可调用的函数；deps 的键就是它引用的自由变量 */
export function instantiate(source, name, deps = {}) {
  const body = extractFunction(source, name);
  if (!body) throw new Error(`无法从源码提取函数 ${name}`);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `return (${body});`);
  return factory(...names.map((k) => deps[k]));
}

/** 假时钟：让被测代码里的 setTimeout/Date.now 可观测、且不真的睡 */
export function fakeClock() {
  const delays = [];
  let t = 1_000_000;
  return {
    delays,
    // 关键：时钟按「本次 setTimeout 的 ms」前进，累计等待 === 被测代码请求的毫秒数，
    // 否则 waitCancellable 的 120ms 分片会让累计值变成近似量，容差式断言就能蒙混过关。
    setTimeout(fn, ms) { const d = Number(ms) || 0; delays.push(d); t += d; if (fn) fn(); return delays.length; },
    Date: { now() { return t; }, parse: Date.parse, UTC: Date.UTC },
  };
}

/** 可复现的伪随机字节（不用 Math.random，保证同一 HEAD 输出逐字符相同） */
export function patternBytes(n, seed = 0) {
  const out = new Uint8Array(n);
  let x = (seed | 0) || 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/** 独立参考实现：CRC-16/KERMIT，绝不调用被测模块 */
export function refCrcKermit(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
  }
  return crc & 0xffff;
}

export function runSafe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

/** 被测行为多是 async：必须真的 await，否则只跑到第一个 await 就放弃 Promise（假证据） */
export async function runSafeAsync(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}
