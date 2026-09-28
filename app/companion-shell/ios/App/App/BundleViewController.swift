import UIKit
import WebKit
import CryptoKit

/// What a bundle's view tells the plugin.
protocol BundleViewEvents: AnyObject {
    func bundle(_ session: Int, said data: String, from origin: String)
    func bundle(_ session: Int, dropped origin: String, mainFrame: Bool)
}

/// A Workstation's UI bundle, full-screen over the hub (ADR 0005, "Store
/// compliance").
///
/// A plain `WKWebView` the shell makes itself -- not a Capacitor webview --
/// so the page has no bridge: no `Capacitor` global and no `bridge` message
/// handler, and no plugin it could call. Its one outlet is `gavinChannel`,
/// which this controller checks natively before anything reaches the
/// shell's web layer: the bundle's main frame, at the bundle's own origin,
/// sending a string. Anything else is dropped and reported by origin alone.
///
/// The page is served from `gavin-bundle://<workstation>` by
/// `BundleSchemeHandler`, keeps its storage in a data store of its own, and
/// never navigates anywhere else: a tapped web link opens in the system
/// browser, and every other navigation is cancelled.
final class BundleViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let session: Int
    let host: String
    let origin: String
    private let root: URL
    private weak var events: BundleViewEvents?
    private var webView: WKWebView?

    /// Declares `window.gavinChannel` in the bundle's main frame: the shape
    /// the bundle's `shellPort` reads, which is also the one Android's
    /// `addWebMessageListener` injects. Messages cross as strings.
    private static let channelScript = """
    (function () {
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.gavinChannel;
      if (!handler || window.gavinChannel) return;
      var channel = {
        onmessage: null,
        postMessage: function (message) { handler.postMessage(String(message)); }
      };
      Object.defineProperty(window, "gavinChannel", { value: channel, configurable: false, enumerable: false, writable: false });
    })();
    """

    init(session: Int, host: String, root: URL, events: BundleViewEvents) {
        self.session = session
        self.host = host
        self.origin = BundleOrigin.origin(host: host)
        self.root = root
        self.events = events
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    /// The desktop theme's base colour, behind the page while it loads.
    private static let base = UIColor { traits in
        traits.userInterfaceStyle == .light
            ? UIColor(red: 1, green: 1, blue: 1, alpha: 1)
            : UIColor(red: 0x1e / 255, green: 0x1e / 255, blue: 0x1e / 255, alpha: 1)
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(BundleSchemeHandler(host: host, root: root), forURLScheme: BundleOrigin.scheme)
        configuration.websiteDataStore = BundleViewController.dataStore(for: host)
        let controller = configuration.userContentController
        controller.add(ChannelGate(self), contentWorld: .page, name: "gavinChannel")
        controller.addUserScript(
            WKUserScript(source: Self.channelScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.base
        webView.scrollView.backgroundColor = Self.base
        // The page places itself around the notch (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        self.webView = webView

        let container = UIView()
        container.backgroundColor = Self.base
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        view = container
    }

    /// Each Workstation's storage is its own and survives visits, so the
    /// bundle remembers where the human was (spec, story 34). Before iOS 17
    /// there is no store per identifier, and it lasts one visit.
    private static func dataStore(for host: String) -> WKWebsiteDataStore {
        if #available(iOS 17.0, *) {
            let digest = Array(SHA256.hash(data: Data("gavin.companion.bundle.\(host)".utf8)))
            let uuid = UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
                                   digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]))
            return WKWebsiteDataStore(forIdentifier: uuid)
        }
        return .nonPersistent()
    }

    // MARK: presenting

    /// Slides in over the hub. A child of the shell's controller rather than
    /// a modal: the hub's webview stays in the window, where WebKit keeps
    /// its page running -- and that page is the shell's end of the channel.
    func present(over parent: UIViewController) {
        parent.addChild(self)
        view.frame = parent.view.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.transform = CGAffineTransform(translationX: parent.view.bounds.width, y: 0)
        parent.view.addSubview(view)
        didMove(toParent: parent)
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut]) {
            self.view.transform = .identity
        }
    }

    func dismiss(animated: Bool) {
        let finish = {
            self.webView?.stopLoading()
            self.webView?.configuration.userContentController.removeAllScriptMessageHandlers()
            self.webView = nil
            self.willMove(toParent: nil)
            self.view.removeFromSuperview()
            self.removeFromParent()
        }
        guard animated, let width = view.superview?.bounds.width else {
            finish()
            return
        }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseIn], animations: {
            self.view.transform = CGAffineTransform(translationX: width, y: 0)
        }, completion: { _ in finish() })
    }

    func load() {
        guard let url = URL(string: "\(origin)/") else { return }
        webView?.load(URLRequest(url: url))
    }

    // MARK: the channel

    /// Hands a message to the bundle's main frame.
    func deliver(_ data: String) {
        webView?.callAsyncJavaScript(
            "const c = window.gavinChannel; if (c && typeof c.onmessage === 'function') c.onmessage({ data });",
            arguments: ["data": data],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        let frame = message.frameInfo
        let from = BundleOrigin.describe(frame.securityOrigin)
        let own = frame.securityOrigin.protocol == BundleOrigin.scheme
            && frame.securityOrigin.host == host
            && frame.securityOrigin.port == 0
        guard message.webView === webView, frame.isMainFrame, own, let data = message.body as? String else {
            NSLog("[gavin-shell] bundle %@: dropped a channel message from %@ (main frame: %@)",
                  host, from, frame.isMainFrame ? "yes" : "no")
            events?.bundle(session, dropped: from, mainFrame: frame.isMainFrame)
            return
        }
        events?.bundle(session, said: data, from: from)
    }

    // MARK: nothing else navigates

    private func isOwn(_ url: URL) -> Bool {
        url.scheme == BundleOrigin.scheme && url.host == host && url.port == nil
    }

    private static func isWebLink(_ url: URL) -> Bool {
        url.scheme == "https" || url.scheme == "http"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isOwn(url) {
            decisionHandler(.allow)
            return
        }
        // A frame the page writes itself (srcdoc, about:blank) holds nothing
        // from anywhere else; its script is still the page's own files.
        let subframe = action.targetFrame.map { !$0.isMainFrame } ?? false
        if subframe && (url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc") {
            decisionHandler(.allow)
            return
        }
        if action.navigationType == .linkActivated && Self.isWebLink(url) {
            UIApplication.shared.open(url)
        } else {
            NSLog("[gavin-shell] bundle %@: blocked a navigation to %@", host, url.absoluteString)
        }
        decisionHandler(.cancel)
    }

    /// `window.open` and `target=_blank`: never a second webview. A tapped
    /// web link goes to the system browser, as above.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.navigationType == .linkActivated, let url = action.request.url, Self.isWebLink(url) {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// The `gavinChannel` script-message handler. A separate object because
/// the user content controller holds its handlers strongly, and the view
/// controller holds the user content controller.
private final class ChannelGate: NSObject, WKScriptMessageHandler {
    private weak var owner: BundleViewController?

    init(_ owner: BundleViewController) {
        self.owner = owner
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}
