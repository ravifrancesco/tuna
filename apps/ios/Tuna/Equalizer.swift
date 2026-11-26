import Accelerate
import AVFoundation
import MediaToolbox

/// The equalizer (`audio.eq`, docs/native-bridge.md): a low shelf at 60 Hz, peaks at 150 Hz,
/// 400 Hz, 1 kHz and 2.4 kHz, a high shelf at 15 kHz, and the whole lowered by the highest boost
/// so nothing clips. While it's on, every song the player plays gets a processing tap that picks
/// up a change on its next buffer, crossfading from the old sound to the new over that buffer.
/// Only while it's on: AVPlayer leaves a moment of silence after a song with a tap, so off, songs
/// still follow each other without a gap. The last setting is kept for the next start. The iPhone
/// and Mac apps share this file (apps/mac/build.sh compiles it too).
final class Equalizer {
    static let shared = Equalizer()

    /// What every tap reads, under `lock`: a version that changes with each setting, on (1) or off
    /// (0), then the six gains in dB.
    private let values = UnsafeMutablePointer<Double>.allocate(capacity: 8)
    private let lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    private var on = false
    /// The songs handed to the player, while they last.
    private let items = NSHashTable<AVPlayerItem>.weakObjects()

    private init() {
        lock.initialize(to: os_unfair_lock())
        values.initialize(repeating: 0, count: 8)
        if let saved = UserDefaults.standard.dictionary(forKey: "eq") { set(saved, keep: false) }
    }

    /// `{ on, gains }` from the page: heard at once, and kept for the next start.
    func set(_ args: [String: Any], keep: Bool = true) {
        let given = (args["gains"] as? [NSNumber])?.map(\.doubleValue) ?? []
        let gains = (0..<6).map { i in i < given.count && given[i].isFinite ? min(12, max(-12, given[i])) : 0 }
        let on = args["on"] as? Bool ?? false
        os_unfair_lock_lock(lock)
        values[0] += 1
        values[1] = on ? 1 : 0
        for i in 0..<6 { values[2 + i] = gains[i] }
        os_unfair_lock_unlock(lock)
        if keep { UserDefaults.standard.set(["on": on, "gains": gains], forKey: "eq") }
        // Turned on or off: the songs playing and coming up get their taps, or lose them. A song
        // under way keeps its tap (letting the sound through as it is): taking it away, or adding
        // one, stops the sound for a moment.
        guard on != self.on else { return }
        self.on = on
        for item in items.allObjects {
            if on { tap(item) } else if !(item.currentTime().seconds > 0) { item.audioMix = nil }
        }
    }

    /// A song for the player: it gets the equalizer while it's on.
    func attach(to item: AVPlayerItem) {
        items.add(item)
        if on { tap(item) }
    }

    /// Gives a song its tap, once it knows its sound.
    private func tap(_ item: AVPlayerItem) {
        item.asset.loadTracks(withMediaType: .audio) { tracks, _ in
            guard let track = tracks?.first else { return }
            DispatchQueue.main.async {
                guard self.on, item.audioMix == nil else { return }
                item.audioMix = self.mix(for: track)
            }
        }
    }

    /// An audio mix whose tap runs the equalizer on `track`.
    func mix(for track: AVAssetTrack) -> AVAudioMix? {
        let filter = UnsafeMutablePointer<Filter>.allocate(capacity: 1)
        filter.initialize(to: Filter(values: values, lock: lock))
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(filter),
            init: { _, info, storage in storage.pointee = info },
            finalize: { tap in
                let filter = Filter.of(tap)
                filter.pointee.unprepare()
                filter.deinitialize(count: 1)
                filter.deallocate()
            },
            prepare: { tap, maxFrames, format in Filter.of(tap).pointee.prepare(maxFrames, format.pointee) },
            unprepare: { tap in Filter.of(tap).pointee.unprepare() },
            process: { tap, frames, _, buffers, framesOut, flagsOut in
                guard MTAudioProcessingTapGetSourceAudio(tap, frames, buffers, flagsOut, nil, framesOut) == noErr else { return }
                let restart = flagsOut.pointee & MTAudioProcessingTapFlags(kMTAudioProcessingTapFlag_StartOfStream) != 0
                Filter.of(tap).pointee.process(UnsafeMutableAudioBufferListPointer(buffers), framesOut.pointee, restart: restart)
            }
        )
        var tap: MTAudioProcessingTap?
        guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr, let tap else {
            filter.deinitialize(count: 1)
            filter.deallocate()
            return nil
        }
        let input = AVMutableAudioMixInputParameters(track: track)
        input.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [input]
        return mix
    }

    /// The biquad coefficients (b0, b1, b2, a1, a2 for each band) for six `gains` at `rate` Hz.
    static func coefficients(_ gains: UnsafePointer<Double>, rate: Double, into c: UnsafeMutablePointer<Double>) {
        for band in 0..<6 {
            let out = c + band * 5
            let gain = gains[band]
            guard gain != 0 else {
                out.update(repeating: 0, count: 5)
                out[0] = 1
                continue
            }
            // Robert Bristow-Johnson's cookbook: shelves with slope 1, peaks with Q 1.
            let a = pow(10, gain / 40)
            let w = 2 * Double.pi * min(frequency(band), rate * 0.45) / rate
            let cw = cos(w), sw = sin(w)
            var b0, b1, b2, a0, a1, a2: Double
            if band == 0 || band == 5 {
                let k = 2 * sqrt(a) * sw / sqrt(2), s: Double = band == 0 ? 1 : -1
                b0 = a * ((a + 1) - s * (a - 1) * cw + k)
                b1 = s * 2 * a * ((a - 1) - s * (a + 1) * cw)
                b2 = a * ((a + 1) - s * (a - 1) * cw - k)
                a0 = (a + 1) + s * (a - 1) * cw + k
                a1 = -s * 2 * ((a - 1) + s * (a + 1) * cw)
                a2 = (a + 1) + s * (a - 1) * cw - k
            } else {
                let alpha = sw / 2
                b0 = 1 + alpha * a
                b1 = -2 * cw
                b2 = 1 - alpha * a
                a0 = 1 + alpha / a
                a1 = -2 * cw
                a2 = 1 - alpha / a
            }
            out[0] = b0 / a0
            out[1] = b1 / a0
            out[2] = b2 / a0
            out[3] = a1 / a0
            out[4] = a2 / a0
        }
    }

    private static func frequency(_ band: Int) -> Double {
        switch band {
        case 0: return 60
        case 1: return 150
        case 2: return 400
        case 3: return 1000
        case 4: return 2400
        default: return 15000
        }
    }
}

/// One song's equalizer, on the audio thread: it never waits for a lock and allocates only while
/// being prepared. Six biquads per channel in double precision (in single precision, low shelves
/// lose accuracy audibly), and a spare set the next setting goes into.
struct Filter {
    private static let sections = 6

    private let values: UnsafeMutablePointer<Double>
    private let lock: UnsafeMutablePointer<os_unfair_lock>
    private var ready = false
    private var rate = 0.0, channels = 0, capacity = 0
    /// The setting in use: its version, whether it filters at all, and its lowered level.
    private var heard = -1.0, on = false, gain = 1.0
    /// The next one, once heard (its coefficients in `spare`).
    private var wantOn = false, wantGain = 1.0
    private var live: vDSP_biquadm_SetupD?, spare: vDSP_biquadm_SetupD?
    /// Each channel as doubles (`ins` and `outs` are the same buffers), and the old sound while crossfading.
    private var samples: UnsafeMutablePointer<Double>?
    private var ins: UnsafeMutablePointer<UnsafePointer<Double>>?
    private var outs: UnsafeMutablePointer<UnsafeMutablePointer<Double>>?, olds: UnsafeMutablePointer<UnsafeMutablePointer<Double>>?
    private var copy: UnsafeMutablePointer<Double>?, coefficients: UnsafeMutablePointer<Double>?

    init(values: UnsafeMutablePointer<Double>, lock: UnsafeMutablePointer<os_unfair_lock>) {
        self.values = values
        self.lock = lock
    }

    static func of(_ tap: MTAudioProcessingTap) -> UnsafeMutablePointer<Filter> {
        MTAudioProcessingTapGetStorage(tap).assumingMemoryBound(to: Filter.self)
    }

    mutating func prepare(_ maxFrames: Int, _ format: AudioStreamBasicDescription) {
        unprepare()
        // The player hands over 32-bit floats; anything else passes through as it is.
        guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32,
              format.mSampleRate > 0, (1...16).contains(format.mChannelsPerFrame), maxFrames > 0 else { return }
        rate = format.mSampleRate
        channels = Int(format.mChannelsPerFrame)
        capacity = maxFrames
        let flat = (0..<Self.sections * channels * 5).map { $0 % 5 == 0 ? 1.0 : 0 }
        live = vDSP_biquadm_CreateSetupD(flat, vDSP_Length(Self.sections), vDSP_Length(channels))
        spare = vDSP_biquadm_CreateSetupD(flat, vDSP_Length(Self.sections), vDSP_Length(channels))
        let samples = UnsafeMutablePointer<Double>.allocate(capacity: 2 * channels * capacity)
        samples.initialize(repeating: 0, count: 2 * channels * capacity)
        let ins = UnsafeMutablePointer<UnsafePointer<Double>>.allocate(capacity: channels)
        let outs = UnsafeMutablePointer<UnsafeMutablePointer<Double>>.allocate(capacity: channels)
        let olds = UnsafeMutablePointer<UnsafeMutablePointer<Double>>.allocate(capacity: channels)
        for c in 0..<channels {
            (ins + c).initialize(to: UnsafePointer(samples + c * capacity))
            (outs + c).initialize(to: samples + c * capacity)
            (olds + c).initialize(to: samples + (channels + c) * capacity)
        }
        (self.samples, self.ins, self.outs, self.olds) = (samples, ins, outs, olds)
        copy = .allocate(capacity: 8)
        copy?.initialize(repeating: 0, count: 8)
        coefficients = .allocate(capacity: Self.sections * 5)
        coefficients?.initialize(repeating: 0, count: Self.sections * 5)
        guard live != nil, spare != nil else { return unprepare() }
        ready = true
        heard = -1
        on = false
        gain = 1
        // A song starts with the setting as it is, no crossfade.
        if hear() { switchOver() }
    }

    mutating func unprepare() {
        ready = false
        if let live { vDSP_biquadm_DestroySetupD(live) }
        if let spare { vDSP_biquadm_DestroySetupD(spare) }
        samples?.deallocate()
        ins?.deallocate()
        outs?.deallocate()
        olds?.deallocate()
        copy?.deallocate()
        coefficients?.deallocate()
        (live, spare, samples, ins, outs, olds, copy, coefficients) = (nil, nil, nil, nil, nil, nil, nil, nil)
    }

    mutating func process(_ list: UnsafeMutableAudioBufferListPointer, _ frames: Int, restart: Bool) {
        guard ready, frames > 0, frames <= capacity, let live, let spare, let ins, let outs, let olds else { return }
        // After a seek: what came before is no longer there.
        if restart { vDSP_biquadm_ResetStateD(live) }
        let changed = hear()
        let fade = changed && (on || wantOn)
        if changed && !fade { switchOver() }
        guard on || fade else { return }
        let n = vDSP_Length(frames)
        var c = 0
        for b in 0..<list.count {
            guard let data = list[b].mData?.assumingMemoryBound(to: Float.self) else { continue }
            let k = Int(list[b].mNumberChannels)
            for i in 0..<k where c < channels {
                vDSP_vspdp(data + i, vDSP_Stride(k), outs[c], 1, n)
                c += 1
            }
        }
        if !fade {
            vDSP_biquadmD(live, ins, 1, outs, 1, n)
            for c in 0..<channels { vDSP_vsmulD(outs[c], 1, &gain, outs[c], 1, n) }
        } else {
            // The old sound (into `olds`) fades out as the new one fades in.
            if on {
                vDSP_biquadm_CopyStateD(spare, live)
                vDSP_biquadmD(live, ins, 1, olds, 1, n)
            } else {
                for c in 0..<channels { olds[c].update(from: outs[c], count: frames) }
                vDSP_biquadm_ResetStateD(spare)
            }
            if wantOn { vDSP_biquadmD(spare, ins, 1, outs, 1, n) }
            for c in 0..<channels {
                var start = on ? gain : 1, step = -start / Double(frames)
                vDSP_vrampmulD(olds[c], 1, &start, &step, olds[c], 1, n)
                start = 0
                step = (wantOn ? wantGain : 1) / Double(frames)
                vDSP_vrampmulD(outs[c], 1, &start, &step, outs[c], 1, n)
                vDSP_vaddD(olds[c], 1, outs[c], 1, outs[c], 1, n)
            }
            switchOver()
        }
        c = 0
        for b in 0..<list.count {
            guard let data = list[b].mData?.assumingMemoryBound(to: Float.self) else { continue }
            let k = Int(list[b].mNumberChannels)
            for i in 0..<k where c < channels {
                vDSP_vdpsp(outs[c], 1, data + i, vDSP_Stride(k), n)
                c += 1
            }
        }
    }

    /// Picks up a new setting, if there is one and the lock is free this time: its coefficients
    /// go into `spare`.
    private mutating func hear() -> Bool {
        guard let copy, let coefficients, let spare, os_unfair_lock_trylock(lock) else { return false }
        let fresh = values[0] != heard
        if fresh { copy.update(from: values, count: 8) }
        os_unfair_lock_unlock(lock)
        guard fresh else { return false }
        heard = copy[0]
        var top = 0.0, any = false
        for i in 2..<8 {
            top = max(top, copy[i])
            any = any || copy[i] != 0
        }
        wantOn = copy[1] != 0 && any
        wantGain = pow(10, -top / 20)
        if wantOn {
            Equalizer.coefficients(copy + 2, rate: rate, into: coefficients)
            for c in 0..<channels { vDSP_biquadm_SetCoefficientsDoubleD(spare, coefficients, 0, vDSP_Length(c), vDSP_Length(Self.sections), 1) }
        }
        return true
    }

    /// The setting heard becomes the one in use.
    private mutating func switchOver() {
        if wantOn { swap(&live, &spare) }
        on = wantOn
        gain = on ? wantGain : 1
    }
}
