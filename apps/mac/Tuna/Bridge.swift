import AppKit
@preconcurrency import WebKit

/// The page and the app (docs/native-bridge.md): `window.tunaHello` before the page's scripts run,
/// the page's messages on the "tuna" handler, and answers, the player's state and events back
/// through `window.__tuna(…)`. The bundled pages use it too: the address page (connect,
/// currentServer) and the offline page (the player, the downloads, the server).
final class Bridge: NSObject, WKScriptMessageHandler {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

    static let script: String = {
        var hello: [String: Any] = [
            "platform": "mac",
            "version": version,
            // What AVPlayer plays as-is; the server converts the rest.
            "formats": ["mp3", "aac", "m4a", "alac", "flac", "wav"],
            "features": ["audio", "changeServer", "downloads", "tunnel", "update"],
        ]
        let json = { (value: Any) in (try? JSONSerialization.data(withJSONObject: value)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}" }
        let server = json(hello)
        // The app's own pages (the offline page): only the player and the downloads.
        hello["features"] = ["audio", "downloads"]
        return "window.tunaHello = location.protocol === '\(LocalScheme.scheme):' ? \(json(hello)) : \(server);"
    }()

    /// What the bundled pages may ask: the address page, and the offline page.
    private static let localCommands: Set = ["connect", "currentServer", "audio.load", "audio.update", "audio.command", "audio.current", "downloads.list", "server.reachable", "server.open"]

    private static let selfTest = Bundle.main.bundleIdentifier?.hasSuffix(".selftest") == true

    private weak var window: MainWindow?
    /// The newer release the last check found.
    private var release: Updater.Release?

    init(window: MainWindow) {
        self.window = window
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = (body["id"] as? NSNumber)?.intValue
        let args = body["args"] as? [String: Any] ?? [:]
        let origin = message.frameInfo.securityOrigin
        let local = origin.protocol == LocalScheme.scheme
        let fromServer = Server.url.map { origin.protocol == $0.scheme && origin.host == $0.host && origin.port == ($0.port ?? 0) } ?? false
        if !cmd.hasPrefix("debug.") { debugLog("page: \(cmd) \(Self.summary(cmd, args))") }

        Task { @MainActor in
            do {
                guard message.frameInfo.isMainFrame, local || fromServer else { throw Problem(L("Not allowed here")) }
                let value = try await self.handle(cmd, args, local: local)
                if let id { self.window?.send(["type": "reply", "id": id, "value": value ?? NSNull()]) }
            } catch {
                if let id {
                    // (The page reads `value`; `error` says why it's empty.)
                    self.window?.send(["type": "reply", "id": id, "value": NSNull(), "error": error.localizedDescription])
                } else if cmd == "update.install", let window = self.window?.window {
                    let alert = NSAlert()
                    alert.messageText = L("Couldn't update Tuna")
                    alert.informativeText = error.localizedDescription
                    alert.beginSheetModal(for: window) { _ in }
                }
            }
        }
    }

    @MainActor
    private func handle(_ cmd: String, _ args: [String: Any], local: Bool) async throws -> Any? {
        guard let window else { return nil }
        let audio = window.audio
        // The bundled pages may only do their own few things; the server's pages anything but connect.
        if local ? !Self.localCommands.contains(cmd) : ["connect", "currentServer"].contains(cmd) { throw Problem(L("Not allowed here")) }
        switch cmd {
        // The player
        case "audio.load":
            audio.load(args["tracks"] as? [[String: Any]] ?? [], index: Self.int(args["index"]), start: Self.double(args["start"]), play: args["play"] as? Bool ?? true)
        case "audio.update":
            audio.update(args["tracks"] as? [[String: Any]] ?? [], index: Self.int(args["index"]))
        case "audio.command":
            let value = args["value"]
            switch args["name"] as? String {
            case "play": audio.play()
            case "pause": audio.pause()
            case "toggle": audio.toggle()
            case "next": audio.skipNext()
            case "previous": audio.previous()
            case "seek": audio.seek(Self.double(value))
            case "jump": audio.jump(Self.int(value))
            case "stop": audio.stop()
            case "repeat": audio.setRepeat(value as? String ?? "off")
            case "volume": audio.setVolume(Self.double(value))
            default: throw Problem(L("Unknown request"))
            }
        case "audio.current":
            return audio.currentQueue ?? NSNull()

        // Downloads
        case "downloads.add":
            try OfflineStore.shared.add(args)
        case "downloads.remove":
            OfflineStore.shared.remove(args["id"] as? String ?? "")
        case "downloads.clear":
            OfflineStore.shared.clear()
        case "downloads.list":
            return OfflineStore.shared.list()
        case "downloads.offline":
            window.showOffline()

        // The server
        case "server.reachable":
            // Through the tunnel away from home.
            guard let server = Server.url else { return false }
            return await Tunnel.shared.route(server) != .none
        case "server.open":
            window.openServer()
        case "changeServer":
            window.showSetup(error: nil)
        case "currentServer":
            return Server.url?.absoluteString ?? NSNull()
        case "connect":
            let url = try Server.normalize(args["address"] as? String ?? "")
            do {
                try await Server.probe(url)
            } catch {
                // Away from home, the saved server may still answer through the tunnel.
                guard url == Server.url, Tunnel.shared.configured, await Tunnel.shared.route(url) == .away else { throw error }
            }
            // Another server: what was playing came from the old one.
            if let old = Server.url, old != url { audio.stop() }
            Server.url = url
            window.openServer()

        // Away from home (never the configuration itself back)
        case "tunnel.status":
            return Tunnel.shared.status
        case "tunnel.save":
            return await Tunnel.shared.save(args["config"] as? String ?? "") ?? ""
        case "tunnel.remove":
            Tunnel.shared.remove()

        // Updates from GitHub Releases
        case "update.check":
            release = try await Updater.check()
            return [
                "current": Bridge.version,
                "latest": release?.version ?? Bridge.version,
                "available": release != nil,
                "canInstall": release?.download != nil,
                "page": release?.page?.absoluteString ?? "https://github.com/\(Updater.repository)/releases",
            ] as [String: Any]
        case "update.install":
            if release == nil { release = try await Updater.check() }
            guard let found = release else { throw Problem(L("Tuna is up to date")) }
            try await Updater.install(found) { [weak window] received, total in
                Task { @MainActor in window?.send(["type": "event", "name": "update", "value": ["received": received, "total": total]]) }
            }

        // Self-tests only: what the player is really doing, and the media keys.
        case "debug.player" where Self.selfTest:
            return audio.debug
        case "debug.remote" where Self.selfTest:
            audio.remote(args["name"] as? String ?? "", Self.double(args["value"]))
        case "debug.close" where Self.selfTest:
            window.close()
        case "debug.quit" where Self.selfTest:
            DispatchQueue.main.async { NSApp.terminate(nil) }

        default:
            throw Problem(L("Unknown request"))
        }
        return nil
    }

    private static func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private static func double(_ value: Any?) -> Double {
        let d = (value as? NSNumber)?.doubleValue ?? 0
        return d.isFinite ? d : 0
    }

    /// For the self-test log: what was asked, without the songs' addresses (they carry a key).
    private static func summary(_ cmd: String, _ args: [String: Any]) -> String {
        switch cmd {
        case "audio.load", "audio.update":
            let tracks = args["tracks"] as? [[String: Any]] ?? []
            let titles = tracks.prefix(3).map { $0["title"] as? String ?? "?" }.joined(separator: ", ")
            return "\(tracks.count) songs (\(titles)…) index \(args["index"] ?? "-") start \(args["start"] ?? "-") play \(args["play"] ?? "-")"
        case "audio.command": return "\(args["name"] ?? "?") \(args["value"].map { "\($0)" } ?? "")"
        case "downloads.add": return "\(args["id"] ?? "?"): \((args["tracks"] as? [Any])?.count ?? 0) songs"
        case "tunnel.save", "connect": return ""
        default: return args.isEmpty ? "" : "\(args)"
        }
    }
}
