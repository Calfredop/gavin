//
//  NotificationService.swift
//  Companion — Notification Service Extension
//
//  Decrypts Companion pushes before display (spec "Notifications",
//  security 06 §5.6). The extension:
//
//  1. Reads the base64 `c` field from the APNs payload.
//  2. Tries each Workstation's notification key (shared keychain access
//     group, AfterFirstUnlockThisDeviceOnly) until ChaCha20-Poly1305 opens.
//  3. Labels the alert from the key that worked.
//  4. Drops counters at or below the highest seen for that Workstation.
//  5. On notify: replaces the generic body with the plaintext text and
//     sets the deep link from the target.
//  6. On resolve: removes the delivered notification for that item id
//     (requires the notification-filtering entitlement so the extension
//     may suppress the alert). Ticket 25 chose filtering over a separate
//     background push type so every push stays mutable-content.
//  7. On failure: leaves the fixed generic string; tap opens the hub.
//
//  Wired into the Xcode project when the store shell ships push
//  (companion-shell Capacitor target + this extension). The Rust format
//  under test is crates/daemon/src/notify_crypto.rs.
//

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        // Decrypt lands here. Until the keychain + ChaCha20-Poly1305 path
        // is linked, leave the publisher's generic placeholder.
        if let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
