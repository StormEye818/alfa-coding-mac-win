import UIKit
import Capacitor

/// 原生右侧玻璃导航栏（适配层）。
///
/// 为什么放在原生而不是网页里：
///   · Liquid Glass 的官方实现是 `UIGlassEffect`（iOS 26+），只有原生视图拿得到
///     真正的折射、边缘高光和 `isInteractive` 的触觉级按压反馈；
///     WebView 里只能用 backdrop-filter 近似，永远差一层。
///   · 状态栏（时间/信号/电量）的高度与位置只有原生知道得准；
///     由原生把它放在 safeArea 下方，天然不会被状态栏压住。
///
/// 和网页的分工：
///   · 原生只负责「画导航 + 报选中」，不碰业务；
///   · 网页 `body.native-rail` 时隐藏自带侧栏，内容宽度照旧由 CSS 预留；
///   · 点按 → 触发事件 "select" → 网页点一下对应 tab，复用全部既有逻辑。
@objc(GlassRailPlugin)
public class GlassRailPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "GlassRailPlugin"
    public let jsName = "GlassRail"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActive", returnType: CAPPluginReturnPromise),
    ]

    private var rail: GlassRailView?

    // MARK: - JS API

    /// show({ items: [{id, label, symbol}], activeId })
    @objc func show(_ call: CAPPluginCall) {
        var items: [GlassRailView.Item] = []
        if let raw = call.getArray("items") {
            for case let dict as [String: Any] in raw {
                guard let id = dict["id"] as? String else { continue }
                items.append(GlassRailView.Item(
                    id: id,
                    label: (dict["label"] as? String) ?? id,
                    symbol: (dict["symbol"] as? String) ?? "circle"
                ))
            }
        }
        guard !items.isEmpty else {
            call.reject("items 为空")
            return
        }
        let activeId = call.getString("activeId")

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let host = self.bridge?.viewController?.view else {
                call.reject("没有可挂载的宿主视图")
                return
            }
            let rail = self.rail ?? GlassRailView()
            if rail.superview == nil {
                rail.translatesAutoresizingMaskIntoConstraints = false
                host.addSubview(rail)
                NSLayoutConstraint.activate([
                    // 右缘贴安全区（横屏时 iOS 的右刘海/手势区会体现在 safeArea 里）
                    rail.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -10),
                    // 顶边从状态栏下沿开始 —— 这一条就是「放到右侧状态栏下方」
                    rail.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor, constant: 8),
                    rail.widthAnchor.constraint(equalToConstant: 88),
                    rail.bottomAnchor.constraint(lessThanOrEqualTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -12),
                ])
                rail.alpha = 0
                UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) {
                    rail.alpha = 1
                }
            }
            rail.onSelect = { [weak self] id in
                self?.notifyListeners("select", data: ["id": id])
                // 同时直接调网页的入口：事件通道要 JS 侧显式 addListener 才通，
                // 这里多一条直连，任何情况下点按都能切页。
                let safe = id.replacingOccurrences(of: "'", with: "")
                    .replacingOccurrences(of: "\\", with: "")
                self?.bridge?.webView?.evaluateJavaScript(
                    "window.APXRail && window.APXRail.select('\(safe)')",
                    completionHandler: nil)
            }
            rail.apply(items: items, activeId: activeId, animated: false)
            self.rail = rail
            call.resolve(["shown": true, "width": 88])
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let rail = self?.rail else { call.resolve(); return }
            UIView.animate(withDuration: 0.2, animations: { rail.alpha = 0 }) { _ in
                rail.removeFromSuperview()
            }
            self?.rail = nil
            call.resolve()
        }
    }

    /// setActive({ id }) —— 网页那边切页时同步高亮（比如点内容里的按钮跳转）
    @objc func setActive(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("缺少 id")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.rail?.setActive(id, animated: true)
            call.resolve()
        }
    }
}

// MARK: - 视图

/// 一枚玻璃胶囊 + 竖排按钮。材质全部走系统 API：
///   iOS 26+ : UIGlassEffect(.regular)，选中胶囊额外 tint + isInteractive
///   iOS 15+ : systemUltraThinMaterial 毛玻璃（老系统降级，但不崩）
final class GlassRailView: UIView {

    struct Item {
        let id: String
        let label: String
        let symbol: String
    }

    var onSelect: ((String) -> Void)?

    private let backdrop = UIVisualEffectView(effect: nil)
    private let selection = UIVisualEffectView(effect: nil)
    private let stack = UIStackView()
    private var buttons: [String: RailButton] = [:]
    private(set) var activeId: String?

    private let itemHeight: CGFloat = 62
    private let insetX: CGFloat = 7
    private let insetY: CGFloat = 8

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        clipsToBounds = true
        layer.cornerRadius = 26
        layer.cornerCurve = .continuous

        backdrop.translatesAutoresizingMaskIntoConstraints = false
        addSubview(backdrop)
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        if #available(iOS 26.0, *) {
            let glass = UIGlassEffect(style: .regular)
            glass.isInteractive = false          // 整条栏不跟手，只让每个按钮跟手
            backdrop.effect = glass
        } else {
            backdrop.effect = UIBlurEffect(style: .systemUltraThinMaterialDark)
        }
        backdrop.isUserInteractionEnabled = false

        // 选中胶囊：独立一层玻璃，带 tint 与交互反馈
        selection.translatesAutoresizingMaskIntoConstraints = true
        selection.isUserInteractionEnabled = false
        selection.clipsToBounds = true
        selection.layer.cornerRadius = 19
        selection.layer.cornerCurve = .continuous
        if #available(iOS 26.0, *) {
            let g = UIGlassEffect(style: .regular)
            g.isInteractive = true
            g.tintColor = UIColor.systemBlue.withAlphaComponent(0.45)
            selection.effect = g
        } else {
            selection.effect = UIBlurEffect(style: .systemThinMaterialDark)
            selection.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.35)
        }
        selection.alpha = 0
        addSubview(selection)

        stack.axis = .vertical
        stack.alignment = .fill
        stack.distribution = .fill
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: insetX),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -insetX),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: insetY),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -insetY),
        ])
    }

    func apply(items: [Item], activeId: String?, animated: Bool) {
        if buttons.keys.sorted() != items.map({ $0.id }).sorted() {
            stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            buttons.removeAll()
            for item in items {
                let b = RailButton(item: item)
                b.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
                b.heightAnchor.constraint(equalToConstant: itemHeight).isActive = true
                stack.addArrangedSubview(b)
                buttons[item.id] = b
            }
        } else {
            for item in items { buttons[item.id]?.update(item) }
        }
        self.activeId = activeId ?? items.first?.id
        layoutIfNeeded()
        moveSelection(animated: animated)
    }

    func setActive(_ id: String, animated: Bool) {
        guard buttons[id] != nil else { return }
        activeId = id
        refreshButtonTints()
        moveSelection(animated: animated)
    }

    @objc private func tapped(_ sender: RailButton) {
        setActive(sender.item.id, animated: true)
        onSelect?(sender.item.id)
    }

    private func refreshButtonTints() {
        for (id, b) in buttons { b.setSelected(id == activeId) }
    }

    private func moveSelection(animated: Bool) {
        guard let id = activeId, let b = buttons[id], b.bounds.height > 0 else {
            selection.alpha = 0
            return
        }
        refreshButtonTints()
        // 用 stack 坐标系，胶囊与按钮同层
        let target = convert(b.bounds, from: b).insetBy(dx: 0, dy: 1)
        if selection.alpha == 0 || !animated {
            selection.frame = target
            selection.alpha = 1
            return
        }
        // 系统弹簧：damping 0.78 ≈ SwiftUI .spring(response:0.42, dampingFraction:0.78)
        UIView.animate(withDuration: 0.46,
                       delay: 0,
                       usingSpringWithDamping: 0.78,
                       initialSpringVelocity: 0.25,
                       options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut]) {
            self.selection.frame = target
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // 旋转 / 分屏切换后重贴一次，不做动画
        let old = selection.frame
        moveSelection(animated: false)
        if old != selection.frame { /* 保持静默 */ }
    }
}

/// 单个按钮：SF Symbol + 中文标签，按下时轻微缩放（系统 interactive 之外再加一点手感）
final class RailButton: UIControl {

    let item: GlassRailView.Item
    private let icon = UIImageView()
    private let label = UILabel()

    init(item: GlassRailView.Item) {
        self.item = item
        super.init(frame: .zero)
        layer.cornerRadius = 19
        layer.cornerCurve = .continuous

        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.isUserInteractionEnabled = false

        label.text = item.label
        label.font = .systemFont(ofSize: 10.5, weight: .semibold)
        label.textAlignment = .center
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.8
        label.translatesAutoresizingMaskIntoConstraints = false
        label.isUserInteractionEnabled = false

        addSubview(icon)
        addSubview(label)
        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: centerXAnchor),
            icon.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),
            label.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 5),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
        ])
        update(item)
        setSelected(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(_ item: GlassRailView.Item) {
        label.text = item.label
        icon.image = UIImage(systemName: item.symbol)
    }

    func setSelected(_ on: Bool) {
        icon.tintColor = on ? .white : UIColor.white.withAlphaComponent(0.70)
        label.textColor = on ? .white : UIColor.white.withAlphaComponent(0.62)
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 19, weight: on ? .semibold : .regular)
    }

    override var isHighlighted: Bool {
        didSet {
            let s: CGFloat = isHighlighted ? 0.93 : 1
            UIView.animate(withDuration: 0.30, delay: 0,
                           usingSpringWithDamping: 0.7, initialSpringVelocity: 0.4,
                           options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.transform = CGAffineTransform(scaleX: s, y: s)
            }
        }
    }
}
