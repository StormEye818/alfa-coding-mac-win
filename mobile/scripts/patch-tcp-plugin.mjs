/**
 * 给 @deedarb/capacitor-tcp-socket 补 SPM 支持（幂等，postinstall 调用）。
 *
 * 背景：该插件 iOS 侧只有 CocoaPods 的 podspec（ios/Plugin 传统布局 + ObjC 注册），
 * Capacitor 8 的 SPM 集成会静默跳过它 → 运行时报 "TcpSocket plugin is not implemented on ios"。
 * 本脚本：
 *   1) 写入 Package.swift（排除 .m/.h，混合语言目标 SPM 不支持）
 *   2) 把注册从 ObjC CAP_PLUGIN 宏改为纯 Swift CAPBridgedPlugin 约定
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(__dirname, '..', 'node_modules', '@deedarb', 'capacitor-tcp-socket');
const PLUGIN = path.join(PKG, 'ios', 'Plugin');

if (!fs.existsSync(PLUGIN)) {
  console.log('[patch-tcp] 插件未安装，跳过');
  process.exit(0);
}

// 1) Package.swift
const manifest = `// swift-tools-version: 5.9
// 由 scripts/patch-tcp-plugin.mjs 生成：为 podspec-only 插件补 SPM 支持
import PackageDescription

let package = Package(
    name: "DeedarbCapacitorTcpSocket",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "DeedarbCapacitorTcpSocket", targets: ["TcpSocket"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/Kitura/BlueSocket.git", from: "2.0.0")
    ],
    targets: [
        .target(
            name: "TcpSocket",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "Socket", package: "BlueSocket")
            ],
            path: "ios/Plugin",
            exclude: ["TcpSocketPlugin.m", "TcpSocketPlugin.h"])
    ]
)
`;
fs.writeFileSync(path.join(PKG, 'Package.swift'), manifest);
console.log('[patch-tcp] Package.swift 已写入');

// 2) 纯 Swift 注册（CAPBridgedPlugin）——替换 ObjC 宏注册
const swiftPath = path.join(PLUGIN, 'TcpSocketPlugin.swift');
let swift = fs.readFileSync(swiftPath, 'utf8');
if (!swift.includes('CAPBridgedPlugin')) {
  swift = swift.replace(
    'public class TcpSocketPlugin: CAPPlugin {',
    `public class TcpSocketPlugin: CAPPlugin, CAPBridgedPlugin {
    // [patch-tcp] 纯 Swift 注册（原 .m 的 CAP_PLUGIN 宏已随 SPM exclude 移除）
    public let identifier = "TcpSocketPlugin"
    public let jsName = "TcpSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalAddress", returnType: CAPPluginReturnPromise),
    ]
`);
  fs.writeFileSync(swiftPath, swift);
  console.log('[patch-tcp] Swift 注册已补');
} else {
  console.log('[patch-tcp] Swift 注册已存在，跳过');
}
