import AVFoundation
import Foundation

/// Plays the incoming-call ringtone. Ringtones are synthesised in memory so the
/// app has no audio asset dependencies.
final class Ringer {
    private var player: AVAudioPlayer?
    private var current: RingtoneChoice?
    private var previewTimer: Timer?

    func play(_ choice: RingtoneChoice, volume: Double) {
        guard choice != .silent else { stop(); return }
        if let player, player.isPlaying, current == choice {
            player.volume = Float(volume)
            return
        }
        stop()
        guard let data = RingtoneSynth.cachedWAV(for: choice),
              let player = try? AVAudioPlayer(data: data, fileTypeHint: AVFileType.wav.rawValue) else { return }
        player.numberOfLoops = -1
        player.volume = Float(max(0, min(1, volume)))
        player.prepareToPlay()
        player.play()
        self.player = player
        current = choice
    }

    func stop() {
        previewTimer?.invalidate()
        previewTimer = nil
        player?.stop()
        player = nil
        current = nil
    }

    /// Plays a few seconds of a ringtone from the settings screen.
    func preview(_ choice: RingtoneChoice, volume: Double) {
        play(choice, volume: volume)
        previewTimer?.invalidate()
        previewTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { [weak self] _ in
            self?.stop()
        }
    }

    var isPlaying: Bool { player?.isPlaying ?? false }
}

enum RingtoneSynth {
    static let sampleRate = 22_050.0
    private static var cache: [RingtoneChoice: Data] = [:]
    private static let lock = NSLock()

    static func cachedWAV(for choice: RingtoneChoice) -> Data? {
        lock.lock(); defer { lock.unlock() }
        if let data = cache[choice] { return data }
        let data = wavData(for: choice)
        cache[choice] = data
        return data
    }

    static func wavData(for choice: RingtoneChoice) -> Data {
        let samples: [Float]
        switch choice {
        case .classicUK:
            samples = cadence([(0.4, true), (0.2, false), (0.4, true), (2.0, false)]) { t in
                dualTone(t, 400, 450)
            }
        case .classicUS:
            samples = cadence([(2.0, true), (4.0, false)]) { t in
                dualTone(t, 440, 480)
            }
        case .digital:
            samples = cadence([(0.5, true), (0.25, false), (0.5, true), (1.75, false)]) { t in
                let warble = Int(t / 0.04) % 2 == 0
                return sin(2 * .pi * (warble ? 1200.0 : 1600.0) * t) * 0.7
            }
        case .marimba:
            samples = marimba()
        case .silent:
            samples = [Float](repeating: 0, count: Int(sampleRate))
        }
        return wav(samples)
    }

    private static func dualTone(_ t: Double, _ f1: Double, _ f2: Double) -> Double {
        (sin(2 * .pi * f1 * t) + sin(2 * .pi * f2 * t)) * 0.45
    }

    /// Builds one loop of on/off segments with short fades to avoid clicks.
    private static func cadence(_ segments: [(Double, Bool)], tone: (Double) -> Double) -> [Float] {
        var samples: [Float] = []
        let fade = Int(sampleRate * 0.005)
        for (duration, on) in segments {
            let count = Int(duration * sampleRate)
            if !on {
                samples.append(contentsOf: [Float](repeating: 0, count: count))
                continue
            }
            for i in 0..<count {
                let t = Double(i) / sampleRate
                var amplitude = tone(t)
                if i < fade { amplitude *= Double(i) / Double(fade) }
                if i > count - fade { amplitude *= Double(count - i) / Double(fade) }
                samples.append(Float(amplitude))
            }
        }
        return samples
    }

    private static func marimba() -> [Float] {
        let notes: [Double] = [659.25, 783.99, 987.77, 1318.51, 987.77, 783.99]
        var samples: [Float] = []
        let noteLength = 0.22
        for note in notes {
            let count = Int(noteLength * sampleRate)
            for i in 0..<count {
                let t = Double(i) / sampleRate
                let envelope = exp(-t * 9)
                let value = (sin(2 * .pi * note * t) * 0.6 + sin(2 * .pi * note * 4 * t) * 0.15) * envelope
                samples.append(Float(value))
            }
        }
        samples.append(contentsOf: [Float](repeating: 0, count: Int(1.6 * sampleRate)))
        return samples
    }

    private static func wav(_ samples: [Float]) -> Data {
        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = max(-1, min(1, sample))
            var value = Int16(clamped * 32_000)
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }
        var data = Data()
        func append(_ string: String) { data.append(contentsOf: Array(string.utf8)) }
        func append32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func append16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        append("RIFF")
        append32(UInt32(36 + pcm.count))
        append("WAVE")
        append("fmt ")
        append32(16)
        append16(1)
        append16(1)
        append32(UInt32(sampleRate))
        append32(UInt32(sampleRate) * 2)
        append16(2)
        append16(16)
        append("data")
        append32(UInt32(pcm.count))
        data.append(pcm)
        return data
    }
}
