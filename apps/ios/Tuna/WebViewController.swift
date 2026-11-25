import AVKit
import Network
import UIKit
@preconcurrency import WebKit

/// The whole app: one full-screen web view showing the Tuna server's interface (or the
/// setup, loading and offline pages bundled with the app), and the player underneath it.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    /// The music: it keeps playing while the page reloads, and with the screen off.
    let player = AudioPlayer()
    private static let background = UIColor(red: 7 / 255, green: 6 / 255, blue: 12 / 255, alpha: 1)
    /// Whether the phone is on mobile data, for the page (it streams smaller files then).
    private let network = NWPathMonitor()
    private(set) var cellular = false
    private var backObservations: [NSKeyValueObservation] = []
    /// The system's speakers-and-headphones button (AirPlay, Bluetooth), out of sight: the page's
    /// own button presses it.
    private lazy var routePicker: AVRoutePickerView = {
        let picker = AVRoutePickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        picker.alpha = 0.01
        picker.isUserInteractionEnabled = false
        view.addSubview(picker)
        return picker
    }()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Lets the interface know it's inside the app ("TunaiOS" in the user agent).
        config.applicationNameForUserAgent = "Mobile/15E148 TunaiOS/\(Bridge.version)"
        config.setURLSchemeHandler(LocalScheme(), forURLScheme: LocalScheme.scheme)
        let scripts = config.userContentController
        scripts.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.add(BridgeHandler(controller: self), name: "tuna")

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.background
        web.scrollView.backgroundColor = Self.background
        // The pages leave room for the notch themselves (viewport-fit=cover).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        // Swiping back goes through Tuna's own pages, never back to the loading page.
        let updateBack: (WKWebView) -> Void = { web in
            DispatchQueue.main.async { web.allowsBackForwardNavigationGestures = Server.owns(web.backForwardList.backItem?.url) }
        }
        backObservations = [
            web.observe(\.url, options: [.initial]) { web, _ in updateBack(web) },
            web.observe(\.canGoBack) { web, _ in updateBack(web) },
        ]
        view = web
        player.onState = { [weak self] state in self?.send(["type": "audio", "state": state]) }
        OfflineStore.shared.onChange = { [weak self] list in self?.send(["type": "event", "name": "downloads", "value": list]) }
    }

    /// The list of speakers and headphones, as in Control Centre; on iPad it points at `rect`, the
    /// page's button.
    func showOutputs(at rect: CGRect) {
        routePicker.frame = rect.width > 0 ? rect : CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        routePicker.layoutIfNeeded()
        func control(in view: UIView) -> UIControl? {
            for sub in view.subviews {
                if let found = sub as? UIControl ?? control(in: sub) { return found }
            }
            return nil
        }
        // As if tapped (the simulator can't show this list; a phone can).
        let button = control(in: routePicker)
        button?.sendActions(for: .touchDown)
        button?.sendActions(for: .touchUpInside)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        network.pathUpdateHandler = { [weak self] path in
            let cellular = path.usesInterfaceType(.cellular)
            DispatchQueue.main.async { self?.cellular = cellular }
        }
        network.start(queue: .global(qos: .utility))
        // Back from the background: the page catches up with the music.
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.player.current != nil else { return }
            self.send(["type": "audio", "state": self.player.state])
        }
        if Server.url != nil { showServer() } else { showSetup(error: nil) }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // ---------- Pages ----------

    /// The server address page.
    func showSetup(error: String?) {
        web.load(URLRequest(url: LocalScheme.url("setup.html", query: error.map { ["error": $0] } ?? [:])))
    }

    /// The fish swims while the server is checked (a few seconds at most), then Tuna opens
    /// from the server's own address. A server that doesn't answer gets the downloads, or the
    /// address page when there are none.
    func showServer() {
        guard let server = Server.url else { return showSetup(error: nil) }
        web.load(URLRequest(url: LocalScheme.url("loading.html")))
        Task { @MainActor in
            do {
                try await Server.probe(server)
                web.load(URLRequest(url: server, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 10))
                OfflineStore.shared.resume()
            } catch {
                if OfflineStore.shared.hasSongs { showOffline() } else { showSetup(error: error.localizedDescription) }
            }
        }
    }

    /// What's downloaded, without the server (apps/common/offline.html).
    func showOffline() {
        web.load(URLRequest(url: LocalScheme.url("offline.html")))
    }

    /// A message for the page: `window.__tuna(message)`.
    func send(_ message: [String: Any]) {
        web.evaluateJavaScript("window.__tuna && window.__tuna(\(Bridge.json(message)))")
    }

    // ---------- Navigation ----------

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        // Frames inside the page load freely.
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        if url.scheme == LocalScheme.scheme || url.scheme == "about" || Server.owns(url) { return decisionHandler(.allow) }
        // Anything else (MusicBrainz, Last.fm links…) opens in Safari.
        if url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// Links that open a new window go to Safari too.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let err = error as NSError
        guard err.code != NSURLErrorCancelled, err.code != 102 /* frame load interrupted */ else { return }
        let failed = err.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        if failed?.scheme == LocalScheme.scheme { return }
        // The server stopped answering: what's downloaded, or back to its address, to try again or change it.
        if OfflineStore.shared.hasSongs { return showOffline() }
        let address = Server.url?.absoluteString ?? ""
        showSetup(error: L("Can't reach {address} ({error})", ["address": address, "error": err.localizedDescription]))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The music plays on; the page asks what's playing when it's back.
        webView.reload()
    }

    // ---------- confirm() / alert() from the pages ----------

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L("OK"), style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L("Cancel"), style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: L("OK"), style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
