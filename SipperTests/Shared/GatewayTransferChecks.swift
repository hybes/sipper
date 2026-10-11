import XCTest
#if os(macOS)
@testable import Sipper
#else
@testable import SipperIOS
#endif

extension XCTestCase {
    /// Invoked only by the isolated native gateway tests, using null audio.
    @MainActor
    func checkGatewayTransfers(_ engine: SIPEngine, account: SIPAccount, ready: String, completed: String) async throws {
        struct Timeout: Error { let step: String }
        func wait(_ step: String, _ check: () throws -> Bool) async throws {
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                if try check() { return }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw Timeout(step: step)
        }
        func call(_ number: String) async throws -> CallSnapshot {
            let call = try engine.makeCall(accountID: account.id, uri: account.callURI(for: number))
            do {
                try await wait("Gateway call \(number) and encrypted Opus media") {
                    guard let media = engine.mediaForTesting(call) else { return false }
                    return engine.activeCalls().contains { $0.id == call.id && $0.startedAt == call.startedAt && $0.connectedAt != nil }
                        && media.codec.lowercased() == "opus" && media.sent >= 5 && media.received >= 5
                        && media.microphoneConnected && media.speakerConnected
                        && media.transport.contains("SRTP status: Active") && media.transport.contains("state: Negotiation Success")
                }
            } catch {
                let current = engine.activeCalls().first { $0.id == call.id && $0.startedAt == call.startedAt }
                let media = engine.mediaForTesting(call)
                print("Gateway media timeout for fixture \(number): state=\(String(describing: current?.state)), status=\(current?.lastStatusCode ?? 0), codec=\(media?.codec ?? "none"), sent=\(media?.sent ?? 0), received=\(media?.received ?? 0), SRTP=\(media?.transport.contains("SRTP status: Active") == true), ICE=\(media?.transport.contains("state: Negotiation Success") == true)")
                print("Gateway audio connections: VAD=\(String(describing: media?.vad)), microphone=\(String(describing: media?.microphoneConnected)), speaker=\(String(describing: media?.speakerConnected)), captureDevice=\(media?.captureDevice ?? -1)")
                print("Gateway native media state: active=\(current?.hasActiveMedia == true), held=\(current?.isOnHold == true), muted=\(current?.isMuted == true)")
                let wiring = engine.log.snapshot().flatMap { $0.components(separatedBy: .newlines) }.compactMap { line -> String? in
                    guard let match = line.range(of: "Conf (connect|disconnect): [0-9]+ (-->|-x-) [0-9]+|Error sending RTP[^\\n]*|Codec encode\\(\\) error[^\\n]*", options: .regularExpression) else { return nil }
                    return String(line[match])
                }
                print("Gateway media operations: \(wiring.suffix(20).joined(separator: "; "))")
                throw error
            }
            return call
        }
        func hold(_ call: CallSnapshot) async throws {
            engine.log.clear()
            try await engine.setHold(call, onHold: true)
            try await wait("Hold SDP accepted before transfer") {
                engine.activeCalls().contains { $0.id == call.id && $0.isOnHold }
                    && engine.log.snapshot().contains { $0.contains("SDP negotiation done: Success") }
            }
        }
        func finished(_ phase: String) async throws {
            try await wait("Transferred local legs ended") { engine.activeCalls().isEmpty }
            try phase.write(toFile: ready, atomically: true, encoding: .utf8)
            try await wait("Remote media handoff and gateway cleanup: \(phase)") {
                (try? String(contentsOfFile: completed, encoding: .utf8)) == phase
            }
        }
        // Reuse native call/media slots after recovery before testing the mixer and transfers.
        for _ in 0..<6 {
            let first = try await call("2000"), second = try await call("2001")
            engine.hangup(first); engine.hangup(second)
            try await wait("Repeated gateway calls ended") { engine.activeCalls().isEmpty }
        }
        // Echo receives silence before the mixer forwards the other caller's tone.
        // This measures received media from the remote echo leg, not the speaker's local mix.
        let echo = try await call("2000"), tone = try await call("2001")
        try await wait("Tone source and silent echo before conference") {
            (engine.incomingAudioLevelForTesting(tone) ?? 0) >= 4 && (engine.incomingAudioLevelForTesting(echo) ?? 255) <= 1
        }
        try engine.beginConference(echo, with: tone)
        try await wait("Tone forwarded through the gateway and returned by the remote echo") {
            (engine.incomingAudioLevelForTesting(echo) ?? 0) >= 4
        }
        let grouped = try XCTUnwrap(engine.activeCalls().first { $0.id == echo.id })
        XCTAssertNotNil(grouped.conferenceID)
        try await engine.setConferenceHold(grouped, onHold: true)
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.isOnHold && !$0.hasActiveMedia })
        try await engine.setConferenceHold(grouped, onHold: false)
        try await wait("Remote-party audio resumes after conference hold") {
            (engine.incomingAudioLevelForTesting(echo) ?? 0) >= 4
        }
        try engine.splitConference(grouped)
        try await wait("Splitting removes remote-party audio forwarding") {
            (engine.incomingAudioLevelForTesting(echo) ?? 255) <= 1
        }
        engine.hangup(echo); engine.hangup(tone)
        try await finished("conference-media")
        let first = try await call("2000")
        for invalid in ["sip:2001@external.invalid", "2001@localhost", "ABCD", String(repeating: "1", count: 129)] {
            XCTAssertThrowsError(try engine.transfer(first, to: invalid))
        }
        try engine.transfer(first, to: "2004") // Fixture rejects this number.
        try await wait("Rejected transfer leaves original call connected") {
            engine.activeCalls().contains { $0.id == first.id && $0.connectedAt != nil && !$0.isTransferring && $0.transferStatus?.hasPrefix("Transfer failed") == true }
        }
        let before = try XCTUnwrap(engine.mediaForTesting(first))
        try await wait("Media still advances after rejection") {
            guard let media = engine.mediaForTesting(first) else { return false }
            return media.sent > before.sent + 5 && media.received > before.received + 5
        }
        try await hold(first)
        try engine.transfer(first, to: "2001")
        try await finished("transfer-blind-media")

        let held = try await call("2000")
        try await hold(held)
        let consultation = try await call("2001")
        try engine.attendedTransfer(held, to: consultation)
        XCTAssertThrowsError(try engine.transfer(consultation, to: "2000"))
        try await finished("transfer-attended-media")
        XCTAssertThrowsError(try engine.attendedTransfer(held, to: consultation))
    }
}
