import UIKit
import Capacitor

/// The shell's bundle webview, as its web layer drives it
/// (`src/shell/native/bundleView.ts`).
///
/// Registered on the shell's own Capacitor webview only. A bundle cannot
/// call it: its webview has no bridge. What a bundle says arrives here as a
/// `message` event, after `BundleViewController` has checked where it came
/// from, and the shell's answer goes back through `post`.
@objc(BundleViewPlugin)
public class BundleViewPlugin: CAPPlugin, CAPBridgedPlugin, BundleViewEvents {
    public let identifier = "BundleViewPlugin"
    public let jsName = "BundleView"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeRequested", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prune", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "devPublisherKey", returnType: CAPPluginReturnPromise),
    ]

    /// The one open bundle. Opening another closes it first.
    private var current: BundleViewController?

    @objc func open(_ call: CAPPluginCall) {
        guard let session = call.getInt("session"), let workstation = call.getString("workstation"),
              let bundle = call.getString("bundle")
        else {
            call.reject("open needs a session, a workstation and a bundle")
            return
        }
        guard BundleOrigin.isHost(workstation), let root = BundleCatalog.folder(for: bundle) else {
            call.reject("this app carries no UI for “\(workstation)”")
            return
        }
        DispatchQueue.main.async {
            self.current?.dismiss(animated: false)
            self.current = nil
            guard let parent = self.bridge?.viewController else {
                call.reject("the shell has no view to open it over")
                return
            }
            let controller = BundleViewController(session: session, host: workstation, root: root, events: self)
            self.current = controller
            controller.present(over: parent)
            // Answered before the page loads: its first message then follows
            // the answer to the shell's web layer instead of racing it.
            call.resolve(["origin": controller.origin])
            controller.load()
        }
    }

    @objc func post(_ call: CAPPluginCall) {
        guard let session = call.getInt("session"), let data = call.getString("data") else {
            call.reject("post needs a session and data")
            return
        }
        DispatchQueue.main.async {
            if let controller = self.current, controller.session == session {
                controller.deliver(data)
            }
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let session = call.getInt("session") else {
            call.reject("close needs a session")
            return
        }
        DispatchQueue.main.async {
            if let controller = self.current, controller.session == session {
                controller.dismiss(animated: true)
                self.current = nil
            }
            call.resolve()
        }
    }

    /// Only a web link, and only to the system browser -- never a view
    /// inside the app.
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme == "https" || url.scheme == "http"
        else {
            call.reject("only a web link opens outside the app")
            return
        }
        NSLog("[gavin-shell] opening %@ in the system browser", raw)
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("the system would not open \(raw)") }
            }
        }
    }

    /// Launched with `-GavinBundleProbe YES` (scripts/probe.sh). Never in a
    /// release build.
    @objc func probeRequested(_ call: CAPPluginCall) {
        #if DEBUG
        call.resolve(["probe": UserDefaults.standard.bool(forKey: "GavinBundleProbe")])
        #else
        call.resolve(["probe": false])
        #endif
    }

    // MARK: the cache

    @objc func installed(_ call: CAPPluginCall) {
        guard let hash = call.getString("hash") else {
            call.reject("installed needs a hash")
            return
        }
        call.resolve(["installed": BundleCache.installed(hash)])
    }

    /// Only the shell's web layer reaches this, and only with the files of
    /// a bundle the Companion core verified and unpacked.
    @objc func install(_ call: CAPPluginCall) {
        guard let hash = call.getString("hash"), let list = call.getArray("files") else {
            call.reject("install needs a hash and the files")
            return
        }
        var files: [(path: String, data: String)] = []
        for entry in list {
            guard let file = entry as? [String: Any], let path = file["path"] as? String, let data = file["data"] as? String else {
                call.reject("a bundle file is a path and its data")
                return
            }
            files.append((path: path, data: data))
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try BundleCache.install(hash, files: files)
                NSLog("[gavin-shell] installed bundle %@ (%d files)", String(hash.prefix(12)), files.count)
                call.resolve()
            } catch {
                call.reject("the bundle could not be installed: \(error)")
            }
        }
    }

    @objc func prune(_ call: CAPPluginCall) {
        let keep = Set((call.getArray("keep") as? [String]) ?? [])
        DispatchQueue.global(qos: .utility).async {
            BundleCache.prune(keep: keep)
            call.resolve()
        }
    }

    /// The dev key's public half, in a DEBUG build; null in a release.
    @objc func devPublisherKey(_ call: CAPPluginCall) {
        if let key = BundleCatalog.devPublisherKey() {
            call.resolve(["key": key])
        } else {
            call.resolve(["key": NSNull()])
        }
    }

    // MARK: BundleViewEvents

    func bundle(_ session: Int, said data: String, from origin: String) {
        notifyListeners("message", data: ["session": session, "origin": origin, "data": data])
    }

    func bundle(_ session: Int, dropped origin: String, mainFrame: Bool) {
        notifyListeners("dropped", data: ["session": session, "origin": origin, "mainFrame": mainFrame])
    }
}
