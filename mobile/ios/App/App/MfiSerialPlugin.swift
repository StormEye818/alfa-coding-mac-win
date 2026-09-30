import Foundation
import Capacitor
import ExternalAccessory

/// MFi External Accessory 串口通道（vLinker MS 等 MFi 认证 OBD 适配器）。
///
/// 背景：MFi 适配器由 iOS 系统持有经典蓝牙链路（设置里显示「已连接」），
/// CoreBluetooth 扫描看不见它——必须走 EAAccessory。
/// 前提：Info.plist 的 UISupportedExternalAccessoryProtocols 声明协议串
/// （适配器实际协议在 list() 返回的 protocolStrings 里可见）。
///
/// JS 侧契约（mobile-bridge.js 的 MfiPort）：
///   list()              → { devices: [{name, serial, model, connectionId, protocolStrings}] }
///   open({connectionId, protocol?}) → { ok }
///   write({data: base64}) → { ok }
///   close()             → { ok }
///   事件 "data"  → { data: base64 }（输入流到达即推，PortLike 的 on('data')）
///   事件 "closed" → {}（会话断开）
@objc(MfiSerialPlugin)
public class MfiSerialPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MfiSerialPlugin"
    public let jsName = "MfiSerial"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private var session: EASession?
    private var readTimer: Timer?
    private var currentProto: String?

    @objc func list(_ call: CAPPluginCall) {
        let accs = EAAccessoryManager.shared().connectedAccessories
        let devices: [[String: Any]] = accs.map { acc in
            [
                "name": acc.name,
                "serial": acc.serialNumber,
                "model": acc.modelNumber,
                "connectionId": Int(acc.connectionID),
                "protocolStrings": acc.protocolStrings,
                "firmware": acc.firmwareRevision,
            ]
        }
        CAPLog.print("[MfiSerial] 已连接配件 \(devices.count) 个: \(devices.map { $0["name"] ?? "?" })")
        call.resolve(["devices": devices])
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let connId = call.getInt("connectionId") else {
            call.reject("缺少 connectionId"); return
        }
        guard let acc = EAAccessoryManager.shared().connectedAccessories.first(where: { Int($0.connectionID) == connId }) else {
            call.reject("配件已断开（connectionId=\(connId)）"); return
        }
        // 协议串：显式指定优先，否则取配件声明的第一个（适配器一般只留一个 MFi 协议）
        let proto = call.getString("protocol") ?? acc.protocolStrings.first
        guard let proto = proto else {
            call.reject("配件无协议串可开（\(acc.name)）"); return
        }
        guard let session = EASession(accessory: acc, forProtocol: proto) else {
            call.reject("EASession 创建失败（协议 \(proto)）"); return
        }
        closeSession()
        self.session = session
        self.currentProto = proto
        // 注意：Capacitor 插件方法在后台队列执行——Timer/流必须挂到主 RunLoop，
        // 否则定时器永不触发、读循环饿死（表现为「端口打开但 ATZ 无应答」，2026-09-30 真机踩过）
        DispatchQueue.main.async {
            session.inputStream?.schedule(in: .main, forMode: .default)
            session.outputStream?.schedule(in: .main, forMode: .default)
            session.inputStream?.open()
            session.outputStream?.open()
            let t = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                self?.pumpInput()
            }
            self.readTimer = t
        }
        CAPLog.print("[MfiSerial] 已打开 \(acc.name) 协议=\(proto)")
        call.resolve(["ok": true, "protocol": proto, "name": acc.name])
    }

    private func pumpInput() {
        guard let input = session?.inputStream else { return }
        var buf = [UInt8](repeating: 0, count: 4096)
        let n = input.read(&buf, maxLength: buf.count)
        if n > 0 {
            let data = Data(buf[0..<n])
            notifyListeners("data", data: ["data": data.base64EncodedString()])
        } else if n < 0 {
            // 流错误/配件拔出
            CAPLog.print("[MfiSerial] 输入流错误，关闭会话")
            closeSession()
            notifyListeners("closed", data: [:])
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("data 需为 base64"); return
        }
        // 同 open：流在主 RunLoop 上，写也在主线程做，避免线程错位
        DispatchQueue.main.async {
            guard let output = self.session?.outputStream else {
                call.reject("会话未打开"); return
            }
            var remaining = data
            var written = 0
            while !remaining.isEmpty {
                let n = remaining.withUnsafeBytes { ptr -> Int in
                    guard let base = ptr.baseAddress else { return -1 }
                    return output.write(base.assumingMemoryBound(to: UInt8.self), maxLength: remaining.count)
                }
                if n <= 0 { call.reject("输出流写失败"); return }
                written += n
                remaining = Data(remaining.dropFirst(n))
            }
            call.resolve(["ok": true, "wrote": written])
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        closeSession()
        call.resolve(["ok": true])
    }

    private func closeSession() {
        readTimer?.invalidate()
        readTimer = nil
        session?.inputStream?.close()
        session?.outputStream?.close()
        session?.inputStream?.remove(from: .main, forMode: .default)
        session?.outputStream?.remove(from: .main, forMode: .default)
        session = nil
    }

    deinit { closeSession() }
}
