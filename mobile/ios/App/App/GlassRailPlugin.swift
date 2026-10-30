import UIKit
import Capacitor

/// 原生侧栏桥接插件（Liquid Glass 系统侧栏）。
///
/// 职责：网页 ↔ 系统 UITabBarController 侧栏的双向通信。
///   · 网页 → 原生：setActive（网页切页时同步侧栏高亮）
///   · 原生 → 网页：select 事件（侧栏点按时通知网页切页）
///
/// UI 全部由系统 UITabBarController 渲染（Liquid Glass、定位、旋转/折叠适配），
/// 本插件不再自绘任何视图（2026-10-31 从 GlassRailView 迁移到系统 API）。
@objc(GlassRailPlugin)
public class GlassRailPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "GlassRailPlugin"
    public let jsName = "GlassRail"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActive", returnType: CAPPluginReturnPromise),
    ]

    /// 当前选中的 tab ID（网页 setActive 时更新，SidebarNav 启动时读取）
    private(set) var activeTabId: String = "features"
    /// setActive 回调（SidebarNav 注册，用于同步侧栏选中态）
    var onActiveChanged: ((String) -> Void)?

    // MARK: - JS API

    /// show：兼容旧协议。系统侧栏由 UITabBarController 管理，无需显式创建。
    @objc func show(_ call: CAPPluginCall) {
        CAPLog.print("[GlassRail] show (system sidebar managed by UITabBarController)")
        call.resolve(["shown": true, "system": true])
    }

    /// hide：兼容旧协议。系统侧栏随 UITabBarController 自动管理显隐。
    @objc func hide(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// setActive({ id }) —— 网页切页时同步侧栏高亮
    @objc func setActive(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        activeTabId = id
        onActiveChanged?(id)
        call.resolve()
    }

    // MARK: - 原生 → 网页

    /// 侧栏点按时通知网页（SidebarNav 调用）
    func emitSelect(_ id: String) {
        notifyListeners("select", data: ["id": id])
    }
}
