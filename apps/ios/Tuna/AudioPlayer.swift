import AVFoundation
import MediaPlayer
import UIKit

/// Tuna's player. The page hands over the queue; the app plays it with AVQueuePlayer, the next
/// song loaded ahead so songs follow without a gap, on with the screen locked and from the lock
/// screen, Control Centre and headphone buttons. The page shows what it reports.
final class AudioPlayer: NSObject {
    /// A song as the page sent it (`NativeTrack`), kept as sent for `audio.current`.
    struct Track {
        var raw: [String: Any]
        let id: String
        let url: URL
        let title: String
        let artist: String
        let album: String
        let artwork: URL?
        let duration: Double

        init(_ raw: [String: Any]) {
            self.raw = raw
            id = raw["id"] as? String ?? ""
            // A bad address still takes its place in the queue: it fails and is skipped.
            url = (raw["url"] as? String).flatMap(URL.init(string:)) ?? URL(string: "about:blank")!
            title = raw["title"] as? String ?? ""
            artist = raw["artist"] as? String ?? ""
            album = raw["album"] as? String ?? ""
            artwork = (raw["artwork"] as? String).flatMap(URL.init(string:))
            duration = (raw["duration"] as? NSNumber)?.doubleValue ?? 0
        }
    }

    /// Every change, and about once a second while playing: `NativeAudioState`.
    var onState: (([String: Any]) -> Void)?

    private let player = AVQueuePlayer()
    private var tracks: [Track] = []
    private var index = -1
    private var repeatMode = "off"
    /// Whether the music should be playing (the song may still be loading).
    private var wantsPlay = false
    /// The current song's item, and the next one queued behind it.
    private var item: AVPlayerItem?
    private var ahead: (item: AVPlayerItem, index: Int)?
    /// Where the current song starts once it's ready, and where a seek is going.
    private var pendingSeek: Double?
    private var seekTarget: Double?
    private var failures = 0
    private var lastReported: [String: Any] = [:]
    private var resumeAfterInterruption = false
    private var itemStatus: NSKeyValueObservation?
    private var observations: [NSKeyValueObservation] = []
    private var timeObserver: Any?
    private var artwork: (url: URL, image: UIImage)?
    private var artworkTask: URLSessionDataTask?
    /// The next few songs fetched whole, to play from the phone.
    private let cache = QueueCache()
    /// The sleep timer: when the music stops, or at the end of the song playing.
    private var sleepAt: Date?
    private var sleepTimer: Timer?
    private var sleepAtEnd = false

    override init() {
        super.init()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        player.actionAtItemEnd = .advance
        observations = [
            player.observe(\.currentItem) { [weak self] _, _ in DispatchQueue.main.async { self?.currentItemChanged() } },
            player.observe(\.timeControlStatus) { [weak self] _, _ in DispatchQueue.main.async { self?.statusChanged() } },
        ]
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] _ in
            // Nobody sees the page in the background: it hears again when the app comes back.
            guard UIApplication.shared.applicationState != .background else { return }
            self?.report()
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(failedToEnd(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: nil)
        center.addObserver(self, selector: #selector(playedToEnd(_:)), name: .AVPlayerItemDidPlayToEndTime, object: nil)
        remoteCommands()
        // A song came in: the one queued next plays from the file.
        cache.onReady = { [weak self] in self?.prepareAhead() }
    }

    // ---------- From the page ----------

    func load(tracks list: [[String: Any]], index i: Int, start: Double, play: Bool) {
        tracks = list.map(Track.init)
        failures = 0
        guard tracks.indices.contains(i) else { return stop() }
        begin(i, at: start, play: play)
    }

    /// A new queue around the song that's playing: it carries on, only what follows changes.
    func update(tracks list: [[String: Any]], index i: Int) {
        let next = list.map(Track.init)
        // It may have moved on just before: the song playing, at `i`, then just after, then anywhere.
        var at = i
        if tracks.indices.contains(index) {
            let playing = tracks[index].id
            at = [i, i + 1].first { next.indices.contains($0) && next[$0].id == playing } ?? next.firstIndex { $0.id == playing } ?? i
        }
        guard next.indices.contains(at) else { return }
        tracks = next
        index = at
        prepareAhead()
        keepAhead()
        nowPlaying()
        report()
    }

    func command(_ name: String, _ value: Any?) {
        let number = (value as? NSNumber)?.doubleValue
        switch name {
        case "play": play()
        case "pause": pause()
        case "toggle": wantsPlay ? pause() : play()
        case "next": next()
        case "previous": previous()
        case "seek": if let number { seek(number) }
        case "jump": if let number { begin(Int(number), at: 0, play: true) }
        case "stop": stop()
        case "repeat":
            guard let mode = value as? String, ["off", "all", "one"].contains(mode) else { return }
            repeatMode = mode
            prepareAhead()
            keepAhead()
            report()
        case "volume": if let number { player.volume = Float(max(0, min(1, number))) }
        default: break
        }
    }

    /// A song liked or unliked on the page, kept for `audio.current`.
    func liked(_ id: String, _ on: Bool) {
        for i in tracks.indices where tracks[i].raw["id"] as? String == id { tracks[i].raw["liked"] = on }
    }

    /// What's playing, for the page after it reloads; nil when nothing is.
    var current: [String: Any]? {
        guard !tracks.isEmpty else { return nil }
        return ["tracks": tracks.map(\.raw), "index": index, "state": state]
    }

    var state: [String: Any] {
        let buffering = wantsPlay && item != nil && (pendingSeek != nil || player.timeControlStatus == .waitingToPlayAtSpecifiedRate)
        var s: [String: Any] = ["index": index, "playing": wantsPlay, "buffering": buffering, "time": time, "duration": duration, "repeat": repeatMode, "output": output]
        // From a file on the phone (a download, or the queue kept ahead): the page counts the play.
        if (item?.asset as? AVURLAsset)?.url.isFileURL == true { s["local"] = true }
        if let sleepAt { s["sleep"] = ["at": Int64(sleepAt.timeIntervalSince1970 * 1000)] } else if sleepAtEnd { s["sleep"] = ["endOfSong": true] }
        return s
    }

    /// The sleep timer: stop in `minutes`, or when the song playing ends; neither turns it off.
    func sleep(minutes: Double?, endOfSong: Bool) {
        sleepOff()
        if endOfSong {
            sleepAtEnd = true
            // The song ends paused, not on to the next one (playedToEnd).
            player.actionAtItemEnd = .pause
        } else if let minutes, minutes > 0 {
            let at = Date().addingTimeInterval(minutes * 60)
            sleepAt = at
            // Fires with the screen locked too: the app runs while the music plays.
            let timer = Timer(fire: at, interval: 0, repeats: false) { [weak self] _ in
                self?.sleepOff()
                self?.pause()
            }
            RunLoop.main.add(timer, forMode: .common)
            sleepTimer = timer
        }
        report()
    }

    private func sleepOff() {
        sleepTimer?.invalidate()
        sleepTimer = nil
        sleepAt = nil
        sleepAtEnd = false
        player.actionAtItemEnd = .advance
    }

    /// Where the sound comes out: `NativeOutput` ("AirPods Pro", headphones; the phone itself).
    private var output: [String: Any] {
        guard let port = AVAudioSession.sharedInstance().currentRoute.outputs.first else { return ["name": UIDevice.current.model, "kind": "phone"] }
        let kind: String
        switch port.portType {
        case .builtInSpeaker, .builtInReceiver: kind = "phone"
        case .headphones: kind = "headphones"
        case .bluetoothA2DP, .bluetoothLE, .bluetoothHFP:
            kind = port.portName.range(of: "AirPods|Beats|Buds|Headphone", options: [.regularExpression, .caseInsensitive]) != nil ? "headphones" : "bluetooth"
        case .airPlay: kind = "airplay"
        case .carAudio: kind = "car"
        case .HDMI: kind = "tv"
        default: kind = "speaker"
        }
        return ["name": kind == "phone" ? UIDevice.current.model : port.portName, "kind": kind]
    }

    func stop() {
        sleepOff()
        wantsPlay = false
        item = nil
        ahead = nil
        itemStatus = nil
        pendingSeek = nil
        seekTarget = nil
        player.pause()
        player.removeAllItems()
        tracks = []
        index = -1
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        report()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ---------- Playing ----------

    private func begin(_ i: Int, at seconds: Double, play: Bool) {
        guard tracks.indices.contains(i) else { return }
        index = i
        wantsPlay = play
        let next = makeItem(tracks[i])
        item = next
        ahead = nil
        seekTarget = nil
        pendingSeek = seconds > 0.5 ? seconds : nil
        player.removeAllItems()
        player.insert(next, after: nil)
        watch(next)
        if play { activate() }
        if play && pendingSeek == nil { player.play() } else { player.pause() }
        prepareAhead()
        nowPlaying()
        report()
    }

    private func play() {
        guard !tracks.isEmpty else { return }
        // A sleep timer that came due while the app was paused and asleep is over.
        if let sleepAt, sleepAt <= Date() { sleepOff() }
        // After the queue has ended (or a song failed for good): start the song again.
        guard item != nil else { return begin(max(0, index), at: 0, play: true) }
        wantsPlay = true
        activate()
        if pendingSeek == nil { player.play() }
        report()
        nowPlayingTime()
    }

    private func pause() {
        wantsPlay = false
        player.pause()
        report()
        nowPlayingTime()
    }

    private func next() {
        guard let n = following(auto: false) else { return }
        guard let ahead, ahead.index == n else { return begin(n, at: 0, play: true) }
        // Already loaded behind this one.
        wantsPlay = true
        activate()
        player.advanceToNextItem()
        player.play()
        currentItemChanged()
    }

    /// Back to the start of the song if it's more than 3 seconds in, otherwise the one before.
    private func previous() {
        if item != nil && (time > 3 || index <= 0) { return seek(0) }
        begin(max(0, index - 1), at: 0, play: true)
    }

    private func seek(_ seconds: Double) {
        guard let item else { return }
        let to = max(0, seconds)
        if pendingSeek != nil || item.status != .readyToPlay {
            pendingSeek = to
            return report()
        }
        seekTarget = to
        player.seek(to: CMTime(seconds: to, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.seekTarget == to { self.seekTarget = nil }
                self.report()
                self.nowPlayingTime()
            }
        }
        report()
        nowPlayingTime()
    }

    /// The song after this one: the same one again on repeat one (when it ends by itself), and the
    /// first after the last on repeat all.
    private func following(auto: Bool) -> Int? {
        guard tracks.indices.contains(index) else { return nil }
        if auto && repeatMode == "one" { return index }
        if index + 1 < tracks.count { return index + 1 }
        return repeatMode == "all" ? 0 : nil
    }

    /// Queue the next song behind the current one, so it follows without a gap.
    private func prepareAhead() {
        guard let current = item else { return }
        let n = following(auto: true)
        if let n, let queued = ahead, (queued.item.asset as? AVURLAsset)?.url == source(tracks[n]) {
            ahead = (queued.item, n)
            return
        }
        for queued in player.items() where queued !== current { player.remove(queued) }
        ahead = nil
        guard let n else { return }
        let next = makeItem(tracks[n])
        guard player.canInsert(next, after: current) else { return }
        player.insert(next, after: current)
        ahead = (next, n)
    }

    /// A song to play, with the equalizer.
    private func makeItem(_ track: Track) -> AVPlayerItem {
        let item = AVPlayerItem(url: source(track))
        Equalizer.shared.attach(to: item)
        return item
    }

    /// The song's file when it's downloaded or kept ahead (no server needed, and no data used), else
    /// the server's address.
    private func source(_ track: Track) -> URL {
        OfflineStore.shared.file(for: track.id) ?? cache.file(for: track.url) ?? track.url
    }

    /// Once the song playing has loaded: the next few fetched whole, to play from the phone.
    private func keepAhead() {
        guard item?.status == .readyToPlay, tracks.indices.contains(index) else { return }
        let upcoming = (1...cache.ahead).compactMap { step -> Track? in
            let i = index + step
            if i < tracks.count { return tracks[i] }
            return repeatMode == "all" && i - tracks.count < index ? tracks[i - tracks.count] : nil
        }
        cache.keep(upcoming.map { ($0.id, $0.url) }, playing: (tracks[index].id, tracks[index].url))
    }

    private func activate() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    // ---------- What the player says ----------

    private func watch(_ watched: AVPlayerItem) {
        itemStatus = watched.observe(\.status, options: [.initial]) { [weak self] observed, _ in
            DispatchQueue.main.async { self?.itemStatusChanged(observed) }
        }
    }

    private func itemStatusChanged(_ observed: AVPlayerItem) {
        guard observed === item else { return }
        switch observed.status {
        case .readyToPlay:
            if let at = pendingSeek, seekTarget == nil {
                seekTarget = at
                observed.seek(to: CMTime(seconds: at, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                    DispatchQueue.main.async {
                        guard let self, observed === self.item else { return }
                        // Moved again while it was getting there.
                        let again = self.pendingSeek.flatMap { $0 == at ? nil : $0 }
                        self.pendingSeek = nil
                        self.seekTarget = nil
                        if let again { self.seek(again) }
                        if self.wantsPlay { self.player.play() }
                        self.report()
                        self.nowPlayingTime()
                    }
                }
            }
            nowPlayingTime()
            report()
            keepAhead()
        case .failed:
            failed()
        default:
            break
        }
    }

    private func currentItemChanged() {
        let now = player.currentItem
        guard now !== item else { return }
        if let queued = ahead, now === queued.item || now == nil {
            // On to the song that was loaded ahead (if it failed, the queue drops it: skip it too).
            item = queued.item
            index = queued.index
            ahead = nil
            pendingSeek = nil
            seekTarget = nil
            watch(queued.item)
            if now == nil { return failed() }
            prepareAhead()
            nowPlaying()
            report()
        } else if now == nil, let ended = item, ended.status != .failed {
            // The whole queue has played (a song that failed is skipped instead: failed()).
            item = nil
            wantsPlay = false
            nowPlayingTime()
            report(["ended": true])
        }
    }

    private func statusChanged() {
        if player.timeControlStatus == .playing { failures = 0 }
        // Paused by the system (not through Tuna): show it.
        if player.timeControlStatus == .paused, player.rate == 0, wantsPlay, pendingSeek == nil, item?.status == .readyToPlay, player.currentItem === item {
            wantsPlay = false
        }
        report()
        nowPlayingTime()
    }

    /// A song that can't play: say so, then go on to the next one.
    private func failed() {
        let broken = item
        failures += 1
        report(["error": L("This song couldn't play")])
        guard failures < tracks.count else {
            wantsPlay = false
            player.pause()
            return report()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, self.item === broken else { return }
            if let n = self.following(auto: false) {
                self.begin(n, at: 0, play: self.wantsPlay)
            } else {
                self.item = nil
                self.wantsPlay = false
                self.player.removeAllItems()
                self.report(["ended": true])
            }
        }
    }

    private var time: Double {
        if let target = pendingSeek ?? seekTarget { return target }
        guard item != nil else { return 0 }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? max(0, seconds) : 0
    }

    private var duration: Double {
        if let seconds = item?.duration.seconds, seconds.isFinite, seconds > 0 { return seconds }
        return tracks.indices.contains(index) ? tracks[index].duration : 0
    }

    private func report(_ extra: [String: Any] = [:]) {
        let message = state.merging(extra) { _, new in new }
        // Several things often change at once: the page hears each state once.
        guard !NSDictionary(dictionary: message).isEqual(to: lastReported) else { return }
        lastReported = message
        onState?(message)
    }

    // ---------- Calls, other apps, headphones ----------

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
        DispatchQueue.main.async { [self] in
            switch type {
            case .began:
                resumeAfterInterruption = wantsPlay
                wantsPlay = false
                report()
                nowPlayingTime()
            case .ended:
                if resumeAfterInterruption && options.contains(.shouldResume) { play() }
                resumeAfterInterruption = false
            @unknown default:
                break
            }
        }
    }

    /// Headphones unplugged (or Bluetooth gone): pause, rather than play out loud. Any change: the
    /// page shows where the sound goes now.
    @objc private func routeChanged(_ note: Notification) {
        let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        DispatchQueue.main.async {
            if reason == .oldDeviceUnavailable { self.pause() }
            self.report()
        }
    }

    /// The sleep timer at the end of a song: it stops there, the next one ready to play.
    @objc private func playedToEnd(_ note: Notification) {
        DispatchQueue.main.async { [self] in
            guard sleepAtEnd, let ended = note.object as? AVPlayerItem, ended === item else { return }
            sleepOff()
            wantsPlay = false
            player.pause()
            player.advanceToNextItem()
            currentItemChanged()
        }
    }

    /// The connection dropped mid-song.
    @objc private func failedToEnd(_ note: Notification) {
        DispatchQueue.main.async {
            if let broken = note.object as? AVPlayerItem, broken === self.item { self.failed() }
        }
    }

    // ---------- Lock screen and Control Centre ----------

    private func remoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        on(center.playCommand) { player, _ in player.play() }
        on(center.pauseCommand) { player, _ in player.pause() }
        on(center.togglePlayPauseCommand) { player, _ in player.command("toggle", nil) }
        on(center.nextTrackCommand) { player, _ in player.next() }
        on(center.previousTrackCommand) { player, _ in player.previous() }
        on(center.changePlaybackPositionCommand) { player, event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { player.seek(event.positionTime) }
        }
    }

    private func on(_ command: MPRemoteCommand, _ action: @escaping (AudioPlayer, MPRemoteCommandEvent) -> Void) {
        command.addTarget { [weak self] event in
            guard let self, !self.tracks.isEmpty else { return .noActionableNowPlayingItem }
            action(self, event)
            return .success
        }
    }

    private func nowPlaying() {
        guard tracks.indices.contains(index) else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let track = tracks[index]
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyAlbumTitle: track.album,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count,
        ]
        if let artwork, artwork.url == artworkURL(track) {
            let image = artwork.image
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        nowPlayingTime()
        loadArtwork(track)
    }

    /// Where the song is and whether it's moving (the lock screen counts on from there).
    private func nowPlayingTime() {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = time
        info[MPNowPlayingInfoPropertyPlaybackRate] = wantsPlay && player.timeControlStatus == .playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// The downloaded artwork, when there is one.
    private func artworkURL(_ track: Track) -> URL? {
        OfflineStore.shared.artwork(for: track.id) ?? track.artwork
    }

    private func loadArtwork(_ track: Track) {
        guard let url = artworkURL(track), artwork?.url != url, artworkTask?.originalRequest?.url != url else { return }
        artworkTask?.cancel()
        artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.artwork = (url, image)
                if self.tracks.indices.contains(self.index), self.artworkURL(self.tracks[self.index]) == url { self.nowPlaying() }
            }
        }
        artworkTask?.resume()
    }
}
