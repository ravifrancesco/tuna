import Foundation
import UniformTypeIdentifiers

/// Downloads (docs/native-bridge.md, "Downloads"): albums, playlists, Liked songs and songs kept on
/// the device, so they play with no connection at all. The page says what to keep; this fetches it
/// one file at a time, oldest download first, in the background as far as the system allows, into
/// the app's own storage (not backed up): a manifest, the songs named by their id, the covers by
/// their download's. The player plays these files instead of the server's whenever it can.
/// The iPhone and Mac apps share this file (apps/mac/build.sh compiles it too).
final class OfflineStore: NSObject, URLSessionDownloadDelegate {
    static let shared = OfflineStore()

    /// A song as the page sent it (`NativeTrack`).
    struct Song: Codable {
        var id: String
        var url: String
        var title: String?
        var artist: String?
        var album: String?
        var artwork: String?
        var duration: Double?
        var liked: Bool?
    }

    /// A download as the page described it, and what the app keeps about it.
    struct Download: Codable {
        var id: String
        var kind: String
        var title: String
        var subtitle: String?
        var cover: String?
        var tracks: [Song]
        /// Its cover, in covers/.
        var coverFile: String?
        /// Stopped with songs missing: tried again when it's added again or the server's back.
        var failed: Bool?
    }

    /// A song on the device: its file in songs/, and its artwork's in art/.
    struct File: Codable {
        var name: String
        var bytes: Int64
        var art: String?
    }

    private struct Manifest: Codable {
        var downloads: [Download]
        var files: [String: File]
    }

    /// What's being fetched: a song or its artwork (by song id), or a download's cover (by its id).
    private struct Job {
        enum Kind: String { case song, art, cover }
        let kind: Kind
        let download: String
        let id: String
        var key: String { "\(kind.rawValue):\(id)" }
        var text: String { [kind.rawValue, download, id].joined(separator: "\n") }

        init(_ kind: Kind, _ download: String, _ id: String) {
            self.kind = kind
            self.download = download
            self.id = id
        }

        init?(_ text: String?) {
            let parts = text?.components(separatedBy: "\n") ?? []
            guard parts.count == 3, let kind = Kind(rawValue: parts[0]) else { return nil }
            self.init(kind, parts[1], parts[2])
        }
    }

    /// The list for the page whenever it changes (at most twice a second while a song comes in).
    var onChange: (([[String: Any]]) -> Void)?
    /// iOS hands this over when it wakes the app for finished background downloads.
    var backgroundCompletion: (() -> Void)?

    /// Newest first.
    private(set) var downloads: [Download] = []
    /// By song id: the songs on the device.
    private var files: [String: File] = [:]

    /// Fetching only once the server has answered (or the page asked for something).
    private var active = false
    /// Until what was being fetched when the app last stopped has been found again.
    private var adopting = true
    private var task: URLSessionTask?
    private var job: Job?
    private var received: Int64 = 0
    /// Transfers whose file arrived and was kept.
    private var kept = Set<ObjectIdentifier>()
    /// What failed since the server last answered: not tried again until then.
    private var tried = Set<String>()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "\(Bundle.main.bundleIdentifier ?? "app.tuna.music").downloads")
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        // The addresses carry the media key: no cookie needed.
        config.httpShouldSetCookies = false
        config.httpMaximumConnectionsPerHost = 1
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    #if os(macOS)
    /// Away from home: the tunnel's proxy port while it's on (the window keeps it up to date).
    /// What's coming starts again the new way.
    var tunnelPort: Int? {
        didSet { if tunnelPort != oldValue { task?.cancel() } }
    }
    private var proxied: (port: Int, session: URLSession)?
    #endif

    /// Through the tunnel while it's on (Mac), else in the background.
    private var transfers: URLSession {
        #if os(macOS)
        if let port = tunnelPort {
            if let proxied, proxied.port == port { return proxied.session }
            proxied?.session.finishTasksAndInvalidate()
            let config = URLSessionConfiguration.default
            config.httpShouldSetCookies = false
            config.connectionProxyDictionary = Tunnel.proxy(port)
            let through = URLSession(configuration: config, delegate: self, delegateQueue: .main)
            proxied = (port, through)
            return through
        }
        #endif
        return session
    }

    private let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.tuna.music", isDirectory: true)
        .appendingPathComponent("Downloads", isDirectory: true)
    private var manifest: URL { root.appendingPathComponent("downloads.json") }
    private func folder(_ name: String) -> URL { root.appendingPathComponent(name, isDirectory: true) }

    override private init() {
        super.init()
        if let data = try? Data(contentsOf: manifest), let saved = try? JSONDecoder().decode(Manifest.self, from: data) {
            downloads = saved.downloads
            files = saved.files.filter { FileManager.default.fileExists(atPath: folder("songs").appendingPathComponent($0.value.name).path) }
        }
        // Carry on with what was coming when the app last stopped (iOS may have fetched it meanwhile).
        session.getAllTasks { tasks in
            DispatchQueue.main.async {
                for t in tasks {
                    if self.task == nil, let job = Job(t.taskDescription), t.state == .running || t.state == .suspended {
                        self.task = t
                        self.job = job
                        t.resume()
                    } else {
                        t.cancel()
                    }
                }
                self.adopting = false
                self.changed()
            }
        }
    }

    // ---------- For the players and the offline page ----------

    var hasSongs: Bool { !files.isEmpty }

    /// The song's file, when it's on the device.
    func file(for id: String) -> URL? {
        guard let name = files[id]?.name else { return nil }
        let url = folder("songs").appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func artwork(for id: String) -> URL? {
        files[id]?.art.map { folder("art").appendingPathComponent($0) }
    }

    /// A download's cover (`localCover`), by its file's name.
    func cover(named name: String) -> URL? {
        downloads.contains { $0.coverFile == name } ? folder("covers").appendingPathComponent(name) : nil
    }

    /// What the page sees: `NativeDownload[]`, newest first.
    func list() -> [[String: Any]] {
        downloads.map { d in
            var ids: [String] = []
            for s in d.tracks where !ids.contains(s.id) { ids.append(s.id) }
            let ready = ids.filter { files[$0] != nil }
            var bytes = ready.reduce(Int64(0)) { $0 + (files[$1]?.bytes ?? 0) }
            if job?.kind == .song, job?.download == d.id { bytes += received }
            let state = ready.count == ids.count ? "done" : job?.download == d.id ? "downloading" : d.failed == true ? "failed" : "waiting"
            var item: [String: Any] = [
                "id": d.id, "kind": d.kind, "title": d.title, "ready": ready, "bytes": bytes, "state": state,
                "tracks": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(d.tracks))) ?? [],
            ]
            if let subtitle = d.subtitle { item["subtitle"] = subtitle }
            if let cover = d.cover { item["cover"] = cover }
            if let file = d.coverFile { item["localCover"] = "\(LocalScheme.scheme)://app/covers/\(file)" }
            return item
        }
    }

    // ---------- From the page ----------

    /// Keep it and fetch what's missing. An id that's there already gets the new songs; files no
    /// download needs any more go.
    func add(_ args: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(args), let data = try? JSONSerialization.data(withJSONObject: args),
              var d = try? JSONDecoder().decode(Download.self, from: data) else { throw Problem(L("Bad request")) }
        d.coverFile = nil
        d.failed = nil
        if let i = downloads.firstIndex(where: { $0.id == d.id }) {
            if Self.withoutKey(downloads[i].cover) == Self.withoutKey(d.cover) { d.coverFile = downloads[i].coverFile }
            downloads[i] = d
        } else {
            downloads.insert(d, at: 0)
        }
        tried.subtract(d.tracks.flatMap { ["song:\($0.id)", "art:\($0.id)"] } + ["cover:\(d.id)"])
        active = true
        changed()
    }

    func remove(_ id: String) {
        downloads.removeAll { $0.id == id }
        changed()
    }

    func clear() {
        downloads = []
        files = [:]
        try? FileManager.default.removeItem(at: root)
        changed()
    }

    /// The server answered: try again what failed, and carry on.
    func resume() {
        active = true
        tried.removeAll()
        for i in downloads.indices { downloads[i].failed = nil }
        changed()
    }

    // ---------- Fetching ----------

    /// After any change: files nobody needs go, the next one starts, the manifest is saved, the page
    /// hears (straight away when it asked for the change).
    private func changed(now: Bool = true) {
        tidy()
        next()
        save()
        broadcast(now: now)
    }

    private func tidy() {
        let songs = Set(downloads.flatMap { $0.tracks.map(\.id) })
        files = files.filter { songs.contains($0.key) }
        keepOnly("songs", Set(files.values.map(\.name)))
        keepOnly("art", Set(files.values.compactMap(\.art)))
        keepOnly("covers", Set(downloads.compactMap(\.coverFile)))
        // What's coming for nobody now stops.
        if let job, job.kind == .cover ? !downloads.contains(where: { $0.id == job.id }) : !songs.contains(job.id) { task?.cancel() }
    }

    private func keepOnly(_ name: String, _ wanted: Set<String>) {
        let dir = folder(name)
        for file in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where !wanted.contains(file) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(file))
        }
    }

    /// Starts the next file when nothing's coming: the oldest download first, its cover, then each
    /// song and its artwork. A download left with songs it couldn't get has failed.
    private func next() {
        guard active, !adopting, task == nil else { return }
        for i in downloads.indices.reversed() where downloads[i].failed != true {
            if let (job, url) = nextJob(downloads[i]) {
                var request = URLRequest(url: url)
                request.httpShouldHandleCookies = false
                let t = transfers.downloadTask(with: request)
                t.taskDescription = job.text
                task = t
                self.job = job
                received = 0
                t.resume()
                return
            }
            if downloads[i].tracks.contains(where: { files[$0.id] == nil }) { downloads[i].failed = true }
        }
    }

    private func nextJob(_ d: Download) -> (Job, URL)? {
        if d.coverFile == nil, !tried.contains("cover:\(d.id)"), let url = d.cover.flatMap(URL.init(string:)) {
            return (Job(.cover, d.id, d.id), url)
        }
        for s in d.tracks {
            guard let file = files[s.id] else {
                if !tried.contains("song:\(s.id)"), let url = URL(string: s.url) { return (Job(.song, d.id, s.id), url) }
                continue
            }
            guard file.art == nil, !tried.contains("art:\(s.id)"), let artwork = s.artwork, let url = URL(string: artwork) else { continue }
            // An album's songs share their artwork: it's fetched once.
            let name = Self.artName(artwork)
            if FileManager.default.fileExists(atPath: folder("art").appendingPathComponent(name).path) {
                files[s.id]?.art = name
            } else {
                return (Job(.art, d.id, s.id), url)
            }
        }
        return nil
    }

    private func save() {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = root
        try? folder.setResourceValues(values)
        try? JSONEncoder().encode(Manifest(downloads: downloads, files: files)).write(to: manifest, options: .atomic)
    }

    private var pending: DispatchWorkItem?
    /// At most one update every half second while files come in.
    private func broadcast(now: Bool = false) {
        if pending != nil && !now { return }
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pending = nil
            self.onChange?(self.list())
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (now ? 0 : 0.5), execute: work)
    }

    /// A name for a file from an id ("album:12" → "album_12").
    private static func safe(_ id: String) -> String {
        String(id.replacingOccurrences(of: #"[^A-Za-z0-9_-]"#, with: "_", options: .regularExpression).prefix(120))
    }

    /// The file's extension from what the server says it is (AVPlayer goes by it).
    static func ext(_ response: URLResponse?, _ fallback: String) -> String {
        guard let mime = response?.mimeType?.lowercased() else { return fallback }
        if let ext = UTType(mimeType: mime)?.preferredFilenameExtension { return ext }
        // "audio/x-flac" → flac
        let sub = String(mime.split(separator: "/").last ?? "").replacingOccurrences(of: "x-", with: "")
        let known = (mime.hasPrefix("audio/") || mime.hasPrefix("image/")) && sub.range(of: "^[a-z0-9]+$", options: .regularExpression) != nil
        return known ? sub : fallback
    }

    /// An address without its media key, which changes when you sign in again.
    static func withoutKey(_ address: String?) -> String? {
        guard let address, var parts = URLComponents(string: address) else { return address }
        parts.queryItems = parts.queryItems?.filter { $0.name != "k" }
        return parts.string
    }

    /// Artwork's file name, the same for every song with the same artwork.
    private static func artName(_ address: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in (withoutKey(address) ?? address).utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(hash, radix: 16)
    }

    // ---------- URLSession (on the main queue) ----------

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard downloadTask === task, job?.kind == .song else { return }
        received = totalBytesWritten
        broadcast()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let job = Job(downloadTask.taskDescription), let url = downloadTask.originalRequest?.url,
              let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else { return }
        // The temporary file goes when this returns: moved now.
        func keep(_ name: String, in dir: String) -> Int64? {
            let manager = FileManager.default
            let to = folder(dir).appendingPathComponent(name)
            try? manager.createDirectory(at: folder(dir), withIntermediateDirectories: true)
            try? manager.removeItem(at: to)
            guard (try? manager.moveItem(at: location, to: to)) != nil else { return nil }
            return (try? manager.attributesOfItem(atPath: to.path)[.size] as? NSNumber)?.int64Value ?? 0
        }
        switch job.kind {
        case .song:
            guard downloads.contains(where: { $0.tracks.contains { $0.id == job.id } }) else { return }
            let name = Self.safe(job.id) + "." + Self.ext(downloadTask.response, "mp3")
            guard let bytes = keep(name, in: "songs") else { return }
            files[job.id] = File(name: name, bytes: bytes, art: files[job.id]?.art)
        case .art:
            let name = Self.artName(url.absoluteString)
            guard files[job.id] != nil, keep(name, in: "art") != nil else { return }
            files[job.id]?.art = name
        case .cover:
            guard let i = downloads.firstIndex(where: { $0.id == job.id }) else { return }
            let name = Self.safe(job.id) + "." + Self.ext(downloadTask.response, "jpg")
            guard keep(name, in: "covers") != nil else { return }
            downloads[i].coverFile = name
        }
        kept.insert(ObjectIdentifier(downloadTask))
        // It came, so the server's there: carry on (also when iOS woke the app just for this).
        active = true
    }

    func urlSession(_ session: URLSession, task done: URLSessionTask, didCompleteWithError error: Error?) {
        // Stopped on purpose (removed, or the tunnel came or went) isn't a failure: still wanted, it starts again.
        if kept.remove(ObjectIdentifier(done)) == nil, (error as NSError?)?.code != NSURLErrorCancelled, let job = Job(done.taskDescription) {
            tried.insert(job.key)
        }
        if done === task {
            task = nil
            job = nil
            received = 0
        }
        changed(now: false)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }
}
