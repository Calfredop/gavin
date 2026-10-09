import CryptoKit
import Foundation
import Security

/// The keychain items the app writes and its Notification Service
/// Extension reads, in the one access group both are entitled to
/// (`$(AppIdentifierPrefix)com.gavin.companion.shared`, in App.entitlements
/// and NotificationService.entitlements). Built into both targets.
///
/// What crosses is the paired Workstations' records -- the extension needs
/// each one's notification key and name to open a push on a locked phone --
/// and the extension's own highest counter per Workstation. Nothing else:
/// the Device's keys stay in the app's own group, which is listed first in
/// the app's entitlements so that an item saved without a group still goes
/// there.
enum SharedKeychain {
    /// The group, from the target's Info.plist (`GavinKeychainGroup`, which
    /// expands `$(AppIdentifierPrefix)` the way the entitlements do). Nil
    /// in a build whose plist does not name one.
    static let group: String? = {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "GavinKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(")
        else { return nil }
        return group
    }()

    /// One item a paired Workstation, under its id (`WorkstationsPlugin`).
    static let workstationService = "com.gavin.companion.workstation"
    /// One item a Workstation's notification key: the highest counter the
    /// extension has shown from it.
    static let counterService = "com.gavin.companion.notify-counter"

    /// Adds `item` in the shared group. A build whose entitlements do not
    /// carry the group -- one signed with no entitlements at all -- is
    /// refused it, and keeps the item in its own group instead: its pushes
    /// cannot be opened, but its pairings still are kept.
    static func add(_ item: [String: Any]) -> OSStatus {
        guard let group else { return SecItemAdd(item as CFDictionary, nil) }
        var shared = item
        shared[kSecAttrAccessGroup as String] = group
        let status = SecItemAdd(shared as CFDictionary, nil)
        guard status == errSecMissingEntitlement else { return status }
        NSLog("[gavin-push] the keychain group %@ is not in this build's entitlements; kept outside it", group)
        return SecItemAdd(item as CFDictionary, nil)
    }

    /// Moves every item of `service` saved before the group existed into
    /// it, so the extension can read pairings made by an older build.
    static func moveIntoGroup(service: String) {
        guard let group else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
              let items = found as? [[String: Any]]
        else { return }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  let current = item[kSecAttrAccessGroup as String] as? String,
                  current != group
            else { continue }
            let status = SecItemUpdate(
                [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service,
                    kSecAttrAccount as String: account,
                    kSecAttrAccessGroup as String: current,
                ] as CFDictionary,
                [kSecAttrAccessGroup as String: group] as CFDictionary
            )
            if status != errSecSuccess {
                NSLog("[gavin-push] %@ could not move into the shared keychain group: OSStatus %d", account, status)
            }
        }
    }

    /// A paired Workstation as the extension needs it: which, what to call
    /// it, and the key its pushes are sealed with.
    struct Paired {
        let id: String
        let name: String
        let notificationKey: Data
    }

    /// Every paired Workstation whose record names a usable key. The
    /// records are the hub's JSON (`src/shell/hub/paired.ts`).
    static func paired() -> [Paired] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: workstationService,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnData as String: true,
        ]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
              let records = found as? [Data]
        else { return [] }
        return records.compactMap { data in
            guard let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = record["id"] as? String,
                  let name = record["name"] as? String,
                  let hex = record["notificationKey"] as? String,
                  let key = Data(hex: hex), key.count == 32
            else { return nil }
            return Paired(id: id, name: name, notificationKey: key)
        }
    }

    /// The highest counter shown from this Workstation under this key. A
    /// pairing again gets a new key and starts its count over, so the
    /// count is kept per key, not per Workstation.
    static func highestCounter(workstation: String, key: Data) -> UInt64? {
        var found: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: counterService,
                kSecAttrAccount as String: counterAccount(workstation, key),
                kSecReturnData as String: true,
            ] as CFDictionary,
            &found
        )
        guard status == errSecSuccess, let data = found as? Data,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return UInt64(text)
    }

    static func keepHighestCounter(_ counter: UInt64, workstation: String, key: Data) {
        let account = counterAccount(workstation, key)
        let value = Data(String(counter).utf8)
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: counterService,
            kSecAttrAccount as String: account,
        ]
        if SecItemUpdate(match as CFDictionary, [kSecValueData as String: value] as CFDictionary) == errSecItemNotFound {
            var item = match
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            item[kSecAttrSynchronizable as String] = false
            item[kSecValueData as String] = value
            _ = add(item)
        }
    }

    static func deleteCounters() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: counterService] as CFDictionary)
    }

    private static func counterAccount(_ workstation: String, _ key: Data) -> String {
        let digest = SHA256.hash(data: key).prefix(8).map { String(format: "%02x", $0) }.joined()
        return "\(workstation):\(digest)"
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
