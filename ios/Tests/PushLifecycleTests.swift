import XCTest
import CallKit
import AVFoundation
@testable import SipperManaged
@testable import SipperIOS

@MainActor
final class PushLifecycleTests: XCTestCase {
    func testMeetingAudioOwnerBlocksPhonePermissionAndSystemAudioActivation() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter)
        let provider = CXProvider(configuration: CXProviderConfiguration())
        var permissions = 0, errors: [String] = []
        bridge.canUsePhoneAudio = { false }
        bridge.canUseAccount = { _ in true }
        bridge.requestMicrophone = { permissions += 1; return true }
        bridge.onError = { errors.append($0) }
        let account = SIPAccount(profileID: UUID(), label: "Fixture", username: "fixture", domain: "pbx.example.invalid")
        do { try await bridge.start(account: account, target: "123"); XCTFail("Meeting owns audio") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Leave your meeting")) }
        let action = RecordingAnswerAction(call: UUID())
        bridge.provider(provider, perform: action)
        XCTAssertEqual(action.succeeded, false); XCTAssertEqual(permissions, 0)
        XCTAssertEqual(errors, ["Leave your meeting before answering this phone call."])
        bridge.provider(provider, didActivate: AVAudioSession.sharedInstance())
        XCTAssertFalse(bridge.audioActive); XCTAssertFalse(bridge.hasPhoneAudioWork)
    }
    func testAudioControlsStayInactiveWhenTheEngineCannotStartAudio() {
        let bridge = CallKitBridge(engine: SIPEngine(), reporter: RecordingCalls())
        let provider = CXProvider(configuration: CXProviderConfiguration())
        var failures: [String] = []
        bridge.onError = { failures.append($0) }
        XCTAssertFalse(bridge.audioActive)
        // An unstarted engine refuses activation without opening the microphone.
        bridge.provider(provider, didActivate: AVAudioSession.sharedInstance())
        XCTAssertEqual(failures, ["Call audio could not start."])
        XCTAssertFalse(bridge.audioActive)
        bridge.provider(provider, didDeactivate: AVAudioSession.sharedInstance())
        bridge.providerDidReset(provider)
        XCTAssertFalse(bridge.audioActive)
    }
    private func hint() throws -> IncomingManagedCall {
        try XCTUnwrap(IncomingManagedCall.parse(apns: ["sipper": ["schemaVersion": 1, "deviceId": UUID().uuidString,
            "callId": UUID().uuidString, "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(60))]]))
    }
    private func until(_ check: () -> Bool) async throws {
        for _ in 0..<100 { if check() { return }; try await Task.sleep(for: .milliseconds(10)) }
        throw NSError(domain: "PushLifecycleTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Lifecycle transition did not finish"])
    }
    func testPushReportsSynchronouslyAndDuplicateDoesNotStartAnotherWake() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter), hint = try hint()
        var wakeCount = 0, completions = 0, declined = 0
        var finish: CheckedContinuation<CallSnapshot?, Never>?
        bridge.wake = { _ in wakeCount += 1; return await withCheckedContinuation { finish = $0 } }
        bridge.onPushDeclined = { _ in declined += 1 }
        bridge.incomingPush(hint) { completions += 1 }
        XCTAssertEqual(reporter.incoming.count, 1, "Report must happen before returning to PushKit")
        XCTAssertEqual(wakeCount, 0, "Network work must not precede the CallKit report")
        let uuid = reporter.incoming[0]
        reporter.complete(0)
        try await until { wakeCount == 1 && completions == 1 }
        bridge.incomingPush(hint) { completions += 1 }
        XCTAssertEqual(reporter.incoming, [uuid, uuid])
        reporter.complete(1, error: NSError(domain: CXErrorDomainIncomingCall, code: CXErrorCodeIncomingCallError.callUUIDAlreadyExists.rawValue))
        try await until { completions == 2 }
        XCTAssertEqual(wakeCount, 1); XCTAssertTrue(reporter.ended.isEmpty)
        bridge.withdrawPushCalls(deviceID: hint.deviceId)
        XCTAssertEqual(reporter.ended, [uuid]); XCTAssertEqual(declined, 1)
        finish?.resume(returning: nil)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(reporter.ended, [uuid], "A late wake result cannot end or re-create another call")
        bridge.incomingPush(hint) { completions += 1 }
        reporter.complete(2)
        try await until { completions == 3 }
        XCTAssertEqual(wakeCount, 1, "An ended call cannot be woken by a repeated push")
    }
    func testMalformedAndRejectedPushCompleteWithoutLeakingAPendingCall() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter)
        var completions = 0
        bridge.incomingPush(nil) { completions += 1 }
        XCTAssertEqual(reporter.incoming.count, 1)
        reporter.complete(0)
        try await until { completions == 1 }
        XCTAssertEqual(reporter.ended, reporter.incoming)
        let hint = try hint()
        var declined = false
        bridge.onPushDeclined = { _ in declined = true }
        bridge.wake = { _ in try await Task.sleep(for: .seconds(10)); return nil }
        bridge.incomingPush(hint) { completions += 1 }
        reporter.complete(1, error: NSError(domain: CXErrorDomainIncomingCall, code: CXErrorCodeIncomingCallError.filteredByDoNotDisturb.rawValue))
        try await until { completions == 2 && declined }
        XCTAssertEqual(reporter.ended.count, 1, "A rejected CallKit report was never a visible call")
    }
    func testAnswerBeforeSIPCanBeEndedAndCannotAcceptALateOffer() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter), hint = try hint()
        var finish: CheckedContinuation<CallSnapshot?, Never>?
        bridge.wake = { _ in await withCheckedContinuation { finish = $0 } }
        bridge.requestMicrophone = { true }
        bridge.onError = { _ in XCTFail("Ending a pending answer is not an app error") }
        bridge.incomingPush(hint) {}
        reporter.complete(0)
        try await until { finish != nil }
        let provider = CXProvider(configuration: CXProviderConfiguration()), uuid = reporter.incoming[0]
        let answer = RecordingAnswerAction(call: uuid)
        bridge.provider(provider, perform: answer)
        await Task.yield()
        XCTAssertNil(answer.succeeded)
        let duplicate = RecordingAnswerAction(call: uuid)
        bridge.provider(provider, perform: duplicate)
        XCTAssertEqual(duplicate.succeeded, false)
        XCTAssertNil(answer.succeeded, "A repeated answer must not cancel the first answer")
        let end = RecordingEndAction(call: uuid)
        bridge.provider(provider, perform: end)
        XCTAssertEqual(end.succeeded, true)
        finish?.resume(returning: nil)
        try await until { answer.succeeded != nil }
        XCTAssertEqual(answer.succeeded, false)
        XCTAssertEqual(reporter.incoming.count, 1)
        XCTAssertTrue(reporter.updated.isEmpty)
        XCTAssertTrue(reporter.ended.isEmpty, "A local end is already handled by CallKit")
    }
    func testOptionalForegroundPushStillWakesANewCallButIgnoresInvalidAndDuplicateHints() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter), hint = try hint()
        var completed = 0, wakes = 0
        bridge.wake = { _ in wakes += 1; try await Task.sleep(for: .seconds(10)); return nil }
        bridge.incomingPush(nil, mustReport: false) { completed += 1 }
        XCTAssertEqual(completed, 1); XCTAssertTrue(reporter.incoming.isEmpty)
        bridge.incomingPush(hint, mustReport: false) { completed += 1 }
        XCTAssertEqual(reporter.incoming.count, 1)
        reporter.complete(0)
        try await until { wakes == 1 && completed == 2 }
        bridge.incomingPush(hint, mustReport: false) { completed += 1 }
        XCTAssertEqual(completed, 3); XCTAssertEqual(reporter.incoming.count, 1)
        bridge.withdrawPushCalls(deviceID: hint.deviceId)
        bridge.incomingPush(hint, mustReport: false) { completed += 1 }
        XCTAssertEqual(completed, 4); XCTAssertEqual(wakes, 1)
        XCTAssertEqual(reporter.ended, reporter.incoming)
    }
    func testMicrophoneDenialEndsThePlaceholderAndSurfacesTheFailure() async throws {
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: SIPEngine(), reporter: reporter)
        bridge.wake = { _ in try await Task.sleep(for: .seconds(10)); return nil }
        bridge.requestMicrophone = { false }
        var completed = false, declined = 0, errors = 0
        bridge.onPushDeclined = { _ in declined += 1 }
        bridge.onError = { _ in errors += 1 }
        bridge.incomingPush(try hint()) { completed = true }
        reporter.complete(0)
        try await until { completed }
        let answer = RecordingAnswerAction(call: reporter.incoming[0])
        bridge.provider(CXProvider(configuration: CXProviderConfiguration()), perform: answer)
        try await until { answer.succeeded != nil }
        XCTAssertEqual(answer.succeeded, false)
        XCTAssertEqual(reporter.ended, reporter.incoming)
        XCTAssertEqual(declined, 1); XCTAssertEqual(errors, 1)
    }
    func testTokenRotationIsSerialAndOneDeniedCustomerDoesNotBlockTheOthers() async throws {
        func entry() -> ManagedEnrollment { .init(organisationID: UUID(), organisationName: "Fixture", deviceID: UUID(), installationID: UUID(), userID: "fixture", localProfileID: UUID()) }
        let a = entry(), b = entry(), old = Data(repeating: 1, count: 32), new = Data(repeating: 2, count: 32)
        var entries = [a, b], writes: [(UUID, Data?)] = []
        var release: CheckedContinuation<Void, Never>?
        var denyA = false
        let tokens = MobilePushTokens(enrollments: { entries }, write: { token, entry in
            writes.append((entry.deviceID, token))
            if writes.count == 1 { await withCheckedContinuation { release = $0 } }
            if entry.deviceID == a.deviceID && denyA { throw ManagedError.callUnavailable }
        })
        tokens.update(eligible: Set([a.deviceID, b.deviceID]))
        await Task.yield()
        XCTAssertTrue(writes.isEmpty, "An unknown token is not an invalidation")
        tokens.update(token: old)
        try await until { release != nil }
        tokens.update(token: new)
        XCTAssertEqual(writes.count, 1)
        release?.resume()
        try await until { writes.count == 3 }
        XCTAssertEqual(writes.last(where: { $0.0 == a.deviceID })?.1, new)
        XCTAssertEqual(writes.last(where: { $0.0 == b.deviceID })?.1, new)
        denyA = true
        tokens.update(token: nil)
        try await until { writes.count == 5 }
        XCTAssertNil(writes.last(where: { $0.0 == b.deviceID })?.1)
        denyA = false
        tokens.synchronise()
        try await until { writes.count == 6 }
        XCTAssertEqual(writes.last?.0, a.deviceID); XCTAssertNil(writes.last?.1)
        entries = []; tokens.synchronise()
        await Task.yield()
        XCTAssertEqual(writes.count, 6)
    }
}

// A standalone CXAction has no system transaction to update isComplete. Record
// the documented completion callbacks while exercising the real delegate method.
final class RecordingAnswerAction: CXAnswerCallAction {
    var succeeded: Bool?
    override func fulfill() { succeeded = true }
    override func fail() { succeeded = false }
}
final class RecordingEndAction: CXEndCallAction {
    var succeeded: Bool?
    override func fulfill() { succeeded = true }
    override func fail() { succeeded = false }
}
final class RecordingHoldAction: CXSetHeldCallAction {
    var succeeded: Bool?
    var completions = 0
    override func fulfill() { completions += 1; succeeded = true }
    override func fail() { completions += 1; succeeded = false }
}
final class RecordingGroupAction: CXSetGroupCallAction {
    var succeeded: Bool?
    var completions = 0
    override func fulfill() { completions += 1; succeeded = true }
    override func fail() { completions += 1; succeeded = false }
}

@MainActor
final class RecordingCalls: MobileCallReporting {
    var incoming: [UUID] = [], ended: [UUID] = [], updated: [UUID] = []
    var updates: [UUID: CXCallUpdate] = [:]
    private var completions: [@Sendable (Error?) -> Void] = []
    func complete(_ index: Int, error: Error? = nil) { completions[index](error) }
    func setDelegate(_ delegate: CXProviderDelegate?, queue: DispatchQueue?) {}
    func reportNewIncomingCall(with uuid: UUID, update: CXCallUpdate, completion: @escaping @Sendable (Error?) -> Void) { incoming.append(uuid); updates[uuid] = update; completions.append(completion) }
    func reportCall(with uuid: UUID, updated update: CXCallUpdate) { updated.append(uuid); updates[uuid] = update }
    func reportCall(with uuid: UUID, endedAt dateEnded: Date?, reason endedReason: CXCallEndedReason) { ended.append(uuid) }
    func reportOutgoingCall(with uuid: UUID, startedConnectingAt dateStartedConnecting: Date?) {}
    func reportOutgoingCall(with uuid: UUID, connectedAt dateConnected: Date?) {}
}
