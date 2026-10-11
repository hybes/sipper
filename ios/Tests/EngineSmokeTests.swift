import XCTest
import CallKit
@testable import SipperIOS

@MainActor
final class EngineSmokeTests: XCTestCase {
    func testConferenceCallKitActionsKeepBothLegsAndCancelOnce() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else {
            throw XCTSkip("Requires the isolated direct registrar")
        }
        let engine = SIPEngine(), observer = EngineObserver(), reporter = RecordingCalls()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        engine.delegate = observer
        let account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(account, "fictional-dnd")])
        try await until { engine.currentRegistration(accountID: account.id).isRegistered }
        let provider = CXProvider(configuration: CXProviderConfiguration())
        var transactions: [CXTransaction] = [], groups: [RecordingGroupAction] = [], errors: [String] = []
        var reject = false, rejectSeparateResume = false
        var bridge: CallKitBridge!
        bridge = CallKitBridge(engine: engine, reporter: reporter, requestTransaction: { transaction in
            if reject || (rejectSeparateResume && transaction.actions.count == 2 && transaction.actions.allSatisfy { $0 is CXSetHeldCallAction }) {
                throw MobileError.callUnavailable
            }
            transactions.append(transaction)
            // Deliver actions concurrently, as the production bridge must await real SIP negotiations.
            for action in transaction.actions {
                if let start = action as? CXStartCallAction { bridge.provider(provider, perform: start) }
                else if let hold = action as? CXSetHeldCallAction { bridge.provider(provider, perform: hold) }
                else if let mute = action as? CXSetMutedCallAction { bridge.provider(provider, perform: mute) }
                else if let end = action as? CXEndCallAction { bridge.provider(provider, perform: end) }
                else if let group = action as? CXSetGroupCallAction {
                    let recording = RecordingGroupAction(call: group.callUUID, callUUIDToGroupWith: group.callUUIDToGroupWith)
                    groups.append(recording); bridge.provider(provider, perform: recording)
                } else { XCTFail("Unexpected conference action") }
            }
        })
        defer { bridge = nil }
        observer.bridge = bridge
        bridge.canUseAccount = { $0 == account.id }
        bridge.requestMicrophone = { true }
        bridge.onError = { errors.append($0) }
        func call(_ id: Int) throws -> CallSnapshot { try XCTUnwrap(engine.activeCalls().first { $0.id == id }) }
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().first?.state == .confirmed && !bridge.changingCalls }
        let first = try XCTUnwrap(engine.activeCalls().first)
        try await until { (engine.mediaForTesting(first)?.sent ?? 0) >= 5 }
        let firstUUID = try XCTUnwrap(transactions.last?.actions.last as? CXStartCallAction).callUUID
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed } && !bridge.changingCalls }
        let second = try XCTUnwrap(engine.activeCalls().first { $0.id != first.id })
        let secondUUID = try XCTUnwrap(transactions.last?.actions.last as? CXStartCallAction).callUUID
        try await until { reporter.updates[firstUUID]?.supportsGrouping == true && reporter.updates[secondUUID]?.supportsGrouping == true }
        XCTAssertTrue(try XCTUnwrap(reporter.updates[firstUUID]).supportsGrouping)
        XCTAssertTrue(try XCTUnwrap(reporter.updates[secondUUID]).supportsGrouping)
        reject = true
        bridge.merge(try call(first.id), with: try call(second.id))
        try await until { errors.count == 1 }
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == nil })
        XCTAssertTrue(try call(first.id).isOnHold); XCTAssertFalse(try call(second.id).isOnHold)
        reject = false
        bridge.merge(try call(first.id), with: try call(second.id))
        try await until { groups.last?.succeeded == true && !bridge.changingCalls }
        let group = try XCTUnwrap(try call(first.id).conferenceID)
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == group && !$0.isOnHold })
        XCTAssertFalse(try XCTUnwrap(reporter.updates[firstUUID]).supportsGrouping)
        XCTAssertTrue(try XCTUnwrap(reporter.updates[firstUUID]).supportsUngrouping)
        XCTAssertThrowsError(try engine.attendedTransfer(try call(first.id), to: try call(second.id)))
        let duplicate = RecordingGroupAction(call: firstUUID, callUUIDToGroupWith: secondUUID)
        bridge.provider(provider, perform: duplicate)
        XCTAssertEqual(duplicate.succeeded, false); XCTAssertEqual(duplicate.completions, 1)
        bridge.mute(try call(first.id))
        try await until { engine.activeCalls().allSatisfy(\.isMuted) }
        let holdFirst = RecordingHoldAction(call: firstUUID, onHold: true)
        let holdSecond = RecordingHoldAction(call: secondUUID, onHold: true)
        bridge.provider(provider, perform: holdFirst); bridge.provider(provider, perform: holdSecond)
        try await until { holdFirst.succeeded != nil && holdSecond.succeeded != nil && !bridge.changingCalls }
        XCTAssertEqual(holdFirst.succeeded, true); XCTAssertEqual(holdSecond.succeeded, true)
        XCTAssertEqual(holdFirst.completions, 1); XCTAssertEqual(holdSecond.completions, 1)
        XCTAssertTrue(engine.activeCalls().allSatisfy(\.isOnHold))
        bridge.hold(try call(second.id))
        try await until { engine.activeCalls().allSatisfy { !$0.isOnHold } && !bridge.changingCalls }
        XCTAssertEqual(transactions.last?.actions.count, 1, "Resuming a conference must not hold its own participant")
        bridge.hold(try call(first.id))
        try await until { engine.activeCalls().allSatisfy(\.isOnHold) && !bridge.changingCalls }
        let resumeFirst = RecordingHoldAction(call: firstUUID, onHold: false)
        let resumeSecond = RecordingHoldAction(call: secondUUID, onHold: false)
        bridge.provider(provider, perform: resumeFirst); bridge.provider(provider, perform: resumeSecond)
        try await until { resumeFirst.succeeded != nil && resumeSecond.succeeded != nil && !bridge.changingCalls }
        XCTAssertEqual(resumeFirst.succeeded, true); XCTAssertEqual(resumeSecond.succeeded, true)
        XCTAssertEqual(resumeFirst.completions, 1); XCTAssertEqual(resumeSecond.completions, 1)
        XCTAssertTrue(engine.activeCalls().allSatisfy { !$0.isOnHold })
        bridge.separate(try call(second.id))
        try await until { engine.activeCalls().allSatisfy { $0.conferenceID == nil } && (try? call(second.id).isOnHold) == false && !bridge.changingCalls }
        XCTAssertTrue(try call(first.id).isOnHold)
        XCTAssertEqual(transactions.last?.actions.count, 2, "CallKit receives the separated held/active states after ungrouping completes")
        XCTAssertTrue(try XCTUnwrap(reporter.updates[firstUUID]).supportsGrouping)
        XCTAssertFalse(try XCTUnwrap(reporter.updates[firstUUID]).supportsUngrouping)
        bridge.merge(try call(first.id), with: try call(second.id))
        try await until { engine.activeCalls().allSatisfy { $0.conferenceID != nil } && !bridge.changingCalls }
        rejectSeparateResume = true
        let errorCount = errors.count
        bridge.separate(try call(first.id))
        try await until { errors.count > errorCount && !bridge.changingCalls }
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == nil && $0.isOnHold }, "Rejected follow-up requests must never expose either private call")
        rejectSeparateResume = false
        let cancelled = RecordingGroupAction(call: firstUUID, callUUIDToGroupWith: secondUUID)
        bridge.provider(provider, perform: cancelled)
        bridge.provider(provider, timedOutPerforming: cancelled)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(cancelled.succeeded, false); XCTAssertEqual(cancelled.completions, 1)
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == nil })
        bridge.merge(try call(first.id), with: try call(second.id))
        try await until { engine.activeCalls().allSatisfy { $0.conferenceID != nil } && !bridge.changingCalls }
        let third = try engine.makeCall(accountID: account.id, uri: account.callURI(for: "*97"))
        try await until { (try? call(third.id).state) == .confirmed }
        try await engine.setHold(try call(third.id), onHold: true)
        bridge.endConference(try call(first.id))
        try await until { engine.activeCalls().count == 1 && engine.activeCalls().first?.id == third.id }
        XCTAssertEqual(transactions.last?.actions.count, 2)
        XCTAssertTrue(transactions.last?.actions.allSatisfy { $0 is CXEndCallAction } == true)
        engine.hangup(third)
        try await until { engine.activeCalls().isEmpty }
        let oldEnd = RecordingEndAction(call: firstUUID)
        bridge.provider(provider, perform: oldEnd)
        XCTAssertEqual(oldEnd.succeeded, false)
        // A participant leaving or a provider reset while ungrouping cannot complete the group action twice.
        for reset in [false, true] {
            try await bridge.start(account: account, target: "sip:*slowhold@sipper.test;transport=udp")
            try await until { engine.activeCalls().first?.state == .confirmed && !bridge.changingCalls }
            let slow = try XCTUnwrap(engine.activeCalls().first)
            let slowUUID = try XCTUnwrap(transactions.last?.actions.last as? CXStartCallAction).callUUID
            try await bridge.start(account: account, target: "*97")
            try await until { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed } && !bridge.changingCalls }
            let peer = try XCTUnwrap(engine.activeCalls().first { $0.id != slow.id })
            bridge.merge(try call(slow.id), with: try call(peer.id))
            try await until { engine.activeCalls().allSatisfy { $0.conferenceID != nil } && !bridge.changingCalls }
            let separating = RecordingGroupAction(call: slowUUID, callUUIDToGroupWith: nil)
            bridge.provider(provider, perform: separating)
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertNil(separating.succeeded)
            if reset { bridge.providerDidReset(provider) }
            else { engine.hangup(peer) }
            try await until { separating.succeeded != nil && !bridge.changingCalls }
            try await Task.sleep(for: .milliseconds(1100))
            XCTAssertEqual(separating.succeeded, false); XCTAssertEqual(separating.completions, 1)
            XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == nil })
            if !reset {
                if try call(slow.id).isOnHold {
                    bridge.hold(try call(slow.id))
                    try await until { (try? call(slow.id).isOnHold) == false && !bridge.changingCalls }
                }
                XCTAssertTrue(try call(slow.id).hasActiveMedia, "A surviving participant remains controllable after the group action is cancelled")
                engine.hangup(slow)
            }
            try await until { engine.activeCalls().isEmpty }
        }
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().first?.state == .confirmed && !bridge.changingCalls }
        let departing = try XCTUnwrap(engine.activeCalls().first)
        let departingUUID = try XCTUnwrap(transactions.last?.actions.last as? CXStartCallAction).callUUID
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed } && !bridge.changingCalls }
        let retained = try XCTUnwrap(engine.activeCalls().first { $0.id != departing.id })
        bridge.merge(try call(departing.id), with: try call(retained.id))
        try await until { engine.activeCalls().allSatisfy { $0.conferenceID != nil } && !bridge.changingCalls }
        bridge.hold(try call(departing.id))
        try await until { engine.activeCalls().allSatisfy(\.isOnHold) && !bridge.changingCalls }
        let cancelledResume = RecordingHoldAction(call: departingUUID, onHold: false)
        bridge.provider(provider, perform: cancelledResume)
        bridge.provider(provider, perform: RecordingEndAction(call: departingUUID))
        try await until { engine.activeCalls().count == 1 && !bridge.changingCalls }
        XCTAssertEqual(cancelledResume.succeeded, false); XCTAssertEqual(cancelledResume.completions, 1)
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed } && !bridge.changingCalls }
        XCTAssertNil(try call(retained.id).conferenceID, "Cancelled resume must release its shared hold task rather than await itself")
        engine.hangupAll()
        try await until { engine.activeCalls().isEmpty }
    }
    func testConsultationUsesOneCallKitTransactionAndPreservesCallsOnRejectedRequests() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else {
            throw XCTSkip("Requires the isolated direct registrar")
        }
        let engine = SIPEngine(), observer = EngineObserver(), reporter = RecordingCalls()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        engine.delegate = observer
        let account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(account, "fictional-dnd")])
        try await until { engine.currentRegistration(accountID: account.id).isRegistered }
        let provider = CXProvider(configuration: CXProviderConfiguration())
        var transactions: [CXTransaction] = [], reject = false
        var bridge: CallKitBridge!
        bridge = CallKitBridge(engine: engine, reporter: reporter, requestTransaction: { transaction in
            if reject { throw MobileError.callUnavailable }
            transactions.append(transaction)
            // Exercise the real delegate in CallKit's documented action order, without system audio.
            for action in transaction.actions {
                if let hold = action as? CXSetHeldCallAction { bridge.provider(provider, perform: hold) }
                else if let start = action as? CXStartCallAction { bridge.provider(provider, perform: start) }
                else { XCTFail("Unexpected consultation action") }
            }
        })
        defer { bridge = nil }
        observer.bridge = bridge
        bridge.canUseAccount = { $0 == account.id }
        bridge.onError = { XCTFail($0) }
        bridge.requestMicrophone = { true }
        try await bridge.start(account: account, target: "*97")
        try await until { !engine.activeCalls().isEmpty }
        var holdErrors: [String] = []
        bridge.onError = { holdErrors.append($0) }
        let rejectedHold = RecordingHoldAction(call: try XCTUnwrap(transactions.first?.actions.first as? CXStartCallAction).callUUID, onHold: true)
        bridge.provider(provider, perform: rejectedHold)
        try await until { rejectedHold.succeeded != nil }
        XCTAssertEqual(rejectedHold.succeeded, false, "The real engine rejects hold before the call is confirmed")
        XCTAssertEqual(holdErrors.count, 1)
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold)
        bridge.onError = { XCTFail($0) }
        try await until { engine.activeCalls().first?.state == .confirmed }
        let first = try XCTUnwrap(engine.activeCalls().first)
        XCTAssertEqual(transactions.count, 1); XCTAssertEqual(transactions[0].actions.count, 1)
        bridge.requestMicrophone = { false }
        do { try await bridge.start(account: account, target: "*97"); XCTFail("Microphone denial must fail") } catch {}
        bridge.requestMicrophone = { true }
        do { try await bridge.start(account: account, target: "bad\r\nnumber"); XCTFail("Invalid input must fail") } catch {}
        reject = true
        do { try await bridge.start(account: account, target: "*97"); XCTFail("Rejected transaction must fail") } catch {}
        XCTAssertEqual(transactions.count, 1)
        XCTAssertEqual(engine.activeCalls().count, 1); XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold)
        reject = false
        try await bridge.start(account: account, target: "*97")
        try await until { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed } }
        let second = try XCTUnwrap(engine.activeCalls().first { $0.id != first.id })
        XCTAssertEqual(transactions[1].actions.count, 2)
        XCTAssertTrue(transactions[1].actions[0] is CXSetHeldCallAction)
        XCTAssertTrue(transactions[1].actions[1] is CXStartCallAction)
        XCTAssertTrue(try XCTUnwrap(engine.activeCalls().first { $0.id == first.id }).isOnHold)
        do { try await bridge.start(account: account, target: "*97"); XCTFail("Third call must fail") } catch {}
        XCTAssertEqual(transactions.count, 2)
        var stale = first; stale.startedAt = first.startedAt.addingTimeInterval(-1)
        bridge.answer(stale); bridge.end(stale); bridge.mute(stale); bridge.hold(stale); bridge.dtmf(stale, digits: "1")
        await Task.yield()
        XCTAssertEqual(transactions.count, 2, "Stale controls must never act on a reused numeric SIP ID")
        bridge.hold(try XCTUnwrap(engine.activeCalls().first { $0.id == first.id }))
        try await until {
            engine.activeCalls().first { $0.id == first.id }?.isOnHold == false &&
            engine.activeCalls().first { $0.id == second.id }?.isOnHold == true
        }
        XCTAssertEqual(transactions[2].actions.count, 2, "Resuming a call holds the other call in the same transaction")
        try engine.attendedTransfer(first, to: second)
        try await until { engine.activeCalls().isEmpty && reporter.ended.count == 2 }
        // Deliver both delegates without waiting: admission must await the other call's actual hold result.
        bridge.onError = { holdErrors.append($0) }
        try await bridge.start(account: account, target: "sip:*nohold@sipper.test;transport=udp")
        try await until { engine.activeCalls().first?.state == .confirmed }
        let retained = try XCTUnwrap(engine.activeCalls().first)
        let errorCount = holdErrors.count
        try await bridge.start(account: account, target: "*97")
        try await until { holdErrors.count >= errorCount + 2 }
        XCTAssertEqual(engine.activeCalls().count, 1, "A failed hold action must prevent the concurrent start delegate admitting audio")
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold)
        engine.hangup(retained)
        try await until { engine.activeCalls().isEmpty }
        for reset in [false, true] {
            try await bridge.start(account: account, target: "sip:*slowhold@sipper.test;transport=udp")
            try await until { engine.activeCalls().first?.state == .confirmed }
            let call = try XCTUnwrap(engine.activeCalls().first)
            let uuid = try XCTUnwrap(transactions.last?.actions.last as? CXStartCallAction).callUUID
            let held = RecordingHoldAction(call: uuid, onHold: true)
            bridge.provider(provider, perform: held)
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertNil(held.succeeded, "CallKit cannot be fulfilled before negotiated hold")
            if reset { bridge.providerDidReset(provider) }
            else { bridge.provider(provider, timedOutPerforming: held); engine.hangup(call) }
            try await until { engine.activeCalls().isEmpty }
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(held.succeeded, false)
            XCTAssertEqual(held.completions, 1, "A late result cannot fulfil or fail a cancelled action again")
        }
    }
    func testIOSLibraryStartsWithTLSAndOpusWithoutOpeningCallAudio() throws {
        let engine = SIPEngine()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        XCTAssertTrue(engine.isRunning)
        XCTAssertTrue(engine.codecs().contains { $0.id.hasPrefix("opus/") })
        XCTAssertTrue(engine.activeCalls().isEmpty)
    }

    func testLocalSIPRegistrationCallAndManagedExpiry() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_REGISTRAR"] == "127.0.0.1" else {
            throw XCTSkip("Start the local registrar and set SIPPER_TEST_REGISTRAR=127.0.0.1 as described in ios/README.md")
        }
        let engine = SIPEngine(), observer = EngineObserver()
        engine.delegate = observer
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        var account = SIPAccount(profileID: UUID(), username: "ios-test", domain: "sipper.test", server: "127.0.0.1", port: 5094, transport: .udp)
        account.managed = ManagedAccountBinding(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(8))
        let registered = expectation(description: "Real SIP registrar accepted REGISTER")
        observer.registered = registered
        engine.syncAccounts([(account, "local-ios-test")])
        XCTAssertTrue(engine.hasApplied([(account, "local-ios-test")]))
        await fulfillment(of: [registered], timeout: 5)
        let connected = expectation(description: "SIP call confirmed")
        observer.connected = connected
        let call = try engine.makeCall(accountID: account.id, uri: "sip:*echo@sipper.test;transport=udp")
        await fulfillment(of: [connected], timeout: 5)
        engine.hangup(call, code: 480, onlyIfRinging: true)
        XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed }, "A delayed ringing-status response must not end a connected call")
        try await Task.sleep(for: .seconds(9))
        XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed }, "Ordinary access expiry preserves the established call")
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: "sip:*echo@sipper.test;transport=udp"))
        XCTAssertThrowsError(try engine.transfer(call, to: "*97"))
        XCTAssertFalse(engine.hasApplied([(account, "local-ios-test")]))
        let ended = expectation(description: "SIP call ended")
        observer.ended = ended
        engine.hangup(callID: call.id)
        await fulfillment(of: [ended], timeout: 5)
    }

    func testLocalSIPRegistrationRejectsWrongPassword() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_REGISTRAR"] == "127.0.0.1" else {
            throw XCTSkip("Requires the isolated loopback registrar")
        }
        let engine = SIPEngine(), observer = EngineObserver()
        engine.delegate = observer
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        let account = SIPAccount(profileID: UUID(), username: "ios-test", domain: "sipper.test", server: "127.0.0.1", port: 5094, transport: .udp)
        let rejected = expectation(description: "Registrar rejected the wrong password")
        observer.rejected = rejected
        let registered = expectation(description: "Wrong password must never register")
        registered.isInverted = true
        observer.registered = registered
        engine.syncAccounts([(account, "incorrect-fixture-password")])
        await fulfillment(of: [rejected, registered], timeout: 3)
    }
    private func until(file: StaticString = #filePath, line: UInt = #line, _ check: () -> Bool) async throws {
        for _ in 0..<200 { if check() { return }; try await Task.sleep(for: .milliseconds(25)) }
        XCTFail("Timed out waiting for the native call state", file: file, line: line)
        throw NSError(domain: "CallKitEngineTests", code: 1)
    }
}

@MainActor
private final class EngineObserver: @preconcurrency SIPEngineDelegate {
    weak var bridge: CallKitBridge?
    var registered: XCTestExpectation?
    var rejected: XCTestExpectation?
    var connected: XCTestExpectation?
    var ended: XCTestExpectation?
    func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState) {
        if state.isRegistered { registered?.fulfill(); registered = nil }
        if case .failed(let code, _) = state, code == 401 || code == 403 {
            rejected?.fulfill(); rejected = nil
        }
    }
    func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) {
        bridge?.changed(call)
        if call.state == .confirmed { connected?.fulfill(); connected = nil }
    }
    func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot) { bridge?.ended(call); ended?.fulfill(); ended = nil }
    func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) {}
    func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo) {}
    func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool) {}
    func sipEngineDidStop(_ engine: SIPEngine, error: Error?) {}
}
