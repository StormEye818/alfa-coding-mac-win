/**
 * 组装移动端 www/：把桌面端 app/ 与 src/ 原样拷入，保持
 * fetch('../src/data/*.json') 等相对路径零改动；再用 esbuild 把
 * 移动传输层（mobile-bridge.js + Capacitor 插件）打成单文件 vendor，
 * 由 app.js 在 window.Capacitor 存在时动态加载——桌面端永不加载。
 *
 * 用法：
 *   node scripts/sync-web.mjs              # 组装
 *   node scripts/sync-web.mjs --smoke      # 组装并写入冒烟标记
 *   node scripts/sync-web.mjs --bridge-only # 只重打 vendor
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.join(__dirname, '..');
const ROOT = path.join(MOBILE, '..');
const WWW = path.join(MOBILE, 'www');
const smoke = process.argv.includes('--smoke');
const bridgeOnly = process.argv.includes('--bridge-only');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    // 跳过开发残留与平台目录
    if (['node_modules', 'dist', '.git', 'ios', 'android', 'www', 'mobile'].includes(e.name)) continue;
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

if (!bridgeOnly) {
  console.log('[sync] 组装 www/ …');
  fs.rmSync(WWW, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'app'), path.join(WWW, 'app'));
  copyDir(path.join(ROOT, 'src'), path.join(WWW, 'src'));
  // Capacitor 要求 webDir 根有 index.html；UI 实体在 app/（保持 ../src 相对路径不动）。
  // 必须跳到**具体文件** /app/index.html：跳目录 /app/ 会落进 Capacitor 的 SPA 回退
  // 重复套娃成 /app/app/app/...（2026-09 沙箱冒烟实测踩过）
  fs.writeFileSync(path.join(WWW, 'index.html'),
    '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="0; url=/app/index.html">' +
    '<script>location.replace("/app/index.html");</script><a href="/app/index.html">AlfaProxi</a>');
  // 冒烟标记：app/smoke.js 检测到即自动跑验收链路
  if (smoke) {
    fs.writeFileSync(path.join(WWW, 'app', '.smoke-flag'), '1');
    console.log('[sync] 已写入冒烟标记 .smoke-flag');
  }
}

console.log('[sync] esbuild 打包 vendor/mobile-bridge.js …');
await build({
  entryPoints: [path.join(MOBILE, 'src', 'mobile-bridge.js')],
  outfile: path.join(WWW, 'app', 'vendor', 'mobile-bridge.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
});

const size = (p) => {
  try { return (fs.statSync(p).size / 1024).toFixed(0) + 'KB'; } catch { return '—'; }
};
console.log('[sync] 完成: www/app', size(path.join(WWW, 'app', 'app.js')),
  '· vendor', size(path.join(WWW, 'app', 'vendor', 'mobile-bridge.js')));
