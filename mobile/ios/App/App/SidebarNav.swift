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
    /// WebView 固定挂在这里，永不移动（避免切页 reparent 白闪）
    private let contentContainer = UIView()

    init(webHost: UIViewController, glassRail: GlassRailPlugin?) {
        self.webHost = webHost
        self.glassRail = glassRail
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        mode = .tabBar
        delegate = self
        view.backgroundColor = .clear

        // ---- WebView 固定容器（挂在 UITabBarController.view 底层，永不移动）----
        // 切 tab 时 TabContentVC 只触发 evaluateJavaScript 切内容，
        // 不再 reparent WebView → 消除白闪（removeFromSuperview 那一帧）。
        contentContainer.backgroundColor = .clear
        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(contentContainer, at: 0)
        NSLayoutConstraint.activate([
            contentContainer.topAnchor.constraint(equalTo: view.topAnchor),
            contentContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        // WebView 作为 SidebarNav 的 child VC（Capacitor bridge 需要），
        // 其 view 固定在 contentContainer 里
        addChild(webHost)
        webHost.view.translatesAutoresizingMaskIntoConstraints = false
        contentContainer.addSubview(webHost.view)
        NSLayoutConstraint.activate([
            webHost.view.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            webHost.view.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            webHost.view.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            webHost.view.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor),
        ])
        webHost.didMove(toParent: self)

        // 确保 WebView 提前加载
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

    /// 每个 tab 的内容 VC：透明覆盖层，不承载 WebView
    private func makeContentVC(for tabId: String) -> UIViewController {
        let vc = TabContentVC(tabId: tabId)
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

// MARK: - Tab 内容 VC（透明覆盖层，不承载 WebView）

/// 透明覆盖 VC：WebView 固定在 SidebarNav.contentContainer 里，
/// 本 VC 只负责在出现时触发 evaluateJavaScript 切内容。
/// 不 reparent WebView → 消除切页白闪。
class TabContentVC: UIViewController {
    let tabId: String
    var onShow: ((String) -> Void)?

    init(tabId: String) {
        self.tabId = tabId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear   // 透明：WebView 在底层可见
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onShow?(tabId)   // 只切内容，不移动 WebView
    }
}
