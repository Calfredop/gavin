//! Shared decrypt notes for the phone's native handlers.
//!
//! The AEAD format lives in `notify_crypto.rs`. The iOS Notification
//! Service Extension and the Android FCM data-message handler both:
//!
//! 1. Try each Workstation's notification key until one opens.
//! 2. Take the Workstation label from the key that worked, never from
//!    the payload.
//! 3. Drop a counter lower than the highest seen for that Workstation.
//! 4. On `Notify`, replace the generic placeholder with `text` and set
//!    the deep-link from `target`.
//! 5. On `Resolve`, remove the delivered notification for that `id`
//!    (and show nothing). On iOS that needs the notification-filtering
//!    entitlement or a content-available background push — ticket 25
//!    picks filtering so every push stays mutable-content for the
//!    extension to run.
//! 6. On decrypt failure, leave the fixed generic string and deep-link
//!    only to the Workstations hub.

/// The lock-screen placeholder Apple and Google show when the extension
/// cannot run in time. Deliberately says nothing about the Workstation.
pub const GENERIC_ALERT_BODY: &str = "Something on your Workstation changed.";
