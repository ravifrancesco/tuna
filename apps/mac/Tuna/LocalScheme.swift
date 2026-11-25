import Foundation
@preconcurrency import WebKit

/// The app's private tuna-app:// address: the setup, loading and offline pages bundled with the
/// app, and the downloads' covers (covers/…).
final class LocalScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "tuna-app"
    static func url(_ page: String, query: [String: String] = [:]) -> URL {
        var parts = URLComponents(string: "\(scheme)://app/\(page)")!
        if !query.isEmpty { parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return parts.url!
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let cover = task.request.url?.pathComponents.dropLast().last == "covers"
        guard let url = task.request.url, url.host == "app",
              let name = url.pathComponents.last, cover || name.range(of: #"^[\w.-]+\.(html|svg|png)$"#, options: .regularExpression) != nil,
              let file = cover ? OfflineStore.shared.cover(named: name) : Bundle.main.url(forResource: name, withExtension: nil),
              let data = try? Data(contentsOf: file) else {
            let response = HTTPURLResponse(url: task.request.url ?? URL(string: "\(Self.scheme)://app/")!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            task.didReceive(response)
            task.didReceive(Data(L("Not found").utf8))
            task.didFinish()
            return
        }
        let type: String
        switch file.pathExtension {
        case "html": type = "text/html; charset=utf-8"
        case "svg": type = "image/svg+xml"
        default: type = "image/\(file.pathExtension)"
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type, "Content-Length": String(data.count)])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
