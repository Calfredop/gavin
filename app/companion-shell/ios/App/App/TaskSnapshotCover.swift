import UIKit

/// Opaque cover over the whole window so the OS task snapshot never holds
/// Workstation content (hub inbox or a presented bundle). Independent of
/// the Unlock's briefBackground grace: resign-active is when the system
/// captures the frame.
enum TaskSnapshotCover {
    private static let tag = 0x6A_76_6E_63 // 'jvnc'

    static func show(on window: UIWindow?) {
        guard let window else { return }
        if window.viewWithTag(tag) != nil { return }
        let cover = UIView(frame: window.bounds)
        cover.tag = tag
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
                : .white
        }
        cover.isUserInteractionEnabled = true
        window.addSubview(cover)
    }

    static func hide(from window: UIWindow?) {
        window?.viewWithTag(tag)?.removeFromSuperview()
    }
}
