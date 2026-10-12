import Capacitor
import Foundation
import Security

/// The Workstations this Device has paired with (`src/shell/native/workstations.ts`).
///
/// Registered on the shell's own Capacitor webview only. Each record is
/// the web layer's JSON, opaque here, in a keychain item of its own under
/// the Workstation's id: this device only, never synchronised, readable
/// after the first unlock, and in the keychain group the app shares with
/// its Notification Service Extension (`SharedKeychain`), which opens a
/// Workstation's push on a locked phone with the record's notification
/// key and labels it with the record's name. That key is why a record
/// lives here and not in the webview's storage -- which the OS may also
/// clear under storage pressure.
///
/// The records go with the Device's keys (`DeviceKeysPlugin.deleteAll`):
/// each names the Device a Workstation paired, and a phone without those
/// keys is no longer that Device.
@objc(WorkstationsPlugin)
public class WorkstationsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WorkstationsPlugin"
    public let jsName = "Workstations"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    static let service = SharedKeychain.workstationService

    @objc func list(_ call: CAPPluginCall) {
        // Pairings kept before the group existed, moved where the
        // extension can read them.
        SharedKeychain.moveIntoGroup(service: Self.service)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
        ]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        switch status {
        case errSecSuccess:
            let items = found as? [[String: Any]] ?? []
            let records = items.compactMap { ($0[kSecValueData as String] as? Data).flatMap { String(data: $0, encoding: .utf8) } }
            call.resolve(["records": records])
        case errSecItemNotFound:
            call.resolve(["records": [String]()])
        default:
            call.reject("the paired Workstations could not be read: OSStatus \(status)", "failed")
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let record = call.getString("record") else {
            call.reject("save needs an id and a record", "failed")
            return
        }
        Self.remove(id: id)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: id,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
            kSecValueData as String: Data(record.utf8),
        ]
        let status = SharedKeychain.add(item)
        guard status == errSecSuccess else {
            call.reject("the Workstation could not be kept: OSStatus \(status)", "failed")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("remove needs an id", "failed")
            return
        }
        Self.remove(id: id)
        call.resolve()
    }

    static func remove(id: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
        ] as CFDictionary)
    }

    static func deleteAll() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        SharedKeychain.deleteCounters()
    }
}
