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

        // 2) 只有 iPhone Duo（有右侧竖栏的设备）才用系统 UITabBarController 侧栏；
        //    其他设备（普通 iPhone/iPad）保持原有网页导航，零改动。
        if Self.hasVerticalBar(windowScene) {
            let sidebarNav = SidebarNav(webHost: webHost, glassRail: webHost.glassRailPlugin)
            window?.rootViewController = sidebarNav
            if let plugin = webHost.glassRailPlugin {
                plugin.onActiveChanged = { [weak sidebarNav] id in
                    sidebarNav?.setSelectedTab(id)
                }
            }
        } else {
            window?.rootViewController = webHost
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// 设备是否有系统竖栏（iPhone Duo 右侧 vertical bar）。
    /// iOS 27.1+ 用 UIVerticalBarEdge trait 精确判断；其他版本一律走旧路径。
    static func hasVerticalBar(_ scene: UIWindowScene) -> Bool {
        if #available(iOS 27.1, *) {
            return scene.traitCollection.verticalBarEdge != .unspecified
        }
        return false   // 非 27.1+ 设备：无竖栏，保持网页导航
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

    /// GlassRail 系统侧栏桥接插件 —— **只在 iPhone Duo（有竖栏的设备）注册**。
    /// 非 Duo 设备不注册 → 网页 show() 调用失败 → 走网页导航回退，零影响。
    /// ⚠️ 必须用 registerPluginInstance：Capacitor 8 的 autoRegisterPlugins 默认 true，
    ///    此时 registerPluginType 第一行就 return（不报错、不注册）。
    private func registerGlassRail() {
        guard !glassRailRegistered, let bridge = bridge else { return }
        // 设备隔离：只有竖栏设备才注册系统侧栏插件
        if #available(iOS 27.1, *) {
            guard traitCollection.verticalBarEdge != .unspecified else {
                CAPLog.print("[GlassRail] skipped (no vertical bar, using web navigation)")
                return
            }
        } else {
            return   // 非 27.1+：无竖栏，保持网页导航
        }
        let plugin = GlassRailPlugin()
        bridge.registerPluginInstance(plugin)
        glassRailPlugin = plugin
        glassRailRegistered = true
        CAPLog.print("[GlassRail] plugin registered (system sidebar)")
    }
}
