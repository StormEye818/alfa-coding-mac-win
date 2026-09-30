#!/bin/bash
# 双模拟器沙箱冒烟编排：起模拟 Giulia → 装/跑 App → 收集 [SMOKE] 日志 → 聚合退出码
# 用法：bash scripts/smoke-sim.sh ios | android
set -u
PLATFORM="${1:?用法: smoke-sim.sh ios|android}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE="$ROOT/mobile"
LOG="/private/tmp/smoke-$PLATFORM.log"
DURATION="${SMOKE_TIMEOUT:-300}"

echo "=== [$PLATFORM] 1/4 启动模拟 Giulia（出厂状态）==="
pkill -f "sandbox/harness.mjs" 2>/dev/null || true
sleep 1
cd "$ROOT"
SANDBOX_HOST=0.0.0.0 nohup node sandbox/harness.mjs > /private/tmp/sandbox.log 2>&1 &
sleep 2
grep -q "模拟 Giulia 已就绪" /private/tmp/sandbox.log || { echo "沙箱启动失败"; exit 1; }

echo "=== [$PLATFORM] 2/4 组装并同步（含冒烟标记）==="
cd "$MOBILE"
node scripts/sync-web.mjs --smoke || exit 1

echo "=== [$PLATFORM] 3/4 启动模拟器与 App ==="
if [ "$PLATFORM" = "ios" ]; then
  # iOS 模拟器共享宿主网络：App 内直连 127.0.0.1:35001
  UDID="${IOS_UDID:-$(xcrun simctl list devices available | grep -m1 -oE '[0-9A-F-]{36}')}"
  [ -z "$UDID" ] && { echo "没有可用 iOS 模拟器（运行时未装完？）"; exit 1; }
  xcrun simctl boot "$UDID" 2>/dev/null || true
  npx cap sync ios || exit 1
  cd "$MOBILE/ios/App"
  xcodebuild -project App.xcodeproj -scheme App -destination "id=$UDID" -configuration Debug \
    -derivedDataPath "$MOBILE/ios/build" build -quiet || { echo "iOS 构建失败"; exit 1; }
  APP_PATH=$(find "$MOBILE/ios/build/Build/Products" -maxdepth 3 -name "App.app" | head -1)
  [ -z "$APP_PATH" ] && { echo "未找到 App.app"; exit 1; }
  xcrun simctl install "$UDID" "$APP_PATH"
  xcrun simctl launch --console-pty "$UDID" cn.bigmiao.alfaproxi > "$LOG" 2>&1 &
  CONSOLE_PID=$!
else
  # Android 模拟器经 10.0.2.2 访问宿主机
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
  export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
  ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
  if "$ADB" devices | grep -qE 'emulator-[0-9]+\s+device$'; then
    echo "复用已运行的 Android 模拟器"
  else
    "$ANDROID_SDK_ROOT/emulator/emulator" -avd alfaproxi -no-snapshot-save -no-boot-anim > /private/tmp/emulator.log 2>&1 &
    "$ADB" wait-for-device
    "$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
  fi
  npx cap sync android || exit 1
  cd "$MOBILE/android" && ./gradlew installDebug -q || exit 1
  "$ANDROID_SDK_ROOT/platform-tools/adb" logcat -c
  "$ANDROID_SDK_ROOT/platform-tools/adb" shell am start -n cn.bigmiao.alfaproxi/.MainActivity
  "$ANDROID_SDK_ROOT/platform-tools/adb" logcat | grep --line-buffered -E "SMOKE|Capacitor/Console" > "$LOG" 2>&1 &
  CONSOLE_PID=$!
fi

echo "=== [$PLATFORM] 4/4 等待 [SMOKE] 结果（最长 ${DURATION}s，日志 ${LOG}）==="
# 注：$LOG 后跟全角括号必须写 ${LOG}——bash 3.2 会把多字节字符吞进变量名（LOG<NUL> unbound）
deadline=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q "\[SMOKE\] ALL" "$LOG" 2>/dev/null; then break; fi
  sleep 3
done
kill "$CONSOLE_PID" 2>/dev/null

echo "--- [SMOKE] 输出 ---"
grep "\[SMOKE\]" "$LOG" || echo "(无 SMOKE 输出)"
if grep -q "\[SMOKE\] ALL PASS" "$LOG"; then
  echo "SMOKE-$PLATFORM: PASS"; exit 0
else
  echo "SMOKE-$PLATFORM: FAIL"; exit 1
fi
