#!/bin/bash
# AlfaProxi 移动端 · Android 工具链全自动安装（macOS Apple Silicon）
# 用法：bash mobile/scripts/setup-android.sh
# 产物：JDK 21 + Android SDK（platform-tools/emulator/android-35/build-tools）+ AVD + 环境变量
set -x

echo "=== 1/6 安装 JDK 21 与 cmdline-tools ==="
brew install openjdk@21   # 免 sudo 的 JDK（temurin cask 需要管理员密码，全自动场景用公式版）
brew install --cask android-commandlinetools

CMDTOOLS=/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$CMDTOOLS:$PATH"

echo "=== 2/6 接受许可 ==="
yes | sdkmanager --sdk_root="$ANDROID_SDK_ROOT" --licenses || true

echo "=== 3/6 安装 SDK 组件（约 3GB）==="
sdkmanager --sdk_root="$ANDROID_SDK_ROOT" \
  "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0"

echo "=== 4/6 安装模拟器系统镜像（约 1.5GB）==="
sdkmanager --sdk_root="$ANDROID_SDK_ROOT" "system-images;android-35;google_apis;arm64-v8a"

echo "=== 5/6 创建 AVD ==="
echo no | "$CMDTOOLS/avdmanager" create avd -n alfaproxi \
  -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6 || true

echo "=== 6/6 写入环境变量（~/.zshrc，已存在则跳过）==="
if ! grep -q 'ANDROID_SDK_ROOT' "$HOME/.zshrc" 2>/dev/null; then
  {
    echo ''
    echo '# Android SDK (AlfaProxi mobile)'
    echo 'export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"'
    echo 'export JAVA_HOME=/opt/homebrew/opt/openjdk@21'
    echo 'export PATH="$PATH:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin"'
  } >> "$HOME/.zshrc"
fi

echo "=== 完成验证 ==="
"$ANDROID_SDK_ROOT/platform-tools/adb" version | head -1
"$ANDROID_SDK_ROOT/emulator/emulator" -list-avds
echo "ANDROID-SETUP-DONE"
