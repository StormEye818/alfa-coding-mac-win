import UIKit
import Capacitor

/// 系统侧栏导航（UITabBarController + UITab）。
///
/// 为什么用系统 API 而不是自绘 UIView：
///   · Liquid Glass 玻璃、尺寸、定位、旋转/折叠适配全部由系统渲染，app 只给 icon + label + 内容。
///   · iPhone Duo 横屏时系统自动把 tab 渲染进右侧竖栏（vertical bar，电池/WiFi 旁边）。
///   · 合盖/展开、旋转全部系统处理，零 UI 维护成本。
///
/// 与网页的分工：
///   · 原生管导航 UI（侧栏），网页管业务内容（WKWebView）。
///   · tab 选中 → evaluateJavaScript("APXRail.select(id)") → 网页切页。
///   · 网页切页（按钮/快捷键）→ GlassRailPlugin.setActive → 原生同步高亮。
///   · 网页 body.native-rail 时隐藏自带 HTML 侧栏。
class SidebarNav: UITabBarController, UITabBarControllerDelegate {

    /// 导航项（与网页 nav.tabs 的 data-tab / label / SF Symbol 对应）
    static let navItems: [(id: String, title: String, symbol: String)] = [
        ("features", "隐藏功能",   "slider.horizontal.3"),
        ("editor",   "字节编辑器", "square.grid.2x2"),
        ("align",    "PROXI 对齐", "scope"),
        ("live",     "实时数据",   "waveform.path.ecg"),
        ("funcs",    "特殊功能",   "bolt.fill"),
        ("diag",     "模块诊断",   "square.stack.3d.up"),
    ]

    private let webHost: UIViewController
    private weak var glassRail: GlassRailPlugin?

    init(webHost: UIViewController, glassRail: GlassRailPlugin?) {
        self.webHost = webHost
        self.glassRail = glassRail
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // 用 .tabBar 模式（不是 .tabSidebar）：
        //   · .tabSidebar 在宽屏时会切成左侧 sidebar（iPad 风格），位置在左不对
        //   · .tabBar 在 Duo 上始终渲染为右侧竖栏（verticalBarEdge = .trailing）
        //   · 合盖/展开/旋转全部是同一套竖栏，不跳位置
        mode = .tabBar
        delegate = self

        // 确保 WebView 提前加载（不等第一个 tab 被选中才加载）
        webHost.loadViewIfNeeded()

        // 创建系统 tab（icon + label + 内容 VC，UI 全部系统渲染）
        tabs = Self.navItems.map { item in
            let tab = UITab(
                title: item.title,
                image: UIImage(systemName: item.symbol),
                identifier: item.id
            ) { [weak self] _ in
                self?.makeContentVC(for: item.id) ?? UIViewController()
            }
            // .pinned 让条目固定显示（竖栏模式下尽量带 label）
            tab.preferredPlacement = .pinned
            return tab
        }

        // 网页 setActive 时同步原生选中态
        glassRail?.onActiveChanged = { [weak self] id in
            self?.setSelectedTab(id)
        }

        // 竖栏/紧凑 tab bar 默认只显示 icon —— 强制显示 label 文字
        let app = UITabBarAppearance()
        app.stackedLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor.white.withAlphaComponent(0.70),
            .font: UIFont.systemFont(ofSize: 10, weight: .medium),
        ]
        app.stackedLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor.white,
            .font: UIFont.systemFont(ofSize: 10, weight: .semibold),
        ]
        app.stackedLayoutAppearance.normal.iconColor = UIColor.white.withAlphaComponent(0.70)
        app.stackedLayoutAppearance.selected.iconColor = .white
        tabBar.standardAppearance = app
        tabBar.scrollEdgeAppearance = app
    }

    /// 每个 tab 的内容 VC：透明背景 + 承载共享的 WebView
    private func makeContentVC(for tabId: String) -> UIViewController {
        let vc = TabContentVC(tabId: tabId, hostVC: webHost)
        vc.onShow = { [weak self] id in self?.notifyWeb(id) }
        return vc
    }

    /// 原生 → 网页：切换内容 + 通知 GlassRail 插件
    private func notifyWeb(_ tabId: String) {
        let js = "window.APXRail && window.APXRail.select('\(tabId)')"
        (webHost as? CAPBridgeViewController)?.bridge?.webView?
            .evaluateJavaScript(js, completionHandler: nil)
        glassRail?.emitSelect(tabId)
    }

    /// 网页 → 原生：同步选中态
    func setSelectedTab(_ tabId: String) {
        guard let idx = Self.navItems.firstIndex(where: { $0.id == tabId }) else { return }
        if idx != selectedIndex {
            selectedIndex = idx   // 系统自动切换 tab + 侧栏高亮
        }
    }

    // MARK: - UITabBarControllerDelegate

    func tabBarController(_ tabBarController: UITabBarController, didSelect tab: UITab) {
        notifyWeb(tab.identifier ?? "")
    }
}

// MARK: - Tab 内容 VC（承载共享 WebView）

/// 轻量容器 VC：把共享的 Capacitor WebView 嵌入自己的视图。
/// 切 tab 时 WebView 被 reparent 到新 VC（不重载，不闪烁）。
class TabContentVC: UIViewController {
    let tabId: String
    private weak var hostVC: UIViewController?
    var onShow: ((String) -> Void)?

    init(tabId: String, hostVC: UIViewController) {
        self.tabId = tabId
        self.hostVC = hostVC
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear   // 透明：WebView 铺满，系统侧栏叠在上方
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        embedHost()
        onShow?(tabId)
    }

    /// 把共享 WebView 挂到当前 VC（从旧父 VC 移过来）
    private func embedHost() {
        guard let host = hostVC, let hostView = host.view else { return }
        // 先从旧父 VC 移除
        if host.parent != nil {
            host.willMove(toParent: nil)
            hostView.removeFromSuperview()
            host.removeFromParent()
        }
        // 挂到当前 VC
        host.willMove(toParent: self)
        hostView.frame = view.bounds
        hostView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(hostView)
        host.didMove(toParent: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        hostVC?.view.frame = view.bounds
    }
}
