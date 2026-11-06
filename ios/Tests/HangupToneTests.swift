import XCTest
@testable import SipperIOS

final class HangupToneTests: XCTestCase {
    func testThreeFadedBeepsWithSilentGapsAndAValidWAVHeader() {
        let samples = HangupTone.samples(sampleRate: 16_000)
        XCTAssertEqual(samples.count, 16 * (120 * 3 + 60 * 2))
        XCTAssertEqual(samples.first, 0); XCTAssertEqual(samples.last, 0)
        XCTAssertTrue(samples[(16 * 120)..<(16 * 180)].allSatisfy { $0 == 0 })
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertTrue((7_000...8_300).contains(peak), "about a quarter of full scale, was \(peak)")
        let wav = HangupTone.wav()
        XCTAssertEqual(wav.count, 44 + samples.count * 2)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
    }

    func testOnlyConnectedOrOutgoingCallsWithNoOtherConnectedCall() {
        func call(_ id: Int, _ direction: CallDirection, _ state: CallState, connected: Bool) -> CallSnapshot {
            CallSnapshot(id: id, accountID: UUID(), direction: direction, state: state, remoteURI: "sip:100@example.invalid",
                         remoteNumber: "100", remoteName: "", isMuted: false, isOnHold: false, isRemoteHold: false,
                         hasActiveMedia: connected, startedAt: Date(), connectedAt: connected ? Date() : nil,
                         lastStatusCode: 200, lastStatusText: "OK")
        }
        let answered = call(1, .incoming, .disconnected, connected: true)
        let missed = call(2, .incoming, .disconnected, connected: false)
        let outgoing = call(3, .outgoing, .disconnected, connected: false)
        let other = call(4, .outgoing, .confirmed, connected: true)
        let ringing = call(5, .incoming, .incoming, connected: false)
        XCTAssertTrue(HangupTone.shouldPlay(ended: answered, remaining: [], enabled: true))
        XCTAssertTrue(HangupTone.shouldPlay(ended: outgoing, remaining: [ringing], enabled: true))
        XCTAssertFalse(HangupTone.shouldPlay(ended: missed, remaining: [], enabled: true))
        XCTAssertFalse(HangupTone.shouldPlay(ended: answered, remaining: [other], enabled: true))
        XCTAssertFalse(HangupTone.shouldPlay(ended: answered, remaining: [], enabled: false))
    }
}
