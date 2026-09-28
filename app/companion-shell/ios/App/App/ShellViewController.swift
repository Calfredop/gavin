import UIKit
import WebKit
import Capacitor

/// The shell's own Capacitor view: the Workstations hub, which ships in the
/// binary. It is the only webview with a Capacitor bridge, and it never
/// shows anything else -- a Workstation's bundle opens in a webview of its
/// own (`BundleViewController`), because Capacitor's iOS bridge answers
/// every frame of this one.
class ShellViewController: CAPBridgeViewController {
    /// Capacitor's native-bridge.js asks two config questions through a
    /// synchronous `prompt()` at document start. On the iOS 27.0 Simulator
    /// WebKit never delivers that prompt, so the page hangs blank (26.5 is
    /// fine; docs/research/2026-09-28-companion-device-keys.md, "Other
    /// traps"). Both are answered here, before Capacitor's script runs, and
    /// every other `prompt()` passes through untouched.
    ///
    /// Added HERE and not in `webViewConfiguration(for:)`: Capacitor
    /// replaces that configuration's user content controller with its own
    /// right after asking for it, and a script added there is dropped. By
    /// the time this is called the controller is the one that stays, and
    /// Capacitor has not yet added its own scripts to it, so this one runs
    /// first.
    override open func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let shim = """
        (function () {
          var original = window.prompt;
          window.prompt = function (message) {
            try {
              var o = JSON.parse(message);
              if (o && (o.type === 'CapacitorCookies.isEnabled' || o.type === 'CapacitorHttp')) return 'false';
            } catch (e) {}
            return original.apply(window, arguments);
          };
        })();
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        return super.webView(with: frame, configuration: configuration)
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BundleViewPlugin())
    }
}
