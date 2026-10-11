import XCTest
import AppAuth
import CallKit
import Security
@testable import SipperManaged
@testable import SipperIOS

@MainActor
final class GatewayIntegrationTests: XCTestCase {
    private struct Fixture: Decodable { let origin: URL; let token: String; let certificate: String; let ready: String; let push: String; let completed: String }
    private struct Timeout: Error { let step: String }
    private func until(_ step: String, timeout: TimeInterval = 15, _ check: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try await check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw Timeout(step: step)
    }
    private func media(_ engine: SIPEngine, _ call: CallSnapshot) async throws {
        do {
            try await until("Bidirectional SRTP/ICE packets") {
                guard let value = engine.mediaForTesting(call) else { return false }
                return value.codec.lowercased() == "opus" && value.sent >= 5 && value.received >= 5
                    && value.transport.contains("SRTP status: Active") && value.transport.contains("state: Negotiation Success")
            }
        } catch {
            print("Media observation: \(String(describing: engine.mediaForTesting(call)))")
            throw error
        }
    }
    func testRealGatewayRegistrationAndCalls() async throws {
        guard let path = ProcessInfo.processInfo.environment["SIPPER_TEST_GATEWAY_FILE"], path.hasPrefix("/"),
              path.contains("sipper-ios-gateway-") else { throw XCTSkip("Run portal/scripts/gateway-smoke.ts with SIPPER_IOS_GATEWAY=1") }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(fixture.origin.scheme, "http"); XCTAssertEqual(fixture.origin.host, "127.0.0.1")
        let client = try ManagedClient(serverURL: fixture.origin, clientID: "sipper-ios", storage: GatewayStore(), allowLocalDevelopment: true)
        let service = OIDServiceConfiguration(authorizationEndpoint: fixture.origin.appendingPathComponent("api/auth/oauth2/authorize"), tokenEndpoint: fixture.origin.appendingPathComponent("api/auth/oauth2/token"))
        let request = OIDTokenRequest(configuration: service, grantType: OIDGrantTypeAuthorizationCode, authorizationCode: "fixture", redirectURL: URL(string: "com.hybes.sipper:/oauth/callback"), clientID: "sipper-ios", clientSecret: nil, scopes: ["sipper:client"], refreshToken: nil, codeVerifier: "fixture", additionalParameters: nil)
        let token = OIDTokenResponse(request: request, parameters: ["access_token": fixture.token as NSString, "token_type": "Bearer" as NSString, "expires_in": 3600 as NSNumber])
        try await client.acceptAuthentication(OIDAuthState(authorizationResponse: nil, tokenResponse: token, registrationResponse: nil))
        let enrollment = try await client.enrol(organisation: XCTUnwrap(client.organisations.first), name: "Isolated iOS", appVersion: "test", osVersion: "test")
        let config = try await client.configuration(for: enrollment)
        let value = try XCTUnwrap(config.accounts.first)
        let account = ManagedAccountMapper.account(value, configuration: config, profileID: enrollment.localProfileID)
        XCTAssertEqual(account.managed?.mode, .gateway)
        XCTAssertEqual(account.server, "localhost")
        var settings = AppSettings(); settings.sipLogLevel = 4
        do {
            let observer = GatewayObserver()
            let untrusted = SIPEngine(); untrusted.delegate = observer
            try untrusted.start(settings: settings)
            defer { untrusted.stop() }
            untrusted.syncAccounts([(account, value.password)])
            try await until("Untrusted TLS certificate rejected") { observer.failed }
            XCTAssertFalse(observer.registered)
        }
        let der = fixture.certificate.components(separatedBy: .newlines).filter { !$0.hasPrefix("---") }.joined()
        let ca = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("test-ca.der")
        let certificateData = try XCTUnwrap(Data(base64Encoded: der))
        try certificateData.write(to: ca)
        defer { try? FileManager.default.removeItem(at: ca) }
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, certificateData as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "localhost" as CFString), &trust), errSecSuccess)
        let evaluation = try XCTUnwrap(trust)
        XCTAssertEqual(SecTrustSetAnchorCertificates(evaluation, [certificate] as CFArray), errSecSuccess)
        XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(evaluation, true), errSecSuccess)
        SecTrustSetNetworkFetchAllowed(evaluation, false)
        var certificateError: CFError?
        guard SecTrustEvaluateWithError(evaluation, &certificateError) else { throw Timeout(step: "Fixture certificate: \(String(describing: certificateError))") }
        let engine = SIPEngine(), observer = GatewayObserver(); engine.delegate = observer
        engine.trustTestCertificate(ca.path)
        try engine.useNullAudioForTesting() // Select the virtual clock before startup; never open the microphone.
        try engine.start(settings: settings)
        defer { engine.stop() }
        engine.syncAccounts([(account, value.password)])
        try await until("Trusted TLS/SHA-256 registration") { observer.registered || observer.failed }
        guard observer.registered else { throw Timeout(step: "Trusted registration: \(observer.failure)") }
        XCTAssertTrue(engine.hasApplied([(account, value.password)]))
        let outgoing = try engine.makeCall(accountID: account.id, uri: account.callURI(for: "2000"))
        try await until("Outgoing call connected") { engine.activeCalls().contains { $0.id == outgoing.id && $0.connectedAt != nil } }
        try await media(engine, outgoing)
        func recoverCall(registered: Bool) async throws {
            engine.log.clear()
            engine.networkChanged(available: false)
            XCTAssertFalse(engine.currentRegistration(accountID: account.id).isRegistered)
            engine.networkChanged(available: true)
            if registered {
                try await until("TLS registration restored after network recovery") { engine.currentRegistration(accountID: account.id).isRegistered }
            }
            // Registration can finish before the new media offer. Do not accept the old stream.
            try await until("IP-change media negotiation completes") {
                let lines = engine.log.snapshot().flatMap { $0.components(separatedBy: .newlines) }
                guard let offer = lines.firstIndex(where: { $0.contains("send re-INVITE") && $0.contains("triggered by IP change") }) else { return false }
                return lines.dropFirst(offer + 1).contains { $0.contains("SDP negotiation done: Success") }
            }
            try await media(engine, outgoing)
            let afterRecovery = try XCTUnwrap(engine.mediaForTesting(outgoing))
            try await until("Encrypted media advances after network recovery") {
                guard let current = engine.mediaForTesting(outgoing) else { return false }
                return current.sent > afterRecovery.sent + 5 && current.received > afterRecovery.received + 5
            }
            XCTAssertEqual(engine.currentRegistration(accountID: account.id).isRegistered, registered)
            XCTAssertTrue(engine.activeCalls().contains { $0.id == outgoing.id && $0.connectedAt != nil })
            if !registered {
                XCTAssertFalse(engine.log.snapshot().contains { $0.contains("Request msg REGISTER") }, "Recovery must not re-register the withdrawn account")
            }
        }
        for _ in 0..<3 { try await recoverCall(registered: true) }
        var expiring = account
        expiring.managed = ManagedAccountBinding(organisationID: enrollment.organisationID, deviceID: enrollment.deviceID,
            accountID: value.id, expiresAt: Date().addingTimeInterval(1), mode: .gateway)
        engine.syncAccounts([(expiring, value.password)])
        try await until("Managed lease unregisters") { !engine.currentRegistration(accountID: account.id).isRegistered }
        XCTAssertFalse(engine.hasApplied([(expiring, value.password)]))
        XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: account.callURI(for: "2000")))
        XCTAssertThrowsError(try engine.transfer(outgoing, to: "2001"))
        try await recoverCall(registered: false)
        engine.hangup(outgoing)
        try await until("Outgoing call ended") { engine.activeCalls().isEmpty }
        engine.syncAccounts([(account, value.password)])
        try await until("Registration restored") { engine.currentRegistration(accountID: account.id).isRegistered }
        try await checkGatewayTransfers(engine, account: account, ready: fixture.ready, completed: fixture.completed)

        let controls = ManagedCallControl(engine: engine, client: client)
        func phase(_ value: String) throws { try value.write(toFile: fixture.ready, atomically: true, encoding: .utf8) }
        // Only the provider delivery and CallKit UI are recorded. Registration, wake,
        // caller lookup, answer reservation, SIP acceptance and media use the real path.
        engine.syncAccounts([])
        XCTAssertFalse(engine.hasApplied([(account, value.password)]))
        try phase("push-wake")
        try await until("Opaque push payload available") { FileManager.default.fileExists(atPath: fixture.push) }
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: fixture.push))) as? [AnyHashable: Any])
        let hint = try XCTUnwrap(IncomingManagedCall.parse(apns: payload))
        let reporter = RecordingCalls(), bridge = CallKitBridge(engine: engine, reporter: reporter)
        bridge.canUseAccount = { $0 == account.id && engine.currentRegistration(accountID: $0).isRegistered }
        bridge.requestMicrophone = { true } // Null audio remains selected; do not prompt or open a microphone.
        bridge.claimAnswer = { try await controls.claim($0) }
        bridge.onDeclined = { call in Task { await controls.decline(call) } }
        bridge.onPushDeclined = { hint in Task { await controls.decline(hint) } }
        var wakeCount = 0, wakeError: Error?
        bridge.wake = { hint in
            wakeCount += 1
            do {
                return try await controls.wake(hint) { entry in
                    XCTAssertEqual(entry, enrollment)
                    let fresh = try await client.configuration(for: entry)
                    engine.syncAccounts(fresh.accounts.map { (ManagedAccountMapper.account($0, configuration: fresh, profileID: entry.localProfileID), $0.password) })
                }
            } catch { wakeError = error; throw error }
        }
        var pushCompleted = false
        bridge.incomingPush(hint) { pushCompleted = true }
        XCTAssertEqual(reporter.incoming.count, 1)
        XCTAssertEqual(wakeCount, 0)
        let callUUID = try XCTUnwrap(reporter.incoming.first)
        XCTAssertEqual(reporter.updates[callUUID]?.remoteHandle?.value, "Incoming managed call")
        reporter.complete(0)
        try await until("Push restores registration and binds SIP offer") {
            if let wakeError { throw wakeError }
            return pushCompleted && !reporter.updated.isEmpty
        }
        XCTAssertEqual(reporter.incoming, [callUUID], "The SIP offer must update the original CallKit placeholder")
        XCTAssertEqual(reporter.updated, [callUUID])
        XCTAssertEqual(reporter.updates[callUUID]?.localizedCallerName, "Fixture caller")
        XCTAssertEqual(reporter.updates[callUUID]?.remoteHandle?.value, "2000")
        let woken = try XCTUnwrap(engine.activeCalls().first { $0.gatewayCallID == hint.callId })
        XCTAssertEqual(woken.accountID, account.id)
        XCTAssertTrue(engine.currentRegistration(accountID: account.id).isRegistered)
        let systemProvider = CXProvider(configuration: CXProviderConfiguration())
        let answer = RecordingAnswerAction(call: callUUID)
        bridge.provider(systemProvider, perform: answer)
        try await until("CallKit answer accepts the restored SIP offer") { answer.succeeded == true && engine.activeCalls().contains { $0.id == woken.id && $0.connectedAt != nil } }
        try phase("push-answer")
        try await media(engine, woken)
        let accepted = try await client.call(hint.callId, for: enrollment)
        XCTAssertTrue(accepted.claimedByThisDevice); XCTAssertEqual(accepted.state, .answered)
        bridge.withdrawPushCalls(deviceID: enrollment.deviceID)
        XCTAssertTrue(reporter.ended.isEmpty, "Withdrawal must preserve an established call")
        let end = RecordingEndAction(call: callUUID)
        bridge.provider(systemProvider, perform: end)
        XCTAssertEqual(end.succeeded, true)
        try await until("Woken call ended") {
            guard engine.activeCalls().isEmpty else { return false }
            return try await client.call(hint.callId, for: enrollment).state == .ended
        }
        let replay = try await controls.wake(hint) { _ in XCTFail("An ended hint must not restore registration") }
        XCTAssertNil(replay)

        func incoming(_ name: String) async throws -> CallSnapshot {
            observer.incoming = nil
            try phase(name)
            try await until("Incoming \(name) offer") { observer.incoming != nil }
            let call = try XCTUnwrap(observer.incoming)
            XCTAssertNotNil(call.gatewayCallID)
            XCTAssertEqual(call.remoteNumber, "Incoming managed call")
            XCTAssertTrue(call.remoteName.isEmpty)
            let prepared = try await controls.prepare(call)
            XCTAssertEqual(prepared.remoteName, "Fixture caller")
            XCTAssertEqual(prepared.remoteNumber, "2000")
            XCTAssertEqual(prepared.managedAccount?.accountID, value.id)
            return prepared
        }
        let answered = try await incoming("answer")
        let claim = try await controls.claim(answered)
        XCTAssertEqual(claim, answered.gatewayCallID)
        try engine.answer(answered, claimedGatewayCallID: claim)
        try await until("Incoming answer connected") { engine.activeCalls().contains { $0.id == answered.id && $0.connectedAt != nil } }
        try await media(engine, answered)
        let state = try await client.call(XCTUnwrap(answered.gatewayCallID), for: enrollment)
        XCTAssertTrue(state.claimedByThisDevice); XCTAssertEqual(state.state, .answered)
        engine.hangup(answered)
        try await until("Answered call ended") { engine.activeCalls().isEmpty }

        let cancelled = try await incoming("cancel")
        let cancellationMonitor = Task { await controls.monitor(cancelled) }
        try phase("cancel-ringing")
        try await until("Caller cancellation") { engine.activeCalls().isEmpty }
        cancellationMonitor.cancel()
        do { _ = try await controls.claim(cancelled); XCTFail("Cancelled call cannot be claimed") } catch {}

        let declined = try await incoming("decline")
        await controls.decline(declined)
        let declineMonitor = Task { await controls.monitor(declined) }
        try await until("API decline dismisses SIP offer") { engine.activeCalls().isEmpty }
        declineMonitor.cancel()
        do { _ = try await controls.claim(declined); XCTFail("Declined call cannot be claimed") } catch {}
        try phase("decline-finished")
        try await until("Declined caller ended") { try await client.call(XCTUnwrap(declined.gatewayCallID), for: enrollment).state == .ended }

        let lost = try await incoming("other-device")
        let winnerMonitor = Task { await controls.monitor(lost) }
        try phase("other-device-ringing")
        try await until("Other-device winner dismisses this offer") { engine.activeCalls().isEmpty }
        winnerMonitor.cancel()
        let winner = try await client.call(XCTUnwrap(lost.gatewayCallID), for: enrollment)
        XCTAssertFalse(winner.claimedByThisDevice); XCTAssertTrue(winner.isUnavailable())

        let failed = try await incoming("answer-failed")
        _ = try await controls.claim(failed)
        // Mirrors CallKit's failed local acceptance cleanup without invoking its system UI.
        engine.hangup(failed, code: 480, onlyIfRinging: true)
        await controls.decline(failed)
        try await until("Failed answer removes SIP offer") { engine.activeCalls().isEmpty }
        do { _ = try await controls.claim(failed); XCTFail("Failed call cannot be reclaimed") } catch {}
        try phase("answer-failed-finished")
        try await until("Failed caller ended") { try await client.call(XCTUnwrap(failed.gatewayCallID), for: enrollment).state == .ended }
    }
}

private final class GatewayStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ value: Data, key: String) throws { values[key] = value }
    func remove(_ key: String) throws { values[key] = nil }
}
@MainActor
private final class GatewayObserver: @preconcurrency SIPEngineDelegate {
    var registered = false, failed = false
    var failure = "No registration response"
    var incoming: CallSnapshot?
    func sipEngine(_ engine: SIPEngine, registrationDidChange accountID: UUID, state: RegistrationState) {
        if state.isRegistered { registered = true }
        if case .failed(let code, let reason) = state { failed = true; failure = "\(code): \(reason)" }
    }
    func sipEngine(_ engine: SIPEngine, didReceiveIncomingCall call: CallSnapshot) { incoming = call }
    func sipEngine(_ engine: SIPEngine, callDidChange call: CallSnapshot) {}
    func sipEngine(_ engine: SIPEngine, callDidEnd call: CallSnapshot) {}
    func sipEngine(_ engine: SIPEngine, voicemailDidChange accountID: UUID, info: VoicemailInfo) {}
    func sipEngine(_ engine: SIPEngine, transferStatusDidChange callID: Int, code: Int, text: String, isFinal: Bool) {}
    func sipEngineDidStop(_ engine: SIPEngine, error: Error?) {}
}
