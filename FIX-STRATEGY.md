# AlfaProxi 打包产物修复报告与避坑指南

仓库：https://github.com/StormEye818/alfa-coding-mac-win
产物：macOS DMG + Windows EXE（Electron + serialport，NSIS 安装器）
修复日期：2026-09-29（沙箱复现与修复）/ 2026-09-30（EXE 云端彻底重建）

---

## 一、症状

| 平台 | 症状 |
|---|---|
| macOS DMG | 安装后打开 app 提示"文件已损坏，无法打开"，应删去重装 |
| Windows EXE | 双击安装包"什么都没发生"，无窗口、无报错、进程瞬间退出 |
| macOS 启动台 | 出现三个 AlfaProxi 图标 |

## 二、根因

### 2.1 DMG "文件已损坏"（已修复，100% 定位）

- electron-builder 构建时未配置签名（`mac.target=dmg` 且未设 identity），产物实际为**无签名 app**。
- 主二进制自带 ld 生成的 ad-hoc 签名（`flags=0x20002 adhoc,linker-signed`），但 `Contents/_CodeSignature/` 不存在、`Sealed Resources=none`、`Info.plist not bound`。
- Gatekeeper 判定逻辑：**"签名不完整" ≠ "未签名"**，对带 ad-hoc 签名但无资源密封的 app 报"已损坏"，而不是"未经身份验证的开发者的 App"。
- 证据：
  - `codesign -dv` → `Format=app bundle with Mach-O thin (arm64)`、`flags=0x20002(adhoc,linker-signed)`、`Sealed Resources=none`、`Info.plist=not bound`
  - `codesign --verify --deep --strict` → `code has no resources but signature indicates they must be present`

### 2.2 Windows EXE "双击无反应"（已重建，链路闭环）

**加载器层面直接崩溃**：
- 原版 exe 是合法 NSIS 3.0.4.1 安装器（PE32 x86 stub，内嵌 7z 载荷 CRC 全部通过，载荷内含完整 win-x64 Electron 应用）。
- 在 Windows 兼容环境（wine）下运行，进程在 **PE 加载器阶段**即失败：
  `could not load kernel32.dll, status c0000135 (STATUS_DLL_NOT_FOUND)` → 进程无声退出 → 对应真实 Windows 上"双击什么都没发生"。
- **关键证据（载荷哈希比对）**：原版 exe 内嵌的 `AlfaProxi.exe` 与 `resources/app.asar` 与**从仓库源码全新构建**的产物哈希完全不同，且原版载荷中**缺少** `resources/app-update.yml`——证明原版是旧工具链/旧源码状态打包的产物，不能当作可信基线。
- **Linux 重建的隐性陷阱**：electron-builder 在 Linux 上构建 NSIS 安装器**强制要求 wine**（app-builder 需用 wine 运行生成的 uninstaller 计算 CRC，见 electron.build/multi-platform-build#linux），报错 `wine is required`。若 wine 不可用/损坏，`electron-builder --win nsis` 必然失败。

### 2.3 启动台三个 AlfaProxi

- 来源：安装卷挂载（2 个 DMG 卷，hdiutil 挂载后 Dock/启动台出现 app）+ `/Applications` 中已安装的 app = 3 个入口。
- 修复：`hdiutil detach` 全部弹出挂载卷，仅保留 `/Applications/AlfaProxi.app`（已重签），启动台只剩一个。

## 三、修复方案（已执行）

### 3.1 macOS DMG

1. 解包 DMG → 对 `AlfaProxi.app` 执行全量 ad-hoc 重签：
   `codesign --force --deep --sign - AlfaProxi.app`
2. 验证：
   - `codesign --verify --deep --strict` → `valid on disk, satisfies its Designated Requirement`
   - 启动验证：HTTP 服务 8848 返回 200、WebSocket 桥 8850 正常 101 握手
   - `spctl` 仍为 rejected（未做 Apple 公证，属正常；仅签名修复，不做公证）
3. 重新打包：
   `hdiutil create -volname "AlfaProxi" -srcfolder <app> -format UDZO -o AlfaProxi-0.1.0-arm64-fixed.dmg`
4. 对已安装的 `/Applications/AlfaProxi.app` 重签 + `xattr -d com.apple.quarantine`，可直接打开。
5. 清理：`hdiutil detach` 所有挂载卷。

### 3.2 Windows EXE（重建，非修补）

**方案：跳过 electron-builder 的 NSIS 步骤，直接用 NSIS 工具链 + 从仓库源码重建的 win-x64 载荷打包。**

1. 载荷：`npx electron-builder --win --dir`（`--dir` 不需要 wine）→ `dist/win-unpacked/`
   - 验证：`AlfaProxi.exe`(188MB PE32+)、`resources/app.asar`(有效 asar 头，198 项，含 electron/main.cjs、bridge/server.js、node_modules/@serialport)、`resources/app.asar.unpacked/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/node.napi.node` 全部在位。
2. 安装器脚本：标准 NSIS 3.x Unicode 脚本（`dist/alfaproxi.nsi`，见仓库）：
   - per-user 安装（`RequestExecutionLevel user`，默认 `%LOCALAPPDATA%\Programs\AlfaProxi`，可改目录）
   - LZMA solid 压缩、CRC check、Start Menu + Desktop 快捷方式、写 HKCU 卸载注册表、`WriteUninstaller`
3. 打包（与 electron-builder 同版本 NSIS 3.0.4.1，Linux 原生，无需 wine）：
   `makensis -V2 alfaproxi.nsi` → `AlfaProxi.Setup.0.1.0-fixed.exe`（84,340,526 B）
4. 结构验证（全通过）：
   - `file` → `PE32 executable (GUI) Intel 80386 ... Nullsoft Installer self-extracting archive`
   - `7z l` → 识别为 NSIS 自解压存档，200 文件 / 285MB 载荷
   - `7z t` → CRC 校验通过
   - 完整解包 → 200 文件，`AlfaProxi.exe`、`app.asar`、serialport win32-x64 绑定齐全

### 3.3 兜底：真实 Windows 验证（GitHub Actions）

在仓库增加 `.github/workflows/windows-build.yml`（已附在交付物中）：在 `windows-latest` 运行器上原生构建 + 冒烟测试：
1. `npm ci` → `npx electron-builder --win nsis`（Windows 上不需要 wine）
2. 静默安装 `/S` → 断言 `%LOCALAPPDATA%\Programs\AlfaProxi\AlfaProxi.exe` 存在
3. 启动 app → 等待 → 断言进程存活 → 截图/日志 → 关闭
4. 上传安装器为 workflow artifact

此工作流可在任意真实 Windows runner 上复现打包与冒烟测试，作为"彻底修复"的最终验证闭环。

## 四、避坑清单（给其他 agent / 后续构建）

1. **DMG**：不配置签名就出包 → 安装即"已损坏"。至少 `codesign --force --deep --sign -`（临时分发）或配置 Developer ID + 公证（正式分发）。不要用"无签名"出 dmg。
2. **EXE**：
   - 不要相信"开发阶段 Mac 上构建、交叉出 win 包"的产物为最终交付物；必须做 Windows 端验证。
   - Linux 上构建 NSIS 必须 wine（且 wine 需能跑 32 位 PE，新版 WoW64 wine 在部分环境无法加载原生 32 位 PE）；**没有可用 wine 时用 makensis 直接打包（本仓库方案），不要卡在 electron-builder 的 wine 依赖上**。
   - 发布前对安装器做结构校验：`file`（PE/NSIS 识别）、`7z l/t`（载荷 CRC）、解包后检查关键文件哈希。
3. **启动台重复图标**：卸载挂载卷（`hdiutil detach`）后只剩 `/Applications` 一个。
4. **载荷一致性**：发布版载荷必须与仓库源码状态对应（哈希可溯），避免把旧构建当基线。
5. **CI 建议**：Windows 安装器一律在 `windows-latest` runner 上构建 + 冒烟测试（见 3.3），不要依赖本地交叉构建。

## 五、交付物清单

| 文件 | 说明 |
|---|---|
| `AlfaProxi.Setup.0.1.0-fixed.exe` | 重建的 Windows 安装器（84MB，结构验证通过） |
| `AlfaProxi-0.1.0-arm64-fixed.dmg` | 修复的 macOS 安装包（签名验证通过，见 DMG 修复段） |
| `dist/alfaproxi.nsi` | NSIS 安装脚本（可复现） |
| `.github/workflows/windows-build.yml` | 真实 Windows CI：构建 + 冒烟测试 |
| `fix-strategy.md` | 本报告 |

## 下载地址（GitHub Release v0.1.0-fixed）
- AlfaProxi-0.1.0-arm64-fixed.dmg | 
- AlfaProxi.Setup.0.1.0-fixed.exe | 
