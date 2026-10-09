//
//  NotificationService.swift
//  Companion — Notification Service Extension
//
//  Decrypts Companion pushes before display (spec "Notifications",
//  security 06 §5.6). The extension:
//
//  1. Reads the base64 `c` field from the APNs payload.
//  2. Tries each Workstation's notification key (the keychain group the
//     app shares with it, AfterFirstUnlockThisDeviceOnly: SharedKeychain)
//     until ChaCha20-Poly1305 opens (NotifyOpen.swift).
//  3. Labels the alert from the key that worked, never from the payload.
//  4. Drops counters at or below the highest seen for that Workstation.
//  5. On notify: replaces the generic body with the plaintext text, sets
//     the deep link from the target, and replaces a notification already
//     on screen for the same item.
//  6. On resolve: removes the delivered notification for that item id.
//     Showing nothing for the resolve itself needs the
//     notification-filtering entitlement, which Apple grants on request
//     (GavinNotificationFiltering, docs/companion-mobile.md); until a build
//     carries it, the resolve shows as a passive line that makes no sound
//     and does not light the screen, and the hub clears it once open.
//     Ticket 25 chose filtering over a separate background push type so
//     every push stays mutable-content.
//  7. On failure: leaves the fixed generic string; tap opens the hub.
//
//  The format is crates/daemon/src/notify_crypto.rs's, held to it by
//  test-fixtures/companion-notify.
//

import Foundation
import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    /// Whether this build carries the notification-filtering entitlement:
    /// set from the build setting that picks the extension's entitlements
    /// file, so the two cannot disagree.
    static let mayFilter = Bundle.main.object(forInfoDictionaryKey: "GavinNotificationFiltering") as? String == "YES"

    /// What a resolve says when it cannot be hidden.
    static let resolvedBody = "Dealt with at the desk."

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        lock.lock()
        self.contentHandler = contentHandler
        bestAttemptContent = content
        lock.unlock()
        // Until a key opens it: the gateway's placeholder, landing on the hub.
        content.userInfo[DeliveredNotify.linkKey] = NotifyFormat.hubLink

        guard let c = content.userInfo["c"] as? String,
              let sealed = Data(base64Encoded: c),
              let found = Self.open(sealed)
        else {
            log("a push no paired Workstation's key opens")
            deliver(content)
            return
        }
        let paired = found.paired
        let opened = found.opened

        if let highest = SharedKeychain.highestCounter(workstation: paired.id, key: paired.notificationKey),
           opened.counter <= highest {
            // A replay, or a push a newer one overtook: what it said is
            // stale either way.
            log("\(paired.id): counter \(opened.counter) is not past \(highest)")
            quiet(content, workstation: paired, body: NotifyFormat.genericBody)
            return
        }
        SharedKeychain.keepHighestCounter(opened.counter, workstation: paired.id, key: paired.notificationKey)
        log("\(paired.id): \(opened.body.op.rawValue) \(opened.counter)")

        let item = opened.body.id
        switch opened.body.op {
        case .notify:
            content.title = paired.name
            content.body = opened.body.text ?? NotifyFormat.genericBody
            content.threadIdentifier = paired.id
            content.userInfo[DeliveredNotify.linkKey] = notifyLink(opened.body, workstation: paired.id)
            content.userInfo[DeliveredNotify.workstationKey] = paired.id
            content.userInfo[DeliveredNotify.itemKey] = item
            // The desk notifies an item again when what it says changes:
            // the newer one replaces it.
            DeliveredNotify.remove(from: paired.id, where: { $0 == item }) { self.deliver(content) }
        case .resolve:
            DeliveredNotify.remove(from: paired.id, where: { $0 == item }) {
                if Self.mayFilter {
                    // Empty content, with the entitlement, shows nothing.
                    self.deliver(UNNotificationContent())
                } else {
                    self.quiet(content, workstation: paired, body: Self.resolvedBody)
                }
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let content = bestAttemptContent
        lock.unlock()
        if let content { deliver(content) }
    }

    /// The paired Workstation whose key opens `sealed`, and what it said.
    private static func open(_ sealed: Data) -> (paired: SharedKeychain.Paired, opened: OpenedNotify)? {
        for paired in SharedKeychain.paired() {
            if let opened = try? openNotify(key: paired.notificationKey, sealed: sealed) {
                return (paired, opened)
            }
        }
        return nil
    }

    /// A line that makes no sound and does not light the screen, for a push
    /// that cannot be hidden and has nothing to say. It names no item, so
    /// the hub clears it with the rest of that Workstation's once it is open.
    private func quiet(_ content: UNMutableNotificationContent, workstation: SharedKeychain.Paired, body: String) {
        if Self.mayFilter {
            deliver(UNNotificationContent())
            return
        }
        content.title = workstation.name
        content.body = body
        content.sound = nil
        content.threadIdentifier = workstation.id
        content.interruptionLevel = .passive
        content.userInfo[DeliveredNotify.workstationKey] = workstation.id
        deliver(content)
    }

    /// Hands iOS what to show, once: the content handler may be reached
    /// from a keychain answer and from the time running out.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }

    /// Ids and counters only: what a push says never reaches a log.
    private func log(_ line: String) {
        #if DEBUG
        NSLog("[gavin-push] %@", line)
        #endif
    }
}
