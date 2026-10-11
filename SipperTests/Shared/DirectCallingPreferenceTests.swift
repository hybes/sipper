import XCTest
import SipperManaged
#if os(macOS)
@testable import Sipper
#else
@testable import SipperIOS
#endif

@MainActor
final class DirectCallingPreferenceTests: XCTestCase {
    func testConferenceRequiresCurrentOwnedMediaAndPreservesTheSurvivingCall() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else { throw XCTSkip("Requires the isolated direct registrar") }
        let engine = SIPEngine()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        settings.localUDPPort = 0; settings.localTCPPort = 0; settings.localTLSPort = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        var account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        account.managed = .init(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(120))
        let other = SIPAccount(profileID: UUID(), username: "dnd-peer", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(account, "fictional-dnd"), (other, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered && engine.currentRegistration(accountID: other.id).isRegistered }
        func connected(_ account: SIPAccount, _ number: String = "*echo") async throws -> CallSnapshot {
            let call = try engine.makeCall(accountID: account.id, uri: "sip:\(number)@sipper.test;transport=udp")
            try await wait { engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed && $0.hasActiveMedia } }
            return call
        }
        let first = try await connected(account), second = try await connected(account), unrelated = try await connected(other)
        XCTAssertThrowsError(try engine.beginConference(first, with: first))
        XCTAssertThrowsError(try engine.beginConference(first, with: unrelated))
        var stale = first; stale.startedAt = first.startedAt.addingTimeInterval(-1)
        XCTAssertThrowsError(try engine.beginConference(stale, with: second))
        try await engine.setHold(first, onHold: true)
        XCTAssertThrowsError(try engine.beginConference(first, with: second), "Resume must be negotiated before the mixer can join either party")
        try await engine.setHold(first, onHold: false)
        engine.setMuted(callID: first.id, muted: true)
        try engine.beginConference(first, with: second)
        var members = engine.activeCalls().filter { $0.accountID == account.id }
        let group = try XCTUnwrap(members.first?.conferenceID)
        XCTAssertTrue(members.allSatisfy { $0.conferenceID == group && $0.isMuted })
        XCTAssertNil(engine.activeCalls().first { $0.id == unrelated.id }?.conferenceID)
        XCTAssertThrowsError(try engine.beginConference(first, with: second))
        XCTAssertThrowsError(try engine.transfer(first, to: "*97"))
        do { try await engine.setHold(first, onHold: true); XCTFail("Individual hold must not silently split a conference") }
        catch { guard case SIPEngineError.conferenceControlRequired = error else { XCTFail("Unexpected error: \(error)"); return } }
        engine.setMuted(callID: second.id, muted: false)
        XCTAssertTrue(engine.activeCalls().filter { $0.accountID == account.id }.allSatisfy { !$0.isMuted })
        engine.setMuted(stale, muted: true)
        XCTAssertTrue(engine.activeCalls().filter { $0.accountID == account.id }.allSatisfy { !$0.isMuted }, "A stale microphone action cannot mute either current participant")
        let captured = try XCTUnwrap(members.first)
        try await engine.setConferenceHold(captured, onHold: true)
        XCTAssertTrue(engine.activeCalls().filter { $0.accountID == account.id }.allSatisfy { $0.isOnHold && !$0.hasActiveMedia && $0.conferenceID == group })
        try await engine.setConferenceHold(captured, onHold: false)
        XCTAssertTrue(engine.activeCalls().filter { $0.accountID == account.id }.allSatisfy { !$0.isOnHold && $0.hasActiveMedia })
        try engine.splitConference(captured)
        XCTAssertTrue(engine.activeCalls().allSatisfy { $0.conferenceID == nil })
        try await engine.setHold(first, onHold: true)
        try await engine.mergeConference(first, with: second)
        XCTAssertThrowsError(try engine.splitConference(captured), "A stale group control must not split a later conference on the same calls")
        engine.syncAccounts([(other, "fictional-dnd")])
        members = engine.activeCalls().filter { $0.accountID == account.id }
        XCTAssertEqual(members.count, 2); XCTAssertTrue(members.allSatisfy { $0.conferenceID != nil && $0.hasActiveMedia })
        engine.hangup(first)
        try await wait { !engine.activeCalls().contains { $0.id == first.id } }
        XCTAssertNil(try XCTUnwrap(engine.activeCalls().first { $0.id == second.id }).conferenceID)
        XCTAssertTrue(try XCTUnwrap(engine.activeCalls().first { $0.id == second.id }).hasActiveMedia)
        XCTAssertThrowsError(try engine.beginConference(second, with: unrelated))
        engine.hangup(second)
        try await wait { engine.activeCalls().count == 1 }
        engine.syncAccounts([(account, "fictional-dnd"), (other, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered }
        let normal = try await connected(account), rejecting = try await connected(account, "*nohold")
        try engine.beginConference(normal, with: rejecting)
        let current = try XCTUnwrap(engine.activeCalls().first { $0.id == normal.id })
        do { try await engine.setConferenceHold(current, onHold: true); XCTFail("Second-party rejection must fail group hold") }
        catch { guard case SIPEngineError.holdRejected(code: 488) = error else { XCTFail("Unexpected group hold failure: \(error)"); return } }
        XCTAssertTrue(engine.activeCalls().filter { $0.accountID == account.id }.allSatisfy { !$0.isOnHold && $0.hasActiveMedia && $0.conferenceID == current.conferenceID }, "A rejected second leg restores the first without disconnecting either person")
        engine.hangupConference(captured)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(engine.activeCalls().count, 3, "A stale conference action must not end newly allocated calls")
        engine.hangupConference(current)
        try await wait { engine.activeCalls().count == 1 }
        XCTAssertEqual(engine.activeCalls().first?.accountID, other.id, "Ending a conference does not end unrelated calls")
        let slow = try await connected(account, "*slowhold"), departing = try await connected(account)
        try engine.beginConference(slow, with: departing)
        let negotiating = try XCTUnwrap(engine.activeCalls().first { $0.id == slow.id })
        let hold = Task { try await engine.setConferenceHold(negotiating, onHold: true) }
        try await Task.sleep(for: .milliseconds(100))
        engine.hangup(departing)
        do { try await hold.value; XCTFail("An ended peer must fail the group operation") }
        catch { guard case SIPEngineError.unknownCall = error else { XCTFail("Unexpected ended-peer failure: \(error)"); return } }
        let survivor = try XCTUnwrap(engine.activeCalls().first { $0.id == slow.id })
        XCTAssertNil(survivor.conferenceID)
        XCTAssertTrue(survivor.hasActiveMedia && !survivor.isOnHold, "A party leaving during group hold restores the captured survivor")
        engine.hangup(slow)
        engine.hangup(unrelated)
        try await wait { engine.activeCalls().isEmpty }
    }

    func testHoldRejectsFailedCommandsAndStaleIdentityWhilePreservingEstablishedCalls() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else { throw XCTSkip("Requires the isolated direct registrar") }
        let engine = SIPEngine(), observer = DirectPreferenceObserver()
        engine.delegate = observer
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 4
        try engine.start(settings: settings)
        defer { engine.stop() }
        var account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        account.managed = .init(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(120))
        engine.syncAccounts([(account, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered }
        let call = try engine.makeCall(accountID: account.id, uri: "sip:*97@sipper.test;transport=udp")
        do { try await engine.setHold(call, onHold: true); XCTFail("Expected the native hold rejection") }
        catch { guard case SIPEngineError.pjsip = error else { XCTFail("Expected the native hold rejection"); return } }
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold, "A rejected native command must not mark the calling leg held")
        try await wait { engine.activeCalls().first?.state == .confirmed }
        var stale = call; stale.startedAt = call.startedAt.addingTimeInterval(-1)
        do { try await engine.setHold(stale, onHold: true); XCTFail("A stale call must fail") }
        catch { guard case SIPEngineError.unknownCall = error else { XCTFail("Expected stale identity rejection"); return } }
        stale = call; stale.accountID = UUID()
        do { try await engine.setHold(stale, onHold: true); XCTFail("A stale call must fail") }
        catch { guard case SIPEngineError.unknownCall = error else { XCTFail("Expected stale identity rejection"); return } }
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold)
        // Withdrawal prevents new calls, but the established call must remain controllable.
        engine.syncAccounts([])
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: "sip:*97@sipper.test"))
        try await engine.setHold(call, onHold: true)
        try await wait { engine.activeCalls().first?.isOnHold == true && engine.activeCalls().first?.hasActiveMedia == false }
        try await engine.setHold(call, onHold: false)
        try await wait { engine.activeCalls().first?.isOnHold == false && engine.activeCalls().first?.hasActiveMedia == true }
        engine.hangup(call)
        try await wait { engine.activeCalls().isEmpty }
        do { try await engine.setHold(call, onHold: true); XCTFail("An ended call must fail") }
        catch { guard case SIPEngineError.unknownCall = error else { XCTFail("Expected ended call rejection"); return } }
        engine.syncAccounts([(account, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered }
        let rejected = try engine.makeCall(accountID: account.id, uri: "sip:*nohold@sipper.test;transport=udp")
        try await wait { engine.activeCalls().first?.state == .confirmed }
        do { try await engine.setHold(rejected, onHold: true); XCTFail("A rejected negotiation must fail") }
        catch { guard case SIPEngineError.holdRejected(code: 488) = error else { XCTFail("Expected the remote SIP rejection: \(error)"); return } }
        let retained = try XCTUnwrap(engine.activeCalls().first)
        XCTAssertEqual(retained.state, .confirmed); XCTAssertTrue(retained.hasActiveMedia); XCTAssertFalse(retained.isOnHold)
        XCTAssertFalse(observer.changed.contains { $0.id == rejected.id && $0.startedAt == rejected.startedAt && $0.isOnHold }, "The UI must never receive an optimistic held state for the rejected offer")
        engine.hangup(rejected)
        try await wait { engine.activeCalls().isEmpty }
    }

    func testHoldWaitsForNegotiationAndFencesLateRepliesWithoutBlockingHangup() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else { throw XCTSkip("Requires the isolated direct registrar") }
        let engine = SIPEngine()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        let account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(account, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered }
        func connected(_ number: String) async throws -> CallSnapshot {
            let call = try engine.makeCall(accountID: account.id, uri: "sip:\(number)@sipper.test;transport=udp")
            try await wait { engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed && $0.hasActiveMedia } }
            return call
        }
        let slow = try await connected("*slowhold")
        let hold = Task { try await engine.setHold(slow, onHold: true) }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first).isOnHold)
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: "sip:*97@sipper.test"))
        do { try await engine.setHold(slow, onHold: true); XCTFail("Duplicate negotiation must fail") }
        catch { guard case SIPEngineError.holdUpdating = error else { XCTFail("Expected pending hold rejection"); return } }
        try await hold.value
        XCTAssertTrue(try XCTUnwrap(engine.activeCalls().first).isOnHold, "Returning success requires actual negotiated hold")
        try await engine.setHold(slow, onHold: false)
        XCTAssertTrue(try XCTUnwrap(engine.activeCalls().first).hasActiveMedia)
        engine.hangup(slow); try await wait { engine.activeCalls().isEmpty }
        let late = try await connected("*latehold")
        do { try await engine.setHold(late, onHold: true); XCTFail("A late response must time out") }
        catch { guard case SIPEngineError.holdTimedOut = error else { XCTFail("Expected hold timeout: \(error)"); return } }
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: "sip:*97@sipper.test"), "An unresolved negotiation remains fenced after timeout")
        try await wait { engine.activeCalls().first?.isOnHold == true }
        _ = try engine.makeCall(accountID: account.id, uri: "sip:*97@sipper.test")
        engine.hangupAll(); try await wait { engine.activeCalls().isEmpty }
        let silent = try await connected("*silenthold")
        let unresolved = Task { try await engine.setHold(silent, onHold: true) }
        try await Task.sleep(for: .milliseconds(200))
        let endedAt = ContinuousClock.now
        engine.hangup(silent)
        do { try await unresolved.value; XCTFail("Hang-up must fail the pending hold") }
        catch { guard case SIPEngineError.unknownCall = error else { XCTFail("Expected ended-call result: \(error)"); return } }
        XCTAssertLessThan(endedAt.duration(to: .now), .seconds(1), "Hang-up stays responsive during negotiation")
        try await wait { engine.activeCalls().isEmpty }
    }

    func testBothParticipantsCanHoldAndResumeWithoutFalseTimeouts() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else { throw XCTSkip("Requires the isolated direct registrar") }
        let engine = SIPEngine(), observer = DirectPreferenceObserver()
        engine.delegate = observer
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        let a = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        let b = SIPAccount(profileID: UUID(), username: "dnd-peer", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(a, "fictional-dnd"), (b, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: a.id).isRegistered && engine.currentRegistration(accountID: b.id).isRegistered }
        let outgoing = try engine.makeCall(accountID: a.id, uri: "sip:dnd-peer@sipper.test;transport=udp")
        try await wait { !observer.offers.isEmpty }
        let incoming = try XCTUnwrap(observer.offers.first)
        try engine.answer(incoming)
        try await wait { engine.activeCalls().count == 2 && engine.activeCalls().allSatisfy { $0.state == .confirmed && $0.hasActiveMedia } }
        try await engine.setHold(outgoing, onHold: true)
        try await engine.setHold(incoming, onHold: true)
        XCTAssertTrue(engine.activeCalls().allSatisfy(\.isOnHold), "Both local legs retain confirmed hold even when SDP disables all media")
        try await engine.setHold(outgoing, onHold: false)
        XCTAssertFalse(try XCTUnwrap(engine.activeCalls().first { $0.id == outgoing.id }).isOnHold)
        XCTAssertTrue(try XCTUnwrap(engine.activeCalls().first { $0.id == incoming.id }).isOnHold)
        try await engine.setHold(incoming, onHold: false)
        try await wait { engine.activeCalls().allSatisfy { !$0.isOnHold && $0.hasActiveMedia } }
        engine.hangup(outgoing); try await wait { engine.activeCalls().isEmpty }
    }

    func testDirectTransfersPreserveCallsOnFailureAndRejectStaleOrWithdrawnAccess() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else { throw XCTSkip("Requires the isolated direct registrar") }
        let engine = SIPEngine()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        var account = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        account.managed = .init(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(120))
        let other = SIPAccount(profileID: UUID(), username: "dnd-peer", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        engine.syncAccounts([(account, "fictional-dnd"), (other, "fictional-dnd")])
        try await wait { engine.currentRegistration(accountID: account.id).isRegistered && engine.currentRegistration(accountID: other.id).isRegistered }
        func connected(_ account: SIPAccount) async throws -> CallSnapshot {
            let call = try engine.makeCall(accountID: account.id, uri: "sip:*echo@sipper.test;transport=udp")
            try await wait { engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed } }
            return call
        }
        let call = try await connected(account), unrelated = try await connected(other)
        var stale = call; stale.startedAt = call.startedAt.addingTimeInterval(-1)
        XCTAssertThrowsError(try engine.transfer(stale, to: "*97"))
        XCTAssertThrowsError(try engine.attendedTransfer(call, to: call))
        XCTAssertThrowsError(try engine.attendedTransfer(call, to: unrelated))
        for target in ["", "()", "fictional-secret", "sip:100@sipper.test\r\nInjected: value", String(repeating: "1", count: 513)] {
            XCTAssertThrowsError(try engine.transfer(call, to: target))
        }
        try engine.transfer(call, to: "*404")
        XCTAssertTrue(engine.activeCalls().first { $0.id == call.id }?.isTransferring == true)
        XCTAssertThrowsError(try engine.transfer(call, to: "*97"))
        try await wait { engine.activeCalls().contains { $0.id == call.id && !$0.isTransferring && $0.transferStatus?.hasPrefix("Transfer failed") == true } }
        XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed })
        try engine.transfer(call, to: "*97")
        try await wait { !engine.activeCalls().contains { $0.id == call.id && $0.startedAt == call.startedAt } }
        XCTAssertTrue(engine.activeCalls().contains { $0.id == unrelated.id && $0.startedAt == unrelated.startedAt })
        let first = try await connected(account), second = try await connected(account)
        XCTAssertThrowsError(try engine.transfer(call, to: "*97"), "A new call may reuse the old numeric ID")
        try engine.attendedTransfer(first, to: second)
        XCTAssertThrowsError(try engine.transfer(second, to: "*97"), "The consultation leg belongs to the pending transfer")
        try await wait { !engine.activeCalls().contains { $0.accountID == account.id } }
        let withdrawn = try await connected(account)
        engine.syncAccounts([(other, "fictional-dnd")])
        XCTAssertThrowsError(try engine.transfer(withdrawn, to: "*97"))
        XCTAssertThrowsError(try engine.attendedTransfer(withdrawn, to: unrelated))
        XCTAssertTrue(engine.activeCalls().contains { $0.id == withdrawn.id && $0.state == .confirmed })
        engine.hangup(withdrawn); engine.hangup(unrelated)
        try await wait { engine.activeCalls().isEmpty }
    }

    func testNetworkRecoveryPreservesCallsWithoutRevivingWithdrawnRegistration() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else {
            throw XCTSkip("Requires the isolated direct registrar with --answer-special")
        }
        for transport in [SIPTransport.udp, .tcp] {
            let engine = SIPEngine(), observer = DirectPreferenceObserver()
            engine.delegate = observer
            try engine.useNullAudioForTesting()
            var settings = AppSettings(); settings.sipLogLevel = 0
            try engine.start(settings: settings)
            defer { engine.stop() }
            var managed = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: transport)
            managed.managed = .init(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(120))
            let personal = SIPAccount(profileID: UUID(), username: "dnd-peer", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: transport)
            let entries = [(managed, "fictional-dnd"), (personal, "fictional-dnd")]
            engine.syncAccounts(entries)
            try await wait { engine.currentRegistration(accountID: managed.id).isRegistered && engine.currentRegistration(accountID: personal.id).isRegistered }
            let call = try engine.makeCall(accountID: managed.id, uri: "sip:*echo@sipper.test;transport=\(transport.rawValue)")
            try await wait { engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed } }
            engine.networkChanged(available: false)
            XCTAssertFalse(engine.currentRegistration(accountID: managed.id).isRegistered)
            XCTAssertFalse(engine.currentRegistration(accountID: personal.id).isRegistered)
            engine.reRegisterAll()
            XCTAssertFalse(engine.currentRegistration(accountID: personal.id).isRegistered, "Foreground refresh must not expose stale online state")
            try await wait { observer.registrationStates.contains { $0 == .failed(code: 0, reason: "No network connection") } }
            observer.registrationStates.removeAll()
            engine.setRegistration(accountID: personal.id, enabled: true)
            try await wait { !observer.registrationStates.isEmpty }
            XCTAssertTrue(observer.registrationStates.allSatisfy(\.isFailed), "Manual re-registration must remain offline")
            engine.networkChanged(available: true)
            try await wait { engine.currentRegistration(accountID: managed.id).isRegistered && engine.currentRegistration(accountID: personal.id).isRegistered }
            XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed })
            // Keep the dialog but withdraw managed registration, then recover again.
            engine.syncAccounts([(personal, "fictional-dnd")])
            try await wait { !engine.currentRegistration(accountID: managed.id).isRegistered }
            engine.networkChanged(available: true)
            try await wait { engine.currentRegistration(accountID: personal.id).isRegistered }
            XCTAssertFalse(engine.currentRegistration(accountID: managed.id).isRegistered)
            XCTAssertFalse(engine.hasApplied(entries))
            XCTAssertThrowsError(try engine.makeCall(accountID: managed.id, uri: "sip:*echo@sipper.test"))
            let denied = try engine.makeCall(accountID: personal.id, uri: "sip:dnd-user@sipper.test;transport=\(transport.rawValue)")
            try await wait { observer.ended.contains { $0.id == denied.id && $0.startedAt == denied.startedAt } }
            XCTAssertEqual(observer.ended.first { $0.id == denied.id && $0.startedAt == denied.startedAt }?.lastStatusCode, 480, "The actual registrar must not retain or revive the withdrawn binding")
            XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed })
            engine.syncAccounts(entries)
            try await wait { engine.currentRegistration(accountID: managed.id).isRegistered }
            XCTAssertTrue(engine.hasApplied(entries), "Resume must restore the registrar without replacing the established call")
            XCTAssertTrue(engine.activeCalls().contains { $0.id == call.id && $0.state == .confirmed })
            engine.hangup(call)
            try await wait { engine.activeCalls().isEmpty }
            engine.syncAccounts([(personal, "wrong-fixture-password")])
            try await wait { engine.currentRegistration(accountID: personal.id).isFailed }
            engine.networkChanged(available: true)
            try await wait { engine.currentRegistration(accountID: personal.id).isFailed }
        }
    }

    // Opt-in loopback registrar; both SIP users are fictional and run in this test engine.
    func testDirectDndRejectsOnlyNewIncomingCallsAndPreservesRegistration() async throws {
        guard ProcessInfo.processInfo.environment["SIPPER_TEST_DIRECT_DND"] == "127.0.0.1" else {
            throw XCTSkip("Start the isolated direct-DND registrar as documented in tools/sip-test-server.md")
        }
        let engine = SIPEngine(), observer = DirectPreferenceObserver()
        engine.delegate = observer
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        var managed = SIPAccount(profileID: UUID(), username: "dnd-user", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        managed.managed = ManagedAccountBinding(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(120))
        let personal = SIPAccount(profileID: UUID(), username: "dnd-peer", domain: "sipper.test", server: "127.0.0.1", port: 5098, transport: .udp)
        func sync() { engine.syncAccounts([(managed, "fictional-dnd"), (personal, "fictional-dnd")]) }
        sync()
        try await wait { engine.currentRegistration(accountID: managed.id).isRegistered && engine.currentRegistration(accountID: personal.id).isRegistered }
        // Leave one incoming call ringing before the policy changes.
        let original = try engine.makeCall(accountID: personal.id, uri: "sip:dnd-user@sipper.test;transport=udp")
        try await wait { observer.offers.count == 1 }
        let admitted = try XCTUnwrap(observer.offers.first)
        XCTAssertEqual(admitted.accountID, managed.id)
        XCTAssertEqual(ManagedAccountMapper.directCalls(accounts: [managed, personal], calls: engine.activeCalls()).first?.ringing, 1)
        let registrations = observer.registrations
        managed.managed?.doNotDisturb = true; sync()
        XCTAssertTrue(engine.hasApplied([(managed, "fictional-dnd"), (personal, "fictional-dnd")]))
        engine.answer(callID: admitted.id)
        try await wait { engine.activeCalls().filter { $0.state == .confirmed }.count == 2 }
        XCTAssertEqual(ManagedAccountMapper.directCalls(accounts: [managed, personal], calls: engine.activeCalls()).first?.connected, 1)
        let rejected = try engine.makeCall(accountID: personal.id, uri: "sip:dnd-user@sipper.test;transport=udp")
        try await wait { observer.ended.contains { $0.id == rejected.id && $0.startedAt == rejected.startedAt } }
        XCTAssertEqual(observer.ended.first { $0.id == rejected.id && $0.startedAt == rejected.startedAt }?.lastStatusCode, 486)
        XCTAssertEqual(observer.offers.count, 1, "Rejected calls must never reach ringtone or CallKit handling")
        XCTAssertEqual(observer.registrations, registrations, "Changing DND must not re-register")
        XCTAssertEqual(engine.activeCalls().filter { $0.state == .confirmed }.count, 2)
        engine.hangup(callID: original.id)
        try await wait { engine.activeCalls().isEmpty }
        XCTAssertEqual(ManagedAccountMapper.directCalls(accounts: [managed, personal], calls: engine.activeCalls()).first?.connected, 0)
        // Outgoing calling and the personal account's incoming handling stay available.
        let outgoing = try engine.makeCall(accountID: managed.id, uri: "sip:dnd-peer@sipper.test;transport=udp")
        try await wait { observer.offers.count == 2 }
        XCTAssertEqual(observer.offers.last?.accountID, personal.id)
        engine.answer(callID: observer.offers.last!.id)
        try await wait { engine.activeCalls().filter { $0.state == .confirmed }.count == 2 }
        engine.hangup(callID: outgoing.id)
        try await wait { engine.activeCalls().isEmpty }
        managed.managed?.doNotDisturb = false; sync()
        let restored = try engine.makeCall(accountID: personal.id, uri: "sip:dnd-user@sipper.test;transport=udp")
        try await wait { observer.offers.count == 3 }
        engine.hangup(callID: restored.id)
        try await wait { engine.activeCalls().isEmpty }
    }
    func testDirectReportsContainOnlyCountsForManagedDirectAccounts() throws {
        var direct = SIPAccount(profileID: UUID(), username: "direct", domain: "example.invalid")
        direct.managed = .init(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(60))
        var gateway = direct; gateway.id = UUID(); gateway.managed?.mode = .gateway
        let personal = SIPAccount(profileID: UUID(), username: "personal", domain: "example.invalid")
        let ringing = CallSnapshot(id: 1, accountID: direct.id, direction: .incoming, state: .early,
            remoteURI: "sip:private@example.invalid", remoteNumber: "private-number", remoteName: "Private name",
            isMuted: false, isOnHold: false, isRemoteHold: false, hasActiveMedia: false,
            startedAt: Date(), connectedAt: nil, endedAt: nil, lastStatusCode: 180, lastStatusText: "Ringing")
        var outgoing = ringing; outgoing.direction = .outgoing
        var connected = ringing; connected.state = .confirmed; connected.connectedAt = Date()
        var held = connected; held.isOnHold = true
        var remoteHeld = connected; remoteHeld.isRemoteHold = true
        var ended = connected; ended.state = .disconnected
        var personalCall = ringing; personalCall.accountID = personal.id
        var gatewayCall = ringing; gatewayCall.accountID = gateway.id
        let reports = ManagedAccountMapper.directCalls(accounts: [direct, personal, gateway], calls: [ringing, outgoing, connected, held, remoteHeld, ended, personalCall, gatewayCall])
        XCTAssertEqual(reports.count, 1)
        let report = try XCTUnwrap(reports.first)
        XCTAssertEqual(report.accountId, direct.managed?.accountID)
        XCTAssertEqual(report.ringing, 1); XCTAssertEqual(report.dialling, 1)
        XCTAssertEqual(report.connected, 1); XCTAssertEqual(report.held, 2)
        let encoded = String(decoding: try JSONEncoder().encode(ManagedDeviceReport(appliedRevision: String(repeating: "a", count: 64), directCalls: reports)), as: UTF8.self)
        XCTAssertFalse(encoded.contains("private")); XCTAssertFalse(encoded.contains("Private"))
        let idle = ManagedAccountMapper.directCalls(accounts: [direct], calls: [])
        XCTAssertEqual(idle.first?.ringing, 0); XCTAssertEqual(idle.first?.connected, 0)
    }

    private func wait(file: StaticString = #filePath, line: UInt = #line, _ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(6)
        while !predicate(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        guard predicate() else { XCTFail("Timed out waiting for local SIP state", file: file, line: line); throw ManagedDndTestFailure.timeout }
    }
}
private enum ManagedDndTestFailure: Error { case timeout }
@MainActor
private final class DirectPreferenceObserver: @preconcurrency SIPEngineDelegate {
    var offers: [CallSnapshot] = [], ended: [CallSnapshot] = []
    var changed: [CallSnapshot] = []
    var registrations = 0
    var registrationStates: [RegistrationState] = []
    func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState) { registrations += 1; registrationStates.append(state) }
    func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) { offers.append(call) }
    func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot) { ended.append(call) }
    func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) { changed.append(call) }
    func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo) {}
    func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool) {}
    func sipEngineDidStop(_ engine: SIPEngine, error: Error?) {}
}
