import UserNotifications

/// What a delivered Companion notification carries besides its text: the
/// extension writes it, the app reads it when one is tapped and when it
/// clears the ones the desk has dealt with. Built into both targets.
enum DeliveredNotify {
    /// Where a tap lands (`notifyLink`).
    static let linkKey = "gavin.link"
    /// The Workstation whose key opened it.
    static let workstationKey = "gavin.ws"
    /// The item it is about, as the desk named it.
    static let itemKey = "gavin.item"
    /// Where a tap lands that has nowhere better to: the hub.
    static let hubLink = "gavin://hub"

    /// Removes the notifications from `workstation` still on screen whose
    /// item `remove` picks, then calls `done`, on any queue.
    static func remove(from workstation: String, where remove: @escaping (String?) -> Bool, then done: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let gone = delivered
                .filter {
                    let info = $0.request.content.userInfo
                    return info[workstationKey] as? String == workstation && remove(info[itemKey] as? String)
                }
                .map(\.request.identifier)
            if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: gone) }
            done()
        }
    }
}
