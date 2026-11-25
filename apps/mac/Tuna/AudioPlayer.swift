import AppKit
@preconcurrency import AVFoundation
@preconcurrency import MediaPlayer

/// One song of the queue, as the page sent it (a NativeTrack).
struct Track {
    let id: String
    let url: URL?
    let title: String
    let artist: String
    let album: String
    let artwork: URL?
    let duration: Double
    /// Exactly what the page sent, to give back (audio.current).
    let raw: [String: Any]

    init(_ raw: [String: Any]) {
        self.raw = raw
        id = (raw["id"] as? String) ?? (raw["id"] as? NSNumber)?.stringValue ?? ""
        url = (raw["url"] as? String).flatMap(URL.init(string:)).flatMap { $0.scheme == "http" || $0.scheme == "https" ? $0 : nil }
        title = raw["title"] as? String ?? ""
        artist = raw["artist"] as? String ?? ""
        album = raw["album"] as? String ?? ""
        artwork = (raw["artwork"] as? String).flatMap(URL.init(string:))
        let d = (raw["duration"] as? NSNumber)?.doubleValue ?? 0
        duration = d.isFinite && d > 0 ? d : 0
    }
}

/// The app's own player, which owns the queue (docs/native-bridge.md): AVQueuePlayer with the
/// song playing and the next one loaded ahead, so songs follow each other without a gap.
/// Media keys, Control Centre and the menu bar's Now Playing drive it too. It says what's
/// happening on every change, and about once a second while playing.
final class AudioPlayer: NSObject {
    /// The state for the page (a NativeAudioState).
    var onState: (([String: Any]) -> Void)?

    /// The tunnel's proxy while it's on: songs and covers go through it.
    var proxyPort: Int? {
        didSet {
            guard proxyPort != oldValue else { return }
            artSession = Self.session(proxyPort)
            // The song carries on from where it was, the new way.
            if current != nil, tracks.indices.contains(index) { begin(index, at: time, play: wantsPlay) }
        }
    }

    private let player = AVQueuePlayer()
    private(set) var tracks: [Track] = []
    private(set) var index = -1
    private var repeatMode = "off"
    /// Playing, or about to (while it loads).
    private(set) var wantsPlay = false
    private var ended = false
    private var error: String?
    /// Songs in a row that couldn't be played: past the whole queue, it stops trying.
    private var failures = 0

    /// The song playing (or about to) and the one after it, loaded ahead.
    private var current: AVPlayerItem?
    private var next: AVPlayerItem?
    private var nextTrack: Track?
    private var nextIndex = -1
    /// Where to start once the song's ready, and where a seek is going.
    private var pendingStart: Double?
    private var seekingTo: Double?
    private var seeks = 0
    /// Changes whenever another song starts, so late callbacks about the last one are ignored.
    private var generation = 0

    private var observations: [NSKeyValueObservation] = []
    private var itemObservations: [ObjectIdentifier: NSKeyValueObservation] = [:]
    private var loaders: [ObjectIdentifier: StreamLoader] = [:]
    private var loader: StreamLoader?
    private var timeObserver: Any?
    private var lastSent: NSDictionary?

    /// Shown in Now Playing only once something has played: opening Tuna doesn't take the media keys.
    private var nowPlayingShown = false
    private var artwork: (url: URL, image: NSImage)?
    private var artworkTask: URLSessionDataTask?
    private var artSession = AudioPlayer.session(nil)

    private static let selfTest = Bundle.main.bundleIdentifier?.hasSuffix(".selftest") == true
    /// Self-test only: streams through StreamLoader even at home, to check it.
    private static let forceLoader = selfTest && ProcessInfo.processInfo.environment["TUNA_FORCE_LOADER"] == "1"

    override init() {
        super.init()
        player.actionAtItemEnd = .advance
        observations.append(player.observe(\.currentItem) { [weak self] _, _ in
            DispatchQueue.main.async { self?.currentItemChanged() }
        })
        observations.append(player.observe(\.timeControlStatus) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.report()
                self?.nowPlaying()
            }
        })
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 1), queue: .main) { [weak self] _ in
            guard let self, self.wantsPlay else { return }
            self.report(force: true)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(itemEnded(_:)), name: AVPlayerItem.didPlayToEndTimeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(itemFailed(_:)), name: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil)
        remoteCommands()
    }

    // ---------- What the page asks ----------

    func load(_ list: [[String: Any]], index i: Int, start: Double, play: Bool) {
        tracks = list.map(Track.init)
        failures = 0
        guard !tracks.isEmpty else { return stop() }
        begin(min(max(0, i), tracks.count - 1), at: start, play: play)
    }

    /// A new queue around the song that's playing: it carries on; only what comes after changes.
    func update(_ list: [[String: Any]], index i: Int) {
        tracks = list.map(Track.init)
        index = tracks.indices.contains(i) ? i : (tracks.isEmpty ? -1 : 0)
        prepareNext()
        report()
        nowPlaying()
    }

    func play() {
        guard tracks.indices.contains(index) else { return }
        // After the end of the queue, or a song that failed: this song again, from the start.
        if current == nil || current?.status == .failed { return begin(index, at: 0, play: true) }
        wantsPlay = true
        ended = false
        if pendingStart == nil { player.play() }
        report()
        nowPlaying()
    }

    func pause() {
        wantsPlay = false
        player.pause()
        report()
        nowPlaying()
    }

    func toggle() { wantsPlay ? pause() : play() }

    func skipNext() {
        let n = skipIndex()
        guard n >= 0 else { return }
        // Already loaded ahead: straight on to it.
        if let next, n == nextIndex, next.status != .failed {
            wantsPlay = true
            player.advanceToNextItem()
            currentItemChanged()
            player.play()
            return
        }
        begin(n, at: 0, play: true)
    }

    /// The song from the start when more than 3 s in (or it's the first), else the one before.
    func previous() {
        guard tracks.indices.contains(index) else { return }
        if time > 3 || index == 0 {
            if current == nil { return begin(index, at: 0, play: true) }
            seek(0)
        } else {
            begin(index - 1, at: 0, play: true)
        }
    }

    func jump(_ i: Int) {
        guard tracks.indices.contains(i) else { return }
        begin(i, at: 0, play: true)
    }

    func seek(_ seconds: Double) {
        guard let item = current, seconds.isFinite else { return }
        var target = max(0, seconds)
        let d = duration
        if d > 0 { target = min(target, max(0, d - 0.25)) }
        if item.status != .readyToPlay || pendingStart != nil {
            pendingStart = target
        } else {
            seeks += 1
            let mine = seeks, gen = generation
            seekingTo = target
            player.seek(to: CMTime(seconds: target, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, gen == self.generation, mine == self.seeks else { return }
                    self.seekingTo = nil
                    self.report()
                    self.nowPlaying()
                }
            }
        }
        report()
        nowPlaying()
    }

    func setRepeat(_ mode: String) {
        repeatMode = ["off", "all", "one"].contains(mode) ? mode : "off"
        prepareNext()
        report()
    }

    func setVolume(_ volume: Double) {
        guard volume.isFinite else { return }
        player.volume = Float(min(1, max(0, volume)))
    }

    /// Signing out or another server: the music stops and the queue empties.
    func stop() {
        generation += 1
        wantsPlay = false
        ended = false
        error = nil
        player.pause()
        clearItems()
        tracks = []
        index = -1
        pendingStart = nil
        seekingTo = nil
        report()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        nowPlayingShown = false
    }

    /// What's playing, for a page that has just loaded: nil when nothing is.
    var currentQueue: [String: Any]? {
        guard tracks.indices.contains(index) else { return nil }
        return ["tracks": tracks.map(\.raw), "index": index, "state": state]
    }

    // ---------- The queue ----------

    /// Starts song `i` (a new item; the one after it is loaded ahead).
    private func begin(_ i: Int, at seconds: Double, play: Bool) {
        guard tracks.indices.contains(i) else { return }
        generation += 1
        index = i
        ended = false
        error = nil
        seekingTo = nil
        wantsPlay = play
        player.pause()
        clearItems()
        let item = makeItem(tracks[i])
        current = item
        pendingStart = seconds.isFinite && seconds > 0.5 ? seconds : nil
        player.insert(item, after: nil)
        prepareNext()
        if play && pendingStart == nil { player.play() }
        report()
        nowPlaying()
    }

    /// The next song began by itself (the last one ended), or skipping to the one loaded ahead.
    private func currentItemChanged() {
        guard let item = player.currentItem, item !== current, item === next else { return }
        if let old = current { forget(old) }
        current = item
        index = nextIndex
        next = nil
        nextTrack = nil
        nextIndex = -1
        error = nil
        ended = false
        seekingTo = nil
        pendingStart = nil
        generation += 1
        prepareNext()
        report()
        nowPlaying()
        if item.status == .failed { failed() }
    }

    /// Where the queue goes by itself after this song: this one again with repeat one.
    private func followingIndex() -> Int {
        guard tracks.indices.contains(index) else { return -1 }
        return repeatMode == "one" ? index : skipIndex()
    }

    /// Where "next" goes.
    private func skipIndex() -> Int {
        guard tracks.indices.contains(index) else { return -1 }
        if index + 1 < tracks.count { return index + 1 }
        return repeatMode == "all" ? 0 : -1
    }

    /// Loads the song after this one, unless it's already the one loaded.
    private func prepareNext() {
        let want = followingIndex()
        if next != nil, want == nextIndex, let had = nextTrack, tracks.indices.contains(want), had.id == tracks[want].id, had.url == tracks[want].url {
            return
        }
        if let next {
            player.remove(next)
            forget(next)
        }
        next = nil
        nextTrack = nil
        nextIndex = -1
        guard want >= 0, let current, player.items().contains(current) else { return }
        let item = makeItem(tracks[want])
        guard player.canInsert(item, after: current) else { return forget(item) }
        player.insert(item, after: current)
        next = item
        nextTrack = tracks[want]
        nextIndex = want
    }

    private func makeItem(_ track: Track) -> AVPlayerItem {
        let asset: AVURLAsset
        var itemLoader: StreamLoader?
        if let file = OfflineStore.shared.file(for: track.id) {
            // Downloaded: no server needed, and no data used.
            asset = AVURLAsset(url: file)
        } else if let url = track.url, proxyPort != nil || Self.forceLoader {
            if self.loader?.proxyPort != proxyPort || self.loader == nil {
                if let old = self.loader, !loaders.values.contains(where: { $0 === old }) { old.invalidate() }
                self.loader = StreamLoader(proxyPort: proxyPort)
            }
            let loader = self.loader!
            itemLoader = loader
            asset = AVURLAsset(url: StreamLoader.wrap(url))
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
        } else {
            // A song without a playable address fails, and is skipped like any other that can't play.
            asset = AVURLAsset(url: track.url ?? URL(string: "tuna-missing://song")!)
        }
        let item = AVPlayerItem(asset: asset)
        let key = ObjectIdentifier(item)
        loaders[key] = itemLoader
        itemObservations[key] = item.observe(\.status) { [weak self] item, _ in
            DispatchQueue.main.async { self?.statusChanged(item) }
        }
        return item
    }

    private func forget(_ item: AVPlayerItem) {
        let key = ObjectIdentifier(item)
        itemObservations.removeValue(forKey: key)?.invalidate()
        // A loader from before the tunnel changed goes once its last song has.
        guard let used = loaders.removeValue(forKey: key) else { return }
        if used !== loader, !loaders.values.contains(where: { $0 === used }) { used.invalidate() }
    }

    private func clearItems() {
        player.removeAllItems()
        if let current { forget(current) }
        if let next { forget(next) }
        current = nil
        next = nil
        nextTrack = nil
        nextIndex = -1
    }

    // ---------- What the player says ----------

    private func statusChanged(_ item: AVPlayerItem) {
        guard item === current else { return } // (a next song that fails is dealt with when its turn comes)
        switch item.status {
        case .failed:
            failed()
        case .readyToPlay:
            failures = 0
            if let start = pendingStart {
                let gen = generation
                item.seek(to: CMTime(seconds: start, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                    DispatchQueue.main.async {
                        guard let self, gen == self.generation else { return }
                        self.pendingStart = nil
                        if self.wantsPlay { self.player.play() }
                        self.report()
                        self.nowPlaying()
                    }
                }
            }
            report()
            nowPlaying()
        default:
            break
        }
    }

    @objc private func itemEnded(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem else { return }
        DispatchQueue.main.async { [self] in
            guard item === current else { return }
            // The next song follows by itself (currentItemChanged).
            if let next, next.status != .failed { return }
            if next != nil {
                // The next one didn't load: it gets its turn, fails again (or plays after all) and is skipped.
                return begin(nextIndex, at: 0, play: wantsPlay)
            }
            // The whole queue has played.
            wantsPlay = false
            ended = true
            player.pause()
            clearItems()
            report()
            nowPlaying()
        }
    }

    @objc private func itemFailed(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem else { return }
        DispatchQueue.main.async { [self] in
            if item === current { failed() }
        }
    }

    /// A song that can't be played: say so, then go on to the next one.
    private func failed() {
        guard error == nil else { return }
        error = L("This song couldn't be played")
        failures += 1
        debugLog("song \(index) couldn't be played: \(current?.error?.localizedDescription ?? "?")")
        report()
        let gen = generation
        let after = skipIndex()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [self] in
            guard gen == generation else { return }
            if after >= 0, failures < tracks.count {
                begin(after, at: 0, play: wantsPlay)
            } else {
                wantsPlay = false
                player.pause()
                report()
                nowPlaying()
            }
        }
    }

    // ---------- The state ----------

    private var time: Double {
        if let t = pendingStart { return t }
        if let t = seekingTo { return t }
        guard current != nil else { return 0 }
        let t = player.currentTime().seconds
        return t.isFinite ? max(0, t) : 0
    }

    private var duration: Double {
        if let item = current, item.duration.isNumeric {
            let d = item.duration.seconds
            if d.isFinite, d > 0 { return d }
        }
        return tracks.indices.contains(index) ? tracks[index].duration : 0
    }

    private var buffering: Bool {
        guard wantsPlay, let current else { return false }
        return current.status == .unknown || pendingStart != nil || player.timeControlStatus == .waitingToPlayAtSpecifiedRate
    }

    var state: [String: Any] {
        var s: [String: Any] = [
            "index": index,
            "playing": wantsPlay,
            "buffering": buffering,
            "time": (time * 1000).rounded() / 1000,
            "duration": (duration * 1000).rounded() / 1000,
            "repeat": repeatMode,
        ]
        if ended { s["ended"] = true }
        if let error { s["error"] = error }
        return s
    }

    /// Tells the page, when something changed (or every second while playing: `force`).
    private func report(force: Bool = false) {
        let now = state
        let dict = now as NSDictionary
        if !force, let lastSent, lastSent.isEqual(to: now) { return }
        lastSent = dict
        if !force { debugLog("state \(now)") }
        onState?(now)
    }

    // ---------- Now Playing (menu bar, Control Centre, media keys) ----------

    private func nowPlaying() {
        guard tracks.indices.contains(index) else { return }
        if wantsPlay { nowPlayingShown = true }
        guard nowPlayingShown else { return }
        let t = tracks[index]
        let center = MPNowPlayingInfoCenter.default()
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyArtist: t.artist,
            MPMediaItemPropertyAlbumTitle: t.album,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: time,
            MPNowPlayingInfoPropertyPlaybackRate: wantsPlay && player.timeControlStatus == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let url = OfflineStore.shared.artwork(for: t.id) ?? t.artwork {
            if let artwork, artwork.url == url {
                info[MPMediaItemPropertyArtwork] = Self.artwork(artwork.image)
            } else {
                fetchArtwork(url)
            }
        }
        center.nowPlayingInfo = info
        center.playbackState = wantsPlay ? .playing : .paused
    }

    private func fetchArtwork(_ url: URL) {
        if artworkTask?.originalRequest?.url == url { return }
        artworkTask?.cancel()
        let task = artSession.dataTask(with: url) { [weak self] data, response, _ in
            // (A downloaded one is a file: no status.)
            guard let data, (response as? HTTPURLResponse).map({ $0.statusCode == 200 }) ?? url.isFileURL, let image = NSImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.artwork = (url, image)
                self.artworkTask = nil
                self.nowPlaying()
            }
        }
        artworkTask = task
        task.resume()
    }

    /// (Not on the main actor: the system asks for the picture from its own threads.)
    private static func artwork(_ image: NSImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }

    private static func session(_ proxyPort: Int?) -> URLSession {
        let config = URLSessionConfiguration.default
        if let proxyPort { config.connectionProxyDictionary = Tunnel.proxy(proxyPort) }
        return URLSession(configuration: config)
    }

    private func remoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func on(_ command: MPRemoteCommand, _ action: @escaping (MPRemoteCommandEvent) -> Void) {
            command.isEnabled = true
            command.addTarget { event in
                if Thread.isMainThread { action(event) } else { DispatchQueue.main.async { action(event) } }
                return .success
            }
        }
        on(center.playCommand) { [weak self] _ in self?.play() }
        on(center.pauseCommand) { [weak self] _ in self?.pause() }
        on(center.stopCommand) { [weak self] _ in self?.pause() }
        on(center.togglePlayPauseCommand) { [weak self] _ in self?.toggle() }
        on(center.nextTrackCommand) { [weak self] _ in self?.skipNext() }
        on(center.previousTrackCommand) { [weak self] _ in self?.previous() }
        on(center.changePlaybackPositionCommand) { [weak self] event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { self?.seek(event.positionTime) }
        }
    }

    // ---------- Self-tests ----------

    /// What the player is really doing, for the self-test build.
    var debug: [String: Any] {
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let loaded = (player.currentItem?.loadedTimeRanges ?? []).map { $0.timeRangeValue }.map { $0.start.seconds + $0.duration.seconds }.max() ?? 0
        return [
            "rate": player.rate,
            "timeControlStatus": ["paused", "waiting", "playing"][player.timeControlStatus.rawValue],
            "currentTime": player.currentTime().seconds.isFinite ? player.currentTime().seconds : -1,
            "loadedUpTo": loaded.isFinite ? loaded : -1,
            "items": player.items().count,
            "nextIndex": nextIndex,
            "nextStatus": next.map { ["unknown", "ready", "failed"][$0.status.rawValue] } ?? "none",
            "streamLoader": current.map { loaders[ObjectIdentifier($0)] != nil } ?? false,
            "volume": player.volume,
            "playbackState": ["unknown", "playing", "paused", "stopped", "interrupted"][Int(MPNowPlayingInfoCenter.default().playbackState.rawValue)],
            "nowPlaying": [
                "title": info[MPMediaItemPropertyTitle] ?? NSNull(),
                "artist": info[MPMediaItemPropertyArtist] ?? NSNull(),
                "album": info[MPMediaItemPropertyAlbumTitle] ?? NSNull(),
                "duration": info[MPMediaItemPropertyPlaybackDuration] ?? NSNull(),
                "elapsed": info[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?? NSNull(),
                "rate": info[MPNowPlayingInfoPropertyPlaybackRate] ?? NSNull(),
                "queueIndex": info[MPNowPlayingInfoPropertyPlaybackQueueIndex] ?? NSNull(),
                "artwork": info[MPMediaItemPropertyArtwork].map { _ in true } ?? false,
            ] as [String: Any],
        ]
    }

    /// Self-test only: as if from the media keys or Control Centre.
    func remote(_ name: String, _ value: Double) {
        switch name {
        case "toggle": toggle()
        case "next": skipNext()
        case "previous": previous()
        case "position": seek(value)
        default: break
        }
    }
}

/// Self-test builds print what happens (never the songs' addresses, which carry a key).
func debugLog(_ text: @autoclosure () -> String) {
    guard Bundle.main.bundleIdentifier?.hasSuffix(".selftest") == true else { return }
    print("tuna:", text())
    fflush(stdout)
}
