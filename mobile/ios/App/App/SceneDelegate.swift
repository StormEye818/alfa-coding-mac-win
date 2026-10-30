import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)

        // 1) 创建 Capacitor WebView 宿主（WKWebView + bridge + 插件）
        let webHost = MfiBridgeViewController()
        webHost.loadViewIfNeeded()   // 触发 viewDidLoad → 注册插件、加载网页

        // 2) 用系统 UITabBarController 包一层（Liquid Glass 侧栏，系统管 UI）
        let sidebarNav = SidebarNav(webHost: webHost, glassRail: webHost.glassRailPlugin)
        window?.rootViewController = sidebarNav
        window?.makeKeyAndVisible()

        // 3) 连接 GlassRail 插件（bridge 就绪后才能拿到）
        if let plugin = webHost.glassRailPlugin {
            plugin.onActiveChanged = { [weak sidebarNav] id in
                sidebarNav?.setSelectedTab(id)
            }
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// CAPBridgeViewController 子类：桥在 viewDidLoad 才创建，在此注册 app 内插件。
/// （cap sync 只登记 npm 插件且会重写 packageClassList，手动条目必须走运行时注册。）
class MfiBridgeViewController: CAPBridgeViewController {
    private(set) var glassRailPlugin: GlassRailPlugin?
    private var glassRailRegistered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge?.registerPluginType(MfiSerialPlugin.self)
        registerGlassRail()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // 兜底：若 viewDidLoad 时 bridge 还没就绪，这里再试一次（只成功一次）
        registerGlassRail()
    }

    /// GlassRail 系统侧栏桥接插件。
    /// ⚠️ 必须用 registerPluginInstance：Capacitor 8 的 autoRegisterPlugins 默认 true，
    ///    此时 registerPluginType 第一行就 return（不报错、不注册）。
    private func registerGlassRail() {
        guard !glassRailRegistered, let bridge = bridge else { return }
        let plugin = GlassRailPlugin()
        bridge.registerPluginInstance(plugin)
        glassRailPlugin = plugin
        glassRailRegistered = true
        CAPLog.print("[GlassRail] plugin registered (system sidebar)")
    }
}
