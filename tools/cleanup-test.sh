#!/bin/bash
# 测试环境一键清理：app 副本 / 模拟器 / 挂载卷 / 测试服务 / 截图 / 构建中间产物
# 保留：工具链（Xcode/SDK/AVD/keystore）与仓库内可复用测试脚本
# 用法：bash tools/cleanup-test.sh
set -u

echo "=== 1/6 杀测试 app 副本 + LaunchServices 反注册 ==="
pkill -f "apx-dmg-test" 2>/dev/null
pkill -f "/tmp/.*AlfaProxi" 2>/dev/null
for app in /tmp/*.app; do
  [ -d "$app" ] || continue
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$app" 2>/dev/null
  rm -rf "$app" && echo "  已删 $app"
done

echo "=== 2/6 关模拟器 ==="
"$HOME/Library/Android/sdk/platform-tools/adb" emu kill 2>/dev/null && echo "  Android 模拟器已关"
pkill -f "emulator -avd" 2>/dev/null
xcrun simctl shutdown all 2>/dev/null && echo "  iOS 模拟器已关"

echo "=== 3/6 弹出挂载的 DMG 卷 ==="
hdiutil info | awk '/\/Volumes\// {print $NF}' | while read -r v; do
  case "$v" in
    /Volumes/AlfaProxi*|/Volumes/*dmg*) hdiutil detach "$v" -quiet 2>/dev/null && echo "  已弹出 $v" ;;
  esac
done

echo "=== 4/6 停测试服务 ==="
pkill -f "sandbox/harness.mjs" 2>/dev/null && echo "  沙箱 harness 已停"
pkill -f "bridge/server.js" 2>/dev/null && echo "  串口桥已停"
pkill -f "http.server 8848" 2>/dev/null && echo "  静态服务已停"

echo "=== 5/6 清截图与构建中间产物 ==="
rm -rf /tmp/apx-*.png /tmp/ux-*.png /tmp/smoke-*.log /tmp/nsis-build*.log /tmp/dmg-*.log /tmp/android-setup*.log /tmp/emulator*.log 2>/dev/null
rm -rf dist/win-unpacked dist/win-arm64-unpacked 2>/dev/null
rm -f AlfaProxi.Setup*.exe 2>/dev/null

echo "=== 6/6 刷新 Dock ==="
killall Dock 2>/dev/null

echo "清理完成（工具链与可复用测试脚本保留）"
