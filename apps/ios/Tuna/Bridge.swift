import Foundation
import UIKit
@preconcurrency import WebKit

/// What the app tells the page before its scripts run, and how the page talks to the app
/// (docs/native-bridge.md): `window.tunaHello`, `webkit.messageHandlers.tuna`, `window.__tuna`.
enum Bridge {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

    static var hello: [String: Any] {
        [
            "platform": "ios",
            "version": version,
            // What AVPlayer plays as it is; the server converts anything else.
            "formats": ["mp3", "aac", "m4a", "alac", "flac", "wav"],
            // Haptics: iPhones only (iPads don't vibrate).
            "features": ["audio", "changeServer", "downloads", "mobileData", "outputs", "sleep"]
                + (UIDevice.current.userInterfaceIdiom == .phone ? ["haptics"] : []),
        ]
    }

    /// The app's own pages (the offline page): only the player and the downloads.
    static var script: String {
        var offline = hello
        offline["features"] = ["audio", "downloads"]
        return "window.tunaHello = location.protocol === '\(LocalScheme.scheme):' ? \(json(offline)) : \(json(hello));"
    }

    /// `value` as JavaScript source (JSON, and "null" for nothing).
    static func json(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}

/// Takes the page's messages. Only the Tuna server's pages and the app's own pages may use it,
/// and only the setup page may change the server.
final class BridgeHandler: NSObject, WKScriptMessageHandler {
    weak var controller: WebViewController?

    init(controller: WebViewController) {
        self.controller = controller
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let controller, let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = (body["id"] as? NSNumber)?.intValue
        let origin = message.frameInfo.securityOrigin
        let local = origin.protocol == LocalScheme.scheme
        let fromServer = Server.url.map { origin.protocol == $0.scheme && origin.host == $0.host && origin.port == ($0.port ?? 0) } ?? false
        guard message.frameInfo.isMainFrame, local || fromServer else { return }
        let args = body["args"] as? [String: Any] ?? [:]

        Task { @MainActor in
            do {
                let value = try await self.handle(controller, cmd, args, local: local)
                if let id { controller.send(["type": "reply", "id": id, "value": value ?? NSNull()]) }
            } catch {
                // `error` is for the app's own setup page; the interface only reads `value`.
                if let id { controller.send(["type": "reply", "id": id, "value": NSNull(), "error": error.localizedDescription]) }
            }
        }
    }

    @MainActor
    private func handle(_ controller: WebViewController, _ cmd: String, _ args: [String: Any], local: Bool) async throws -> Any? {
        let player = controller.player
        switch cmd {
        case "audio.load":
            player.load(tracks: args["tracks"] as? [[String: Any]] ?? [], index: (args["index"] as? NSNumber)?.intValue ?? 0,
                        start: (args["start"] as? NSNumber)?.doubleValue ?? 0, play: args["play"] as? Bool ?? true)
        case "audio.update":
            player.update(tracks: args["tracks"] as? [[String: Any]] ?? [], index: (args["index"] as? NSNumber)?.intValue ?? 0)
        case "audio.command":
            player.command(args["name"] as? String ?? "", args["value"])
        case "audio.current":
            return player.current
        case "audio.liked":
            player.liked(args["id"] as? String ?? "", args["liked"] as? Bool ?? false)
        case "audio.outputs":
            let n = { (key: String) in CGFloat((args[key] as? NSNumber)?.doubleValue ?? 0) }
            controller.showOutputs(at: CGRect(x: n("x"), y: n("y"), width: n("width"), height: n("height")))
        case "audio.sleep":
            player.sleep(minutes: (args["minutes"] as? NSNumber)?.doubleValue, endOfSong: args["endOfSong"] as? Bool ?? false)
        case "app.haptic":
            if args["style"] as? String == "success" {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        case "mobileData":
            return controller.cellular
        case "downloads.add":
            try OfflineStore.shared.add(args)
        case "downloads.remove":
            OfflineStore.shared.remove(args["id"] as? String ?? "")
        case "downloads.clear":
            OfflineStore.shared.clear()
        case "downloads.list":
            return OfflineStore.shared.list()
        case "downloads.offline":
            controller.showOffline()
        // The offline page: is the server back, and back to it.
        case "server.reachable":
            guard let server = Server.url else { return false }
            return await Server.reachable(server)
        case "server.open":
            controller.showServer()
        case "changeServer":
            // The music came from this server: it stops.
            player.stop()
            controller.showSetup(error: nil)
        // The app's own setup page only.
        case "currentServer":
            guard local else { throw Problem(L("Not allowed here")) }
            return Server.url?.absoluteString
        case "connect":
            guard local else { throw Problem(L("Not allowed here")) }
            let url = try Server.normalize(args["address"] as? String ?? "")
            try await Server.probe(url)
            Server.url = url
            controller.showServer()
            return url.absoluteString
        default:
            throw Problem(L("Unknown request"))
        }
        return nil
    }
}
