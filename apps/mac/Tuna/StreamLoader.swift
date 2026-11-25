import AVFoundation
import UniformTypeIdentifiers

/// Songs through the tunnel (away from home). AVPlayer can't be pointed at a proxy itself, so it
/// asks this for the bytes of tuna-http(s)://… addresses, and this fetches them from the real
/// address through the tunnel's proxy, a range at a time, as AVPlayer asks for them.
final class StreamLoader: NSObject, AVAssetResourceLoaderDelegate, URLSessionDataDelegate {
    let queue = DispatchQueue(label: "app.tuna.music.stream")
    let proxyPort: Int?
    private var session: URLSession!

    /// One of AVPlayer's requests and the download answering it (used on `queue` only).
    private final class Request {
        let loading: AVAssetResourceLoadingRequest
        let task: URLSessionDataTask
        /// Bytes to throw away first (a server that sent the whole file instead of the range).
        var skip: Int64
        /// Bytes still wanted, when AVPlayer asked for a set amount.
        var remaining: Int64?

        init(_ loading: AVAssetResourceLoadingRequest, _ task: URLSessionDataTask, skip: Int64, remaining: Int64?) {
            self.loading = loading
            self.task = task
            self.skip = skip
            self.remaining = remaining
        }
    }

    private var requests: [Int: Request] = [:]

    init(proxyPort: Int?) {
        self.proxyPort = proxyPort
        super.init()
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        if let proxyPort { config.connectionProxyDictionary = Tunnel.proxy(proxyPort) }
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }

    /// Done with: stops whatever's still downloading (the session lets go of this, too).
    func invalidate() {
        session.invalidateAndCancel()
    }

    static func wrap(_ url: URL) -> URL {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.scheme = "tuna-" + (parts.scheme ?? "http")
        return parts.url ?? url
    }

    private static func unwrap(_ url: URL) -> URL? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = parts.scheme, scheme.hasPrefix("tuna-") else { return nil }
        parts.scheme = String(scheme.dropFirst(5))
        return parts.url
    }

    // ---------- AVPlayer asks ----------

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loading: AVAssetResourceLoadingRequest) -> Bool {
        guard let wrapped = loading.request.url, let url = Self.unwrap(wrapped) else { return false }
        var request = URLRequest(url: url)
        var offset: Int64 = 0
        var remaining: Int64?
        if let data = loading.dataRequest {
            offset = data.requestedOffset
            if data.requestsAllDataToEndOfResource {
                request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range")
            } else {
                remaining = Int64(data.requestedLength)
                request.setValue("bytes=\(offset)-\(offset + Int64(data.requestedLength) - 1)", forHTTPHeaderField: "Range")
            }
        }
        let task = session.dataTask(with: request)
        requests[task.taskIdentifier] = Request(loading, task, skip: offset, remaining: remaining)
        task.resume()
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loading: AVAssetResourceLoadingRequest) {
        for (id, r) in requests where r.loading === loading {
            requests[id] = nil
            r.task.cancel()
        }
    }

    // ---------- The server answers ----------

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let r = requests[dataTask.taskIdentifier] else { return completionHandler(.cancel) }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 206 else {
            requests[dataTask.taskIdentifier] = nil
            r.loading.finishLoading(with: URLError(.badServerResponse))
            return completionHandler(.cancel)
        }
        if http.statusCode == 206 { r.skip = 0 }
        if let info = r.loading.contentInformationRequest {
            let total = http.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.flatMap { Int64($0) }
            info.contentLength = total ?? max(0, http.expectedContentLength)
            info.contentType = UTType(mimeType: http.mimeType ?? "")?.identifier ?? UTType.audio.identifier
            info.isByteRangeAccessSupported = http.statusCode == 206 || (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "").contains("bytes")
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let r = requests[dataTask.taskIdentifier] else { return }
        var chunk = data
        if r.skip > 0 {
            let drop = min(Int64(chunk.count), r.skip)
            chunk = chunk.subdata(in: chunk.startIndex + Int(drop)..<chunk.endIndex)
            r.skip -= drop
        }
        if let remaining = r.remaining, Int64(chunk.count) > remaining {
            chunk = chunk.prefix(Int(remaining))
        }
        if !chunk.isEmpty { r.loading.dataRequest?.respond(with: chunk) }
        if let remaining = r.remaining {
            r.remaining = remaining - Int64(chunk.count)
            if r.remaining! <= 0 {
                // All that was asked for (a server that sent more): done with this one.
                requests[dataTask.taskIdentifier] = nil
                r.loading.finishLoading()
                dataTask.cancel()
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let r = requests.removeValue(forKey: task.taskIdentifier) else { return }
        if let error { r.loading.finishLoading(with: error) } else { r.loading.finishLoading() }
    }
}
