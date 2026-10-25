#!/bin/bash
# install-device.sh — 一条命令：同步 → 编真机 → 装到 iPhone Duo
#
# 背景：以前装机是照 HANDOFF §四 手敲一串命令、UDID 写死在旧
# iPhone 15 Pro Max 上。2026-10-25 用户换了 iPhone Duo（iPhone19,4），
# 固化成脚本并钉死新机，避免再装错设备。
#
# 前置（一次性，需人工）：
#   Xcode → Settings → Accounts → 登录 Apple ID（Team MW795KJMTY）
#   否则 xcodebuild 报 "No Accounts" / "requires a provisioning profile"
#   iPhone Duo 上：设置 → 隐私与安全性 → 开发者模式 → 打开并重启
#
# 用法：
#   ./scripts/install-device.sh              # 编译 + 装到 iPhone Duo
#   ./scripts/install-device.sh --build-only # 只编译不装
#   DEVICE_UDID=<udid> ./scripts/install-device.sh   # 临时装到别的机
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

# ⚠️ 默认装到 iPhone Duo（iPhone19,4）。本机同时可能接着旧 iPhone 15 Pro Max，
#    不要用「取第一台物理机」的写法，会装错设备。
DEFAULT_UDID="00008160-000C043A1420000A"   # iPhone Duo (iPhone19,4)

echo "── 1/4 同步 web 产物 ──"
# ⚠️ cap sync 会重写 packageClassList → 必须再跑 --bridge-only 回填
#    MfiSerialPlugin 等 app 内插件，否则 registerPlugin 拿到空壳（HANDOFF §四）
node scripts/sync-web.mjs
npx cap sync ios >/dev/null
node scripts/sync-web.mjs --bridge-only

echo "── 2/4 编真机包 ──"
# 固定构建路径防装错旧包（HANDOFF §四 规矩：禁 find DerivedData -name App.app）
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath ios/build \
  DEVELOPMENT_TEAM=MW795KJMTY CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" \
  -allowProvisioningUpdates build 2>&1 | tail -5

APP=ios/build/Build/Products/Debug-iphoneos/App.app
[ -d "$APP" ] || { echo "❌ 构建产物缺失: $APP"; exit 1; }
echo "   ✅ $APP"

if [ "$BUILD_ONLY" = 1 ]; then
  echo "── 跳过安装（--build-only）──"
  exit 0
fi

echo "── 3/4 找设备 ──"
# ⚠️ 状态字可能是 connected/available 等，别写死一种
UDID="${DEVICE_UDID:-$DEFAULT_UDID}"
if ! xcrun devicectl list devices 2>/dev/null | grep -q "$UDID"; then
  echo "❌ 目标设备 $UDID 不在线。请插线并解锁 iPhone Duo。"
  echo "   当前在线的物理机："
  xcrun devicectl list devices 2>/dev/null | awk '/physical/'
  exit 1
fi
echo "   ✅ $UDID"

# Developer Mode 关着装不上，先把话说明白（devicectl 只给一句很绕的报错）
if xcrun devicectl device info details --device "$UDID" 2>&1 | grep -q "Developer Mode is turned off"; then
  echo "❌ iPhone Duo 的开发者模式没开，装不进去。"
  echo "   手机上：设置 → 隐私与安全性 → 开发者模式 → 打开，重启后再跑本脚本。"
  exit 1
fi

echo "── 4/4 安装 ──"
xcrun devicectl device install app --device "$UDID" "$APP"
echo
echo "🎉 安装完成"
echo
echo "⚠️  首次启动提示「不受信任的开发者」："
echo "    设置 → 通用 → VPN与设备管理 → 信任 MW795KJMTY"
