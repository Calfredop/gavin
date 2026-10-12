import Capacitor
import Foundation
import Security
import UIKit
import UserNotifications

/// Push for the shell (`src/shell/native/push.ts`): asking to notify, the
/// APNs token, the Push gateway's calls, and the notifications the owner
/// taps or the desk deals with. Registered on the shell's own webview only.
///
/// What a push says is opened by the Notification Service Extension, not
/// here; this side never sees a notification key.
@objc(PushPlugin)
public class PushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushPlugin"
    public let jsName = "Push"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "gateway", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepRegistration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDelivered", returnType: CAPPluginReturnPromise),
    ]

    /// `register` calls waiting for APNs to answer.
    private var waiting: [CAPPluginCall] = []

    static let registrationService = "com.gavin.companion.push"

    /// The Push gateway this build registers with (`GavinPushGateway`, from
    /// the `GAVIN_PUSH_GATEWAY` build setting). Nil when the build names none.
    static let gatewayURL: URL? = {
        guard let text = Bundle.main.object(forInfoDictionaryKey: "GavinPushGateway") as? String,
              !text.isEmpty, !text.contains("$("),
              let url = URL(string: text), url.scheme == "https" || url.scheme == "http"
        else { return nil }
        return url
    }()

    override public func load() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(didRegister(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(didFailToRegister(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
        // Kept until the hub listens: a tap that launched the app arrives
        // before the page does.
        PushTaps.shared.attach { [weak self] tap in
            self?.notifyListeners("opened", data: tap, retainUntilConsumed: true)
        }
    }

    // MARK: asking, and the token

    @objc func status(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            var answer: [String: Any] = [
                "permission": Self.permission(settings.authorizationStatus),
                "environment": Self.apsEnvironment(),
            ]
            if let gateway = Self.gatewayURL { answer["gateway"] = gateway.absoluteString }
            call.resolve(answer)
        }
    }

    /// Asks to notify -- iOS asks the owner only the first time -- and,
    /// once allowed, registers with APNs for this install's token.
    @objc func register(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error {
                call.reject("notifications could not be asked for: \(error.localizedDescription)", "failed")
                return
            }
            guard granted else {
                UNUserNotificationCenter.current().getNotificationSettings { settings in
                    call.resolve(["permission": Self.permission(settings.authorizationStatus)])
                }
                return
            }
            DispatchQueue.main.async {
                self.waiting.append(call)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    @objc private func didRegister(_ notification: Notification) {
        guard let token = notification.object as? Data else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        answerWaiting { $0.resolve(["permission": "granted", "token": hex, "environment": Self.apsEnvironment()]) }
    }

    @objc private func didFailToRegister(_ notification: Notification) {
        let reason = (notification.object as? Error)?.localizedDescription ?? "APNs refused this install"
        answerWaiting { $0.reject("no push token: \(reason)", "failed") }
    }

    private func answerWaiting(_ answer: @escaping (CAPPluginCall) -> Void) {
        DispatchQueue.main.async {
            let calls = self.waiting
            self.waiting = []
            calls.forEach(answer)
        }
    }

    static func permission(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .denied: return "denied"
        case .authorized: return "granted"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "denied"
        }
    }

    /// Which APNs a token came from, as the gateway needs to know: what
    /// this install's provisioning profile says. An App Store or TestFlight
    /// install carries none, and is production.
    static func apsEnvironment() -> String {
        #if targetEnvironment(simulator)
        return "development"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(
                  from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String
        else { return "production" }
        return environment
        #endif
    }

    // MARK: the Push gateway

    /// One call to the Push gateway this build names. Native, not the
    /// page's `fetch`: the gateway answers no CORS, and the hub's page is
    /// another origin. Only `/v1/` paths, and only that gateway.
    @objc func gateway(_ call: CAPPluginCall) {
        guard let base = Self.gatewayURL else {
            call.reject("this build names no Push gateway", "no-gateway")
            return
        }
        guard let method = call.getString("method"), ["GET", "POST", "PUT", "DELETE"].contains(method),
              let path = call.getString("path"), path.hasPrefix("/v1/"), !path.contains(".."),
              let url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)
        else {
            call.reject("not a Push gateway call", "failed")
            return
        }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        if let bearer = call.getString("bearer") {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let body = call.getString("body") {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.utf8)
        }
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                call.reject("the Push gateway could not be reached: \(error.localizedDescription)", "unreachable")
                return
            }
            call.resolve([
                "status": (response as? HTTPURLResponse)?.statusCode ?? 0,
                "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? "",
            ])
        }.resume()
    }

    /// This install's registration with the gateway: its Device id and
    /// secret, opaque JSON here. The secret mints permissions to notify
    /// this phone, so it lives in the keychain, in the app's own group.
    @objc func registration(_ call: CAPPluginCall) {
        var found: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Self.registrationService,
                kSecReturnData as String: true,
            ] as CFDictionary,
            &found
        )
        switch status {
        case errSecSuccess:
            if let data = found as? Data, let record = String(data: data, encoding: .utf8) {
                call.resolve(["record": record])
            } else {
                call.resolve(["record": NSNull()])
            }
        case errSecItemNotFound:
            call.resolve(["record": NSNull()])
        default:
            call.reject("the push registration could not be read: OSStatus \(status)", "failed")
        }
    }

    @objc func keepRegistration(_ call: CAPPluginCall) {
        Self.deleteRegistration()
        guard let record = call.getString("record") else {
            call.resolve()
            return
        }
        let status = SecItemAdd(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Self.registrationService,
                kSecAttrAccount as String: "gateway",
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                kSecAttrSynchronizable as String: false,
                kSecValueData as String: Data(record.utf8),
            ] as CFDictionary,
            nil
        )
        guard status == errSecSuccess else {
            call.reject("the push registration could not be kept: OSStatus \(status)", "failed")
            return
        }
        call.resolve()
    }

    static func deleteRegistration() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: registrationService] as CFDictionary)
    }

    // MARK: notifications on screen

    /// Clears one Workstation's notifications the desk has dealt with:
    /// every one whose item is not in `keep` (all of them without it).
    @objc func clearDelivered(_ call: CAPPluginCall) {
        guard let workstation = call.getString("workstation"), !workstation.isEmpty else {
            call.reject("clearDelivered needs a workstation", "failed")
            return
        }
        let keep = call.getArray("keep", String.self).map(Set.init)
        DeliveredNotify.remove(from: workstation, where: { item in
            guard let keep, let item else { return true }
            return !keep.contains(item)
        }) {
            call.resolve()
        }
    }
}

/// The notification centre's delegate, from launch: a tap that opens the
/// app arrives before the shell's bridge, so it is held here until the
/// plugin attaches.
final class PushTaps: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushTaps()

    private var sink: (([String: Any]) -> Void)?
    private var held: [[String: Any]] = []

    func attach(_ sink: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async {
            self.sink = sink
            self.held.forEach(sink)
            self.held = []
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let info = response.notification.request.content.userInfo
        var tap: [String: Any] = ["link": info[DeliveredNotify.linkKey] as? String ?? DeliveredNotify.hubLink]
        if let workstation = info[DeliveredNotify.workstationKey] as? String { tap["workstation"] = workstation }
        if let item = info[DeliveredNotify.itemKey] as? String { tap["item"] = item }
        DispatchQueue.main.async {
            if let sink = self.sink { sink(tap) } else { self.held.append(tap) }
        }
    }

    /// In front, a notification still shows: it may be another
    /// Workstation's than the one open.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}
