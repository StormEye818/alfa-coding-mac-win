# AlfaProxi · 阿尔法罗密欧刷隐藏与 PROXI 对齐工具

面向 **Alfa Romeo Giulia (952) / Stelvio (949)** 的桌面工具：刷隐藏功能、PROXI 配置对齐、模块诊断、实时数据、特殊功能执行。

## 安装

| 平台 | 安装包 |
|---|---|
| macOS（Apple Silicon） | `AlfaProxi-0.1.0-arm64.dmg` |
| Windows x64 | `AlfaProxi Setup 0.1.0.exe` |

安装包在 [Releases](../../releases) 页下载。

> ⚠️ 安装包**未签名**。macOS 首次打开请右键 → 打开（或 `xattr -cr /Applications/AlfaProxi.app`）；Windows 会有 SmartScreen 提示，点「仍要运行」。

## 快速开始

1. 适配器接上 OBD 口（推荐 **Vgate vLinker MS**，多路 CAN 自动切换无需换线）
2. 打开 AlfaProxi → 选车型 → 选接口类型 → 选串口 → **连接**（自动读取车辆配置）
3. 「隐藏功能」页改配置项 → **写入 ECU**（自动重算 CRC 并读回校验）
4. 「PROXI 对齐」页 **读取对齐状态** → 对齐未对齐节点 → **里程表停止闪烁即成功**

详细操作见 [docs/使用教程.md](docs/使用教程.md)。

## 安全提示

- **写入前必先导出配置备份**（「导出配置备份」按钮）
- 对齐过程勿断电、勿拔线；建议钥匙 ON、发动机熄火
- 部分配置项存在极性/语义争议（见教程标注），首次使用请小范围验证
- 保养类计数器禁止回拨，工具会拒绝此类写入

## 功能

- **隐藏功能**：命名配置项 44 + 扩展配置项 19，三态显示（待写入 / 已写入 / 写入失败）
- **字节编辑器**：位级编辑、hex 输入、改动高亮、CRC 自动重算
- **PROXI 对齐**：88 节点、逐节点 `22 10 2A` 回读校验、选择性对齐
- **模块诊断**：35 模块故障码读取/清除（3812 条码库）
- **实时数据**：1565 项可读参数，轮询、CSV 导出
- **特殊功能**：539 项 / 20 分类，类型化输入与安全警告

## 开发

```bash
npm install

# 开发模式（两个进程）
node bridge/server.js      # 串口/TCP 桥
npm run app                # 静态服务 → http://localhost:8848/app/

# 桌面壳
npm run electron

# 打包
npm run dist:mac           # macOS dmg
npm run dist:win           # Windows NSIS（arm64 Mac 需设 ELECTRON_BUILDER_NSIS_DIR=.nsis-arm64）
```

测试：`npm test`（协议层单测）；`test-agent1/`（60 项端到端回归，需模拟车 `node sandbox/harness.mjs`）。

## License

仅供个人车辆研究与学习使用。
