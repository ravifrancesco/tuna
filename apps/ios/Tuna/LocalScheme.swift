import Foundation
@preconcurrency import WebKit

/// The app's private tuna-app:// address: the setup, loading and offline pages bundled with the
/// app, and the downloads' covers (covers/…). Tuna itself always opens from the server's own address.
final class LocalScheme: NSObject, WKURLSchemeHandler {
    static let scheme = "tuna-app"
    static func url(_ page: String, query: [String: String] = [:]) -> URL {
        var parts = URLComponents(string: "\(scheme)://app/\(page)")!
        if !query.isEmpty { parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return parts.url!
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else { return fail(task) }
        let name = url.lastPathComponent
        let file = url.pathComponents.dropLast().last == "covers"
            ? OfflineStore.shared.cover(named: name)
            : name.range(of: #"^[\w.-]+\.html$"#, options: .regularExpression) != nil ? Bundle.main.url(forResource: name, withExtension: nil) : nil
        guard let file, let data = try? Data(contentsOf: file) else { return fail(task) }
        let type = file.pathExtension == "html" ? "text/html; charset=utf-8" : "image/\(file.pathExtension)"
        let headers = ["Content-Type": type, "Content-Length": String(data.count)]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask) {
        let response = HTTPURLResponse(url: task.request.url ?? URL(string: "\(Self.scheme)://app/")!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
        task.didReceive(response)
        task.didReceive(Data(L("Not found").utf8))
        task.didFinish()
    }
}
