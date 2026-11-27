import AppKit
import AVKit
@preconcurrency import WebKit

/// The Tuna window: the Tuna interface from your server in a web view, with the app's own
/// player (AudioPlayer) playing what the page queues. Closing the window keeps the music going.
final class MainWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let audio = AudioPlayer()
    private(set) var web: WKWebView!
    /// The interface's own background (--bg), so the title bar runs into it.
    private static let background = NSColor(red: 11 / 255, green: 10 / 255, blue: 16 / 255, alpha: 1)
    /// The system's AirPlay button, out of sight: the page's own button presses it.
    private lazy var routePicker: AVRoutePickerView = {
        let picker = HiddenRoutePicker(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        picker.player = audio.routedPlayer
        picker.alphaValue = 0.01
        web.addSubview(picker)
        return picker
    }()

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Tuna"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = Self.background
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 720, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        // Closed is only hidden: the Dock icon brings it back, music still playing.
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("Tuna")
        super.init(window: window)
        window.delegate = self
        buildContent()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildContent() {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 TunaDesktop/\(Bridge.version)"
        config.setURLSchemeHandler(LocalScheme(), forURLScheme: LocalScheme.scheme)
        let scripts = config.userContentController
        scripts.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.add(Bridge(window: self), name: "tuna")

        web = WKWebView(frame: .zero, configuration: config)
        web.autoresizingMask = [.width, .height]
        // The window's colour shows until the page has drawn (no white flash).
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) { web.isInspectable = true }
        window?.contentView = web

        audio.onState = { [weak self] state in self?.send(["type": "audio", "state": state]) }
        OfflineStore.shared.onChange = { [weak self] list in self?.send(["type": "event", "name": "downloads", "value": list]) }
        // Away from home: the player, the downloads and the page through the tunnel while it's on.
        Tunnel.shared.onChange = { [weak self] in
            self?.audio.proxyPort = Tunnel.shared.port
            OfflineStore.shared.tunnelPort = Tunnel.shared.port
            self?.send(["type": "event", "name": "tunnel", "value": Tunnel.shared.status])
        }
        Tunnel.shared.watchNetwork()
        startSelfTest()

        if let server = Server.url { start(server) } else { showSetup(error: nil) }
    }

    // ---------- Pages ----------

    /// The address page; with `retry`, it tries the saved server again by itself every few seconds.
    func showSetup(error: String?, retry: Bool = false) {
        var query: [String: String] = [:]
        if let error { query["error"] = error }
        if retry { query["retry"] = "1" }
        web.load(URLRequest(url: LocalScheme.url("setup.html", query: query)))
    }

    /// Opening: the fish swims while the server is checked (a few seconds at most), through the
    /// tunnel away from home when there is one, then Tuna, or what's downloaded, or the address page
    /// saying it can't be reached.
    private func start(_ server: URL) {
        web.load(URLRequest(url: LocalScheme.url("loading.html")))
        Task { @MainActor in
            // Away from home, through the tunnel when there is one: a tunnel above the mark on the
            // loading page; once through, Tuna (#tunnel) takes it over and reels the logo through it.
            let says = { (state: String) in self.web.evaluateJavaScript("window.tunaTunnel && window.tunaTunnel('\(state)')") }
            switch await Tunnel.shared.route(server, connecting: { says("connecting") }) {
            case .home:
                open(server)
                OfflineStore.shared.resume()
            case .away:
                _ = try? await web.evaluateJavaScript("window.tunaTunnel && window.tunaTunnel('connected')")
                try? await Task.sleep(nanoseconds: 900_000_000)
                var through = URLComponents(url: server, resolvingAgainstBaseURL: false)
                through?.fragment = "tunnel"
                open(through?.url ?? server)
                OfflineStore.shared.resume()
            case .none: unreachable(server)
            }
        }
    }

    /// After the address page has checked the server, and from the offline page.
    func openServer() {
        guard let server = Server.url else { return showSetup(error: nil) }
        Task { @MainActor in
            if await Tunnel.shared.route(server) == .none {
                unreachable(server)
            } else {
                open(server)
                OfflineStore.shared.resume()
            }
        }
    }

    /// What's downloaded, without the server (apps/common/offline.html).
    func showOffline() {
        web.load(URLRequest(url: LocalScheme.url("offline.html")))
    }

    private func unreachable(_ server: URL) {
        if OfflineStore.shared.hasSongs { return showOffline() }
        showSetup(error: L("Can't reach {address}", ["address": server.absoluteString]), retry: true)
    }

    func goHome() {
        if let server = Server.url { open(server) }
    }

    func reload() {
        web.reload()
    }

    private func open(_ url: URL) {
        web.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 10))
    }

    /// The list of speakers (AirPlay), opening from `rect`, the page's button (in the page's coordinates).
    func showOutputs(at rect: NSRect) {
        let y = web.isFlipped ? rect.minY : web.bounds.height - rect.maxY
        routePicker.frame = rect.width > 0 ? NSRect(x: rect.minX, y: y, width: rect.width, height: rect.height) : NSRect(x: web.bounds.midX, y: web.bounds.midY, width: 1, height: 1)
        routePicker.layoutSubtreeIfNeeded()
        func button(in view: NSView) -> NSButton? {
            for sub in view.subviews {
                if let found = sub as? NSButton ?? button(in: sub) { return found }
            }
            return nil
        }
        button(in: routePicker)?.performClick(nil)
    }

    // ---------- Talking to the page ----------

    /// A message for the page: `window.__tuna(message)`.
    func send(_ message: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(message), let data = try? JSONSerialization.data(withJSONObject: message), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.__tuna && window.__tuna(\(json))", completionHandler: nil)
    }

    // ---------- Navigation ----------

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        if url.scheme == LocalScheme.scheme || url.scheme == "about" || Server.owns(url) { return decisionHandler(.allow) }
        // Anything else (MusicBrainz, Last.fm…) opens in the browser.
        if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    /// A page's "choose a file".
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        guard let window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let err = error as NSError
        guard err.code != NSURLErrorCancelled, err.code != 102 else { return }
        if (err.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.scheme == LocalScheme.scheme { return }
        // The server stopped answering. The music (already loaded) plays on.
        if let server = Server.url { unreachable(server) } else { showSetup(error: nil) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // confirm() / alert() from the pages.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        guard let window else { return completionHandler() }
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        guard let window else { return completionHandler(false) }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: L("OK"))
        alert.addButton(withTitle: L("Cancel"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // ---------- Self-tests ----------

    // TUNA_SELFTEST=<folder> (the separate self-test build only): runs <folder>/eval.js in the page
    // whenever it appears, and writes what it returns to <folder>/eval.json. For automated checks only.
    private var selfTestBusy = false

    private func startSelfTest() {
        guard let folder = ProcessInfo.processInfo.environment["TUNA_SELFTEST"],
              Bundle.main.bundleIdentifier?.hasSuffix(".selftest") == true else { return }
        let dir = URL(fileURLWithPath: folder)
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.selfTestStep(dir) }
        }
    }

    private func selfTestStep(_ dir: URL) {
        // <folder>/snapshot: a picture of the page in <folder>/snapshot.png.
        let trigger = dir.appendingPathComponent("snapshot")
        if FileManager.default.fileExists(atPath: trigger.path) {
            try? FileManager.default.removeItem(at: trigger)
            web.takeSnapshot(with: nil) { image, _ in
                guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: dir.appendingPathComponent("snapshot.png"), options: .atomic)
            }
        }
        let file = dir.appendingPathComponent("eval.js")
        guard !selfTestBusy, let code = try? String(contentsOf: file, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(at: file)
        selfTestBusy = true
        web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { [weak self] result in
            self?.selfTestBusy = false
            var out: [String: Any]
            switch result {
            case .success(let value): out = ["ok": true, "value": value]
            case .failure(let error): out = ["ok": false, "error": "\(error)"]
            }
            if !JSONSerialization.isValidJSONObject(out) { out["value"] = "\(out["value"] ?? "")" }
            let data = (try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted])) ?? Data()
            try? data.write(to: dir.appendingPathComponent("eval.json"), options: .atomic)
        }
    }
}

/// Never in the way of the page's clicks: only pressed for it.
private final class HiddenRoutePicker: AVRoutePickerView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
