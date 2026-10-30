import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MfiBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// CAPBridgeViewController 子类：桥在 viewDidLoad 才创建，在此注册 app 内 MFi 插件
/// （cap sync 只登记 npm 插件且会重写 packageClassList，手动条目必须走运行时注册；
///   注意 bridge 是懒创建——SceneDelegate 里注册为时过早，2026-10 真机踩过）
class MfiBridgeViewController: CAPBridgeViewController {
    private var glassRailRegistered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        // MFi 串口：已在 capacitor.config.json 的 packageClassList 里，autoRegister 会带上；
        // 这里保留运行时注册是为了 cap sync 重写配置时兜底。
        bridge?.registerPluginType(MfiSerialPlugin.self)
        registerGlassRail()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // 兜底：若 viewDidLoad 时 bridge 还没就绪，这里再试一次（只成功一次）
        registerGlassRail()
    }

    /// 原生右侧玻璃导航栏（Liquid Glass 适配层，见 GlassRailPlugin.swift）。
    ///
    /// ⚠️ 必须用 registerPluginInstance：Capacitor 8 的 `autoRegisterPlugins` 默认为 true，
    ///    此时 `registerPluginType` 第一行就 `return`（不报错、不注册），插件会静默失效；
    ///    `registerPluginInstance` 不受该开关影响（2026-10-30 实机踩过）。
    private func registerGlassRail() {
        guard !glassRailRegistered, let bridge = bridge else { return }
        bridge.registerPluginInstance(GlassRailPlugin())
        glassRailRegistered = true
        CAPLog.print("[GlassRail] plugin registered")
    }
}
