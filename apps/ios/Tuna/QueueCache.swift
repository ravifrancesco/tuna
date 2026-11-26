import Foundation
import Network

/// The queue kept ahead (docs/native-bridge.md, "The player"): the next few songs fetched whole
/// into the app's cache, one at a time, so the music carries on through a dropped connection, a
/// switch between home and the tunnel, or a server restart. The player plays these files once
/// they're here. At most about 500 MB, oldest first; downloaded songs are never fetched again.
/// The iPhone and Mac apps share this file (apps/mac/build.sh compiles it too).
final class QueueCache: NSObject, URLSessionDownloadDelegate {
    /// A song came in: the player plays it from the file if it's coming up.
    var onReady: (() -> Void)?

    /// How many songs to keep ahead: one on mobile data (or a phone's hotspot).
    var ahead: Int { expensive ? 1 : 3 }

    #if os(macOS)
    /// Away from home: through the tunnel's proxy while it's on. What's coming starts again the new way.
    var proxyPort: Int? {
        didSet {
            guard proxyPort != oldValue else { return }
            let old = session
            session = makeSession()
            old?.invalidateAndCancel()
        }
    }
    #endif

    private static let limit: Int64 = 500 * 1024 * 1024
    private let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.tuna.music", isDirectory: true)
        .appendingPathComponent("Queue", isDirectory: true)
    /// By song (its address without the media key): its file's name.
    private var files: [String: String] = [:]
    /// What to fetch, in order, and what's never thrown away (those and the song playing).
    private var wanted: [(key: String, url: URL)] = []
    private var keeping = Set<String>()
    /// What failed since the queue last moved: not tried again until then.
    private var failed = Set<String>()
    private var task: URLSessionTask?
    private var session: URLSession!
    private var expensive = false
    private let network = NWPathMonitor()

    override init() {
        super.init()
        session = makeSession()
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] {
            files[(name as NSString).deletingPathExtension] = name
        }
        network.pathUpdateHandler = { [weak self] path in
            let expensive = path.isExpensive
            DispatchQueue.main.async { self?.expensive = expensive }
        }
        network.start(queue: .global(qos: .utility))
    }

    /// The song's file, when it's here.
    func file(for url: URL) -> URL? {
        guard let name = files[Self.key(url)] else { return nil }
        let file = folder.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// The songs coming up, in order, and the one playing: fetches what's missing, one at a time.
    func keep(_ upcoming: [(id: String, url: URL)], playing: URL?) {
        let songs = upcoming.filter { $0.url.scheme == "http" || $0.url.scheme == "https" }
        keeping = Set(songs.map { Self.key($0.url) } + [playing].compactMap { $0.map(Self.key) })
        wanted = songs.filter { OfflineStore.shared.file(for: $0.id) == nil }.map { (Self.key($0.url), $0.url) }
        failed.removeAll()
        // What's coming for a song no longer coming up stops.
        if let task, !wanted.contains(where: { $0.key == task.taskDescription }) { task.cancel() }
        next()
    }

    private func next() {
        guard task == nil, let song = wanted.first(where: { file(for: $0.url) == nil && !failed.contains($0.key) }),
              var parts = URLComponents(url: song.url, resolvingAgainstBaseURL: false) else { return }
        // Fetching it isn't playing it: the server doesn't count it.
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "dl", value: "1")]
        guard let url = parts.url else { return }
        let t = session.downloadTask(with: url)
        t.taskDescription = song.key
        task = t
        t.resume()
    }

    /// At most about 500 MB: the oldest files go first, never the ones playing or coming up.
    private func trim() {
        let manager = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let all = ((try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []).map { url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            return (url: url, bytes: Int64(values?.fileSize ?? 0), date: values?.contentModificationDate ?? .distantPast)
        }
        var total = all.reduce(0) { $0 + $1.bytes }
        for f in all.sorted(by: { $0.date < $1.date }) where total > Self.limit {
            let key = f.url.deletingPathExtension().lastPathComponent
            guard !keeping.contains(key) else { continue }
            try? manager.removeItem(at: f.url)
            files[key] = nil
            total -= f.bytes
        }
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        // The addresses carry the media key: no cookie needed, and nothing kept twice.
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        #if os(macOS)
        if let proxyPort { config.connectionProxyDictionary = Tunnel.proxy(proxyPort) }
        #endif
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    /// A song's name in the cache: the same for the same song at the same quality, whatever the media key.
    private static func key(_ url: URL) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in (OfflineStore.withoutKey(url.absoluteString) ?? url.absoluteString).utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(hash, radix: 16)
    }

    // ---------- URLSession (on the main queue) ----------

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let key = downloadTask.taskDescription, (downloadTask.response as? HTTPURLResponse)?.statusCode == 200 else { return }
        // The temporary file goes when this returns: moved now.
        let manager = FileManager.default
        let name = key + "." + OfflineStore.ext(downloadTask.response, "mp3")
        let to = folder.appendingPathComponent(name)
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        try? manager.removeItem(at: to)
        guard (try? manager.moveItem(at: location, to: to)) != nil else { return }
        files[key] = name
        trim()
        onReady?()
    }

    func urlSession(_ session: URLSession, task done: URLSessionTask, didCompleteWithError error: Error?) {
        guard done === task else { return }
        // Stopped on purpose (no longer coming up, or the tunnel came or went) isn't a failure.
        if let key = done.taskDescription, files[key] == nil, (error as NSError?)?.code != NSURLErrorCancelled { failed.insert(key) }
        task = nil
        next()
    }
}
