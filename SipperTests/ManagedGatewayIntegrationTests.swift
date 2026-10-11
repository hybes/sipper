import XCTest
import Combine
import AppAuth
@testable import SipperManaged
@testable import Sipper

@MainActor
final class ManagedGatewayIntegrationTests: XCTestCase {
    private struct Fixture: Decodable { let origin: URL; let token: String; let certificate: String; let ready: String; let completed: String }
    private struct Timeout: Error { let step: String }
    private func until(_ step: String, _ check: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if try await check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Timeout(step: step)
    }
    private func media(_ engine: SIPEngine, _ call: CallSnapshot) async throws {
        try await until("Bidirectional Opus/SRTP/ICE packets") {
            guard let value = engine.mediaForTesting(call) else { return false }
            return value.codec.lowercased() == "opus" && value.sent >= 5 && value.received >= 5
                && value.transport.contains("SRTP status: Active") && value.transport.contains("state: Negotiation Success")
        }
    }
    func testMacManagedGatewayCallControls() async throws {
        guard let path = ProcessInfo.processInfo.environment["SIPPER_TEST_GATEWAY_FILE"], path.hasPrefix("/"),
              path.contains("sipper-macos-gateway-") else { throw XCTSkip("Run portal/scripts/gateway-smoke.ts with SIPPER_MACOS_GATEWAY=1") }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(fixture.origin.scheme, "http"); XCTAssertEqual(fixture.origin.host, "127.0.0.1")
        let client = try ManagedClient(serverURL: fixture.origin, clientID: "sipper-macos", storage: MacGatewayStore(), allowLocalDevelopment: true)
        let service = OIDServiceConfiguration(authorizationEndpoint: fixture.origin.appendingPathComponent("api/auth/oauth2/authorize"), tokenEndpoint: fixture.origin.appendingPathComponent("api/auth/oauth2/token"))
        let request = OIDTokenRequest(configuration: service, grantType: OIDGrantTypeAuthorizationCode, authorizationCode: "fixture", redirectURL: client.redirectURL, clientID: "sipper-macos", clientSecret: nil, scopes: ["sipper:client"], refreshToken: nil, codeVerifier: "fixture", additionalParameters: nil)
        let token = OIDTokenResponse(request: request, parameters: ["access_token": fixture.token as NSString, "token_type": "Bearer" as NSString, "expires_in": 3600 as NSNumber])
        try await client.acceptAuthentication(OIDAuthState(authorizationResponse: nil, tokenResponse: token, registrationResponse: nil))
        let enrollment = try await client.enrol(organisation: XCTUnwrap(client.organisations.first), name: "Isolated Mac", appVersion: "test", osVersion: "test")
        let config = try await client.configuration(for: enrollment)
        let value = try XCTUnwrap(config.accounts.first)
        let account = ManagedAccountMapper.account(value, configuration: config, profileID: enrollment.localProfileID)
        XCTAssertEqual(account.managed?.mode, .gateway); XCTAssertEqual(account.server, "localhost")
        var settings = AppSettings()
        settings.sipLogLevel = 4; settings.localUDPPort = 0; settings.localTCPPort = 0; settings.localTLSPort = 0
        settings.ringtone = .silent; settings.showNotifications = false; settings.showIncomingCallAlert = false
        do {
            let untrusted = SIPEngine()
            try untrusted.useNullAudioForTesting()
            try untrusted.start(settings: settings)
            defer { untrusted.stop() }
            untrusted.syncAccounts([(account, value.password)])
            try await until("Unknown gateway CA rejected") {
                if case .failed = untrusted.currentRegistration(accountID: account.id) { return true }
                return false
            }
            XCTAssertFalse(untrusted.currentRegistration(accountID: account.id).isRegistered)
        }
        let directory = TestSupport.makeTemporaryDirectory(for: self)
        let ca = directory.appendingPathComponent("test-ca.der")
        let der = fixture.certificate.components(separatedBy: .newlines).filter { !$0.hasPrefix("---") }.joined()
        try XCTUnwrap(Data(base64Encoded: der)).write(to: ca)
        let engine = SIPEngine()
        engine.trustTestCertificate(ca.path)
        try engine.useNullAudioForTesting() // Set before startup: never select physical audio.
        let state = AppState(store: PersistenceStore(directory: directory), passwords: InMemoryPasswordStore(), engine: engine, startEngine: false)
        state.settings = settings
        state.requestMicrophone = { true }
        state.configureManagedCalls(client: client)
        state.startEngineIfNeeded()
        defer { state.shutdown() }
        XCTAssertTrue(state.engineIsRunning)
        let report = try await state.applyManagedConfigurationAndReport(config, profileID: enrollment.localProfileID)
        XCTAssertEqual(report.appliedRevision, config.revision)
        try await client.report(report, for: enrollment)
        try await until("Native Mac TLS/SHA-256 registration") { engine.currentRegistration(accountID: account.id).isRegistered }
        state.call("2000", from: account.id)
        try await until("Mac outgoing call confirmed") {
            if let alert = state.alert { throw Timeout(step: alert.message) }
            return state.calls.contains { $0.direction == .outgoing && $0.connectedAt != nil }
        }
        let outgoing = try XCTUnwrap(state.calls.first)
        try await media(engine, outgoing)
        // A later offline event cancels a queued recovery, including after wake.
        state.networkChanged(available: true)
        state.networkChanged(available: false)
        state.reRegisterAll()
        try await Task.sleep(for: .milliseconds(650))
        XCTAssertFalse(engine.currentRegistration(accountID: account.id).isRegistered)
        XCTAssertFalse(state.registration(for: account.id).isRegistered)
        func recoverCall(registered: Bool) async throws {
            engine.log.clear()
            state.networkChanged(available: false)
            state.networkChanged(available: true)
            if registered {
                try await until("Mac registration recovers") { engine.currentRegistration(accountID: account.id).isRegistered }
            }
            // Require the new offer, rather than accepting the previous stream.
            try await until("Mac network-change SDP negotiation") {
                let lines = engine.log.snapshot().flatMap { $0.components(separatedBy: .newlines) }
                guard let offer = lines.firstIndex(where: { $0.contains("send re-INVITE") && $0.contains("triggered by IP change") }) else { return false }
                return lines.dropFirst(offer + 1).contains { $0.contains("SDP negotiation done: Success") }
            }
            try await media(engine, outgoing)
            let before = try XCTUnwrap(engine.mediaForTesting(outgoing))
            try await until("Mac encrypted media advances after recovery") {
                guard let value = engine.mediaForTesting(outgoing) else { return false }
                return value.sent > before.sent + 5 && value.received > before.received + 5
            }
            XCTAssertEqual(engine.currentRegistration(accountID: account.id).isRegistered, registered)
            XCTAssertEqual(state.registration(for: account.id).isRegistered, registered)
            XCTAssertTrue(state.calls.contains { $0.id == outgoing.id && $0.connectedAt != nil })
            if !registered {
                let requests = engine.log.snapshot().filter { $0.contains("TX ") && $0.contains("Request msg REGISTER") }
                // An in-flight unregistration may retry after a digest challenge.
                // It must never create a new positive-lifetime binding.
                for request in requests {
                    let expires = request.components(separatedBy: .newlines).first { $0.hasPrefix("Expires:") }
                    XCTAssertEqual(expires?.trimmingCharacters(in: .whitespacesAndNewlines), "Expires: 0")
                }
                print("Withdrawn Mac recovery: \(requests.count) outgoing REGISTER messages, all must have zero expiry")
            }
        }
        for _ in 0..<3 { try await recoverCall(registered: true) }
        state.removeManagedAccounts(deviceID: enrollment.deviceID, profileID: enrollment.localProfileID)
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: account.callURI(for: "2000")))
        XCTAssertThrowsError(try engine.transfer(outgoing, to: "2001"))
        try await recoverCall(registered: false)
        state.hangup(callID: outgoing.id)
        try await until("Outgoing ended") { state.calls.isEmpty && engine.activeCalls().isEmpty }
        _ = try await state.applyManagedConfigurationAndReport(config, profileID: enrollment.localProfileID)
        try await until("Managed registration restored") { engine.currentRegistration(accountID: account.id).isRegistered }
        try await checkGatewayTransfers(engine, account: account, ready: fixture.ready, completed: fixture.completed)

        func phase(_ value: String) throws { try value.write(toFile: fixture.ready, atomically: true, encoding: .utf8) }
        func incoming(_ name: String) async throws -> CallSnapshot {
            state.alert = nil
            try phase(name)
            try await until("Authenticated Mac incoming caller: \(name)") { state.calls.contains { $0.isRinging && $0.remoteName == "Fixture caller" } }
            let call = try XCTUnwrap(state.calls.first { $0.isRinging })
            XCTAssertEqual(call.remoteNumber, "2000"); XCTAssertEqual(call.remoteURI, "")
            XCTAssertEqual(call.managedAccount?.accountID, value.id); XCTAssertNotNil(call.gatewayCallID)
            XCTAssertEqual(state.history.first?.remoteName, "Fixture caller")
            return call
        }
        func ended(_ call: CallSnapshot) async throws {
            try await until("Native call dismissed") { state.calls.isEmpty && engine.activeCalls().isEmpty }
            XCTAssertEqual(state.history.first?.accountID, account.id)
            XCTAssertEqual(state.history.first?.isManaged, true)
        }
        let answered = try await incoming("answer")
        var queued = answered
        queued.remoteName = ""; queued.remoteNumber = "Incoming managed call"; queued.remoteURI = ""
        queued.lastStatusText = "Queued fixture update"
        var replayed: CallSnapshot?
        let observation = state.$calls.sink { calls in
            if let call = calls.first(where: { $0.lastStatusText == queued.lastStatusText }) { replayed = call }
        }
        state.sipEngine(engine, callDidChange: queued)
        try await until("Queued native update applied") { replayed != nil }
        observation.cancel()
        XCTAssertEqual(replayed?.remoteName, "Fixture caller")
        XCTAssertEqual(replayed?.remoteNumber, "2000")
        state.answer(callID: answered.id)
        state.answer(callID: answered.id) // Duplicate click cannot replace the pending answer.
        try await until("Mac answer confirmed") {
            if let alert = state.alert { throw Timeout(step: alert.message) }
            return state.calls.contains { $0.id == answered.id && $0.connectedAt != nil }
        }
        try await media(engine, answered)
        let accepted = try await client.call(XCTUnwrap(answered.gatewayCallID), for: enrollment)
        XCTAssertTrue(accepted.claimedByThisDevice); XCTAssertEqual(accepted.state, .answered)
        state.hangup(callID: answered.id)
        try await ended(answered)

        let cancelled = try await incoming("cancel")
        var permission: CheckedContinuation<Bool, Never>?
        state.requestMicrophone = { await withCheckedContinuation { permission = $0 } }
        state.answer(callID: cancelled.id)
        try await until("Permission request waiting") { permission != nil }
        try phase("cancel-ringing")
        try await ended(cancelled)
        permission?.resume(returning: true)
        await Task.yield()
        XCTAssertNil(state.alert, "A late permission grant cannot answer a cancelled call")
        state.requestMicrophone = { true }

        let declined = try await incoming("decline")
        state.decline(callID: declined.id)
        try await ended(declined)
        XCTAssertEqual(state.history.first?.outcome, .declined)
        try phase("decline-finished")
        try await until("Declined parent ended") { try await client.call(XCTUnwrap(declined.gatewayCallID), for: enrollment).state == .ended }

        let lost = try await incoming("other-device")
        try phase("other-device-ringing")
        try await ended(lost)
        let winner = try await client.call(XCTUnwrap(lost.gatewayCallID), for: enrollment)
        XCTAssertFalse(winner.claimedByThisDevice); XCTAssertTrue(winner.isUnavailable())

        let failed = try await incoming("answer-failed")
        state.requestMicrophone = { false }
        state.answer(callID: failed.id)
        try await ended(failed)
        XCTAssertEqual(state.alert?.title, "Could not answer call")
        try phase("answer-failed-finished")
        try await until("Failed parent ended") { try await client.call(XCTUnwrap(failed.gatewayCallID), for: enrollment).state == .ended }
    }
}

private final class MacGatewayStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ value: Data, key: String) throws { values[key] = value }
    func remove(_ key: String) throws { values[key] = nil }
}
