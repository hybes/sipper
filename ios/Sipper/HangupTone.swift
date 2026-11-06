import AVFoundation
import Foundation

/// The short three-beep tone played when a call ends, matching the desktop apps.
enum HangupTone {
    static let sampleRate = 16_000
    static let defaultsKey = "playHangupTone"
    private static let beepMilliseconds = 120, gapMilliseconds = 60, fadeMilliseconds = 8
    private static let level = 0.25
    private static let frequencies: [Double] = [880, 660, 440]

    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    /// Calls that connected here, or outgoing calls, get a tone unless another call is still connected.
    static func shouldPlay(ended: CallSnapshot, remaining: [CallSnapshot], enabled: Bool) -> Bool {
        enabled && (ended.connectedAt != nil || ended.direction == .outgoing)
            && !remaining.contains { $0.id != ended.id && $0.state == .confirmed }
    }

    static func samples(sampleRate: Int = sampleRate) -> [Int16] {
        let beep = sampleRate * beepMilliseconds / 1000, gap = sampleRate * gapMilliseconds / 1000
        let fade = Double(sampleRate * fadeMilliseconds / 1000)
        var output = [Int16](repeating: 0, count: beep * frequencies.count + gap * (frequencies.count - 1))
        for (index, frequency) in frequencies.enumerated() {
            let start = index * (beep + gap)
            for n in 0..<beep {
                let envelope = min(1, Double(min(n, beep - 1 - n)) / fade)
                let value = sin(2 * .pi * frequency * Double(n) / Double(sampleRate)) * level * envelope
                output[start + n] = Int16((value * Double(Int16.max)).rounded())
            }
        }
        return output
    }

    /// A 16-bit mono WAV file, so AVAudioPlayer can play it without a bundled resource.
    static func wav() -> Data {
        let pcm = samples()
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(pcm.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36) + bytes)
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(bytes)
        pcm.forEach { append($0) }
        return data
    }
}

/// Plays the tone on its own short-lived audio session once CallKit has released call audio.
@MainActor
final class HangupTonePlayer: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    /// False while a new call owns the audio session, so the tone never deactivates call audio.
    var canReleaseSession: () -> Bool = { true }

    func play() {
        guard player == nil else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            let player = try AVAudioPlayer(data: HangupTone.wav())
            player.delegate = self
            player.volume = 0.8
            self.player = player
            if !player.play() { finish() }
        } catch { finish() } // A missing tone must never affect call handling.
    }

    /// A call is taking the audio session: stop the tone and hand back the call category without
    /// deactivating anything, so the new call keeps its microphone.
    func cancel(restoringCallAudio restore: () throws -> Void) {
        player?.delegate = nil // No finish callback: it would deactivate the new call's session.
        player?.stop()
        player = nil
        try? restore()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finish() }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.finish() }
    }
    private func finish() {
        player = nil
        guard canReleaseSession() else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
