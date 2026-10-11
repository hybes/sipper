import XCTest
import AppAuth
@testable import SipperManaged

private final class CallStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    var failRemoval = false
    var failDirectoryWrite = false
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ data: Data, key: String) throws {
        if failDirectoryWrite && key.contains("directory.") { throw ManagedError.storageUnavailable }
        values[key] = data
    }
    func remove(_ key: String) throws {
        if failRemoval { throw ManagedError.storageUnavailable }
        values[key] = nil
    }
}

private final class CallHTTP: URLProtocol {
    static var handle: ((CallHTTP) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handle?(self) }
    override func stopLoading() {}
    func reply(_ object: [String: Any], status: Int = 200) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: object))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class ManagedCallTests: XCTestCase {
    private let organisationID = UUID(), deviceID = UUID(), accountID = UUID(), callID = UUID()
    private var requests: [URLRequest] = []
    private var handler: ((CallHTTP) -> Bool)?
    private let origin = URL(string: "https://calls.example.invalid")!
    func testMessageNotificationsUseNormalTokensAndOpaqueOwnedNavigationHints() async throws {
        let store = CallStore(), (client, entry) = try await signedIn(store)
        var wrongDevice = false
        handler = { request in
            guard request.request.url!.path.hasSuffix("/messages/push") else { return false }
            let id = wrongDevice ? UUID() : self.deviceID
            if request.request.httpMethod == "DELETE" { request.reply(["deviceId": id.uuidString, "removed": true]) }
            else {
                XCTAssertEqual(try? self.body(request.request)["token"] as? String, String(repeating: "0a", count: 32))
                request.reply(["deviceId": id.uuidString, "registered": true, "provider": "apns"])
            }
            return true
        }
        try await client.setMessagePushToken(Data(repeating: 10, count: 32), for: entry)
        let count = requests.count
        await failure(.invalidMessageInput) { try await client.setMessagePushToken(Data([1]), for: entry) }
        XCTAssertEqual(requests.count, count)
        wrongDevice = true
        await failure(.invalidMessages) { try await client.setMessagePushToken(Data(repeating: 10, count: 32), for: entry) }
        await failure(.invalidMessages) { try await client.setMessagePushToken(nil, for: entry) }
        wrongDevice = false; try await client.setMessagePushToken(nil, for: entry)
        XCTAssertFalse(store.values.values.contains { String(data: $0, encoding: .utf8)?.contains(String(repeating: "0a", count: 32)) == true })
        let now = Date(), conversation = UUID()
        var payload: [String: Any] = ["schemaVersion": 1, "type": "message", "deviceId": deviceID.uuidString,
            "conversationId": conversation.uuidString, "expiresAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(60))]
        let hint = try XCTUnwrap(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now))
        XCTAssertEqual(hint.deviceId, entry.deviceID); XCTAssertEqual(hint.conversationId, conversation)
        XCTAssertNil(IncomingManagedCall.parse(apns: ["sipper": payload], now: now), "A chat must never become a CallKit hint")
        payload["text"] = "Do not accept push previews"; XCTAssertNil(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now)); payload["text"] = nil
        payload["schemaVersion"] = true; XCTAssertNil(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now)); payload["schemaVersion"] = 1
        payload["expiresAt"] = ISO8601DateFormatter().string(from: now.addingTimeInterval(301)); XCTAssertNil(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now))
        payload["expiresAt"] = ISO8601DateFormatter().string(from: now.addingTimeInterval(-60))
        XCTAssertNil(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now))
        XCTAssertNotNil(ManagedMessageNotification.parse(apns: ["sipper": payload], now: now, forRouting: true), "Tapping an old notice can navigate; HTTP still supplies all access")
        try await client.disconnect(entry)
        await failure { try await client.setMessagePushToken(Data(repeating: 10, count: 32), for: entry) }
    }
    private func client(_ store: CallStore) throws -> ManagedClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CallHTTP.self]
        return try ManagedClient(serverURL: origin, clientID: "sipper-ios", storage: store, sessionConfiguration: config)
    }
    private func signedIn(_ store: CallStore = CallStore()) async throws -> (ManagedClient, ManagedEnrollment) {
        CallHTTP.handle = { [weak self] request in
            Task { @MainActor in
                guard let self else { return }
                self.requests.append(request.request)
                XCTAssertEqual(request.request.url?.host, "calls.example.invalid")
                XCTAssertEqual(request.request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-token")
                if self.handler?(request) == true { return }
                switch request.request.url!.path.lowercased() {
                case "/api/client/organisations":
                    request.reply(["user": ["id": "fixture-member", "email": "member@example.invalid"], "organisations": [self.organisation]])
                case "/api/client/organisations/\(self.organisationID.uuidString.lowercased())/devices":
                    request.reply(["id": self.deviceID.uuidString, "name": "Fixture iPhone", "platform": "ios"])
                case "/api/client/devices/\(self.deviceID.uuidString.lowercased())/configuration":
                    request.reply(self.configuration)
                case "/api/client/devices/\(self.deviceID.uuidString.lowercased())":
                    request.reply(["signedOut": true])
                default:
                    XCTFail("Unexpected request: \(request.request.httpMethod ?? "") \(request.request.url!.path)")
                    request.reply([:], status: 404)
                }
            }
        }
        let client = try client(store)
        let config = OIDServiceConfiguration(authorizationEndpoint: origin.appendingPathComponent("api/auth/oauth2/authorize"), tokenEndpoint: origin.appendingPathComponent("api/auth/oauth2/token"))
        let request = OIDTokenRequest(configuration: config, grantType: OIDGrantTypeAuthorizationCode, authorizationCode: "fixture-code", redirectURL: URL(string: "com.hybes.sipper:/oauth/callback"), clientID: "sipper-ios", clientSecret: nil, scopes: ["sipper:client"], refreshToken: nil, codeVerifier: "fixture-verifier", additionalParameters: nil)
        let response = OIDTokenResponse(request: request, parameters: ["access_token": "fictional-token" as NSString, "token_type": "Bearer" as NSString, "expires_in": 3600 as NSNumber])
        try await client.acceptAuthentication(OIDAuthState(authorizationResponse: nil, tokenResponse: response, registrationResponse: nil))
        let enrollment = try await client.enrol(organisation: client.organisations[0], name: "Fixture iPhone", appVersion: "fixture", osVersion: "fixture")
        return (client, enrollment)
    }
    private var organisation: [String: Any] { ["id": organisationID.uuidString, "name": "Example customer", "status": "active", "licensed": true] }
    private var configuration: [String: Any] {
        ["schemaVersion": 1, "organisation": ["id": organisationID.uuidString, "name": "Example customer"],
         "deviceId": deviceID.uuidString, "revision": String(repeating: "a", count: 64),
         "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
         "accounts": [["id": accountID.uuidString, "label": "Fixture gateway", "mode": "gateway", "revision": 1, "password": "fictional-secret",
                       "settings": ["username": "fixture", "authUsername": "", "domain": "gateway.example.invalid", "server": "gateway.example.invalid", "port": 5061,
                                    "transport": "tls", "srtp": "required", "displayName": "", "voicemailNumber": "*97", "useICE": true, "stunServer": ""]]]]
    }
    private func snapshot(state: String = "ringing", claimed: Bool = false) -> [String: Any] {
        var result: [String: Any] = ["id": callID.uuidString, "configurationId": accountID.uuidString, "state": state,
            "version": 1, "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(45)), "claimedByThisDevice": claimed]
        if state == "ringing" || state == "answering" { result["caller"] = ["name": "Example caller", "number": "100"] }
        return result
    }
    private func failure<T>(_ expected: ManagedError? = nil, _ operation: () async throws -> T) async {
        do { _ = try await operation(); XCTFail("Expected rejection") }
        catch { if let expected { XCTAssertEqual(error as? ManagedError, expected) } }
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let value = request.httpBody { data = value }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var value = Data(), bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let count = stream.read(&bytes, maxLength: bytes.count); if count <= 0 { break }; value.append(contentsOf: bytes.prefix(count)) }
            data = value
        } else { return [:] }
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testCallLifecycleAndTokenRotationUseOnlyTheEnrolledDevice() async throws {
        let (client, enrollment) = try await signedIn()
        handler = { request in
            let path = request.request.url!.path.lowercased()
            if path.hasSuffix("/push") {
                if request.request.httpMethod == "PUT" {
                    let token = try! self.body(request.request)["token"] as! String
                    XCTAssertTrue([String(repeating: "01", count: 32), String(repeating: "02", count: 32)].contains(token))
                    request.reply(["registered": true, "provider": "apns"])
                } else { XCTAssertEqual(request.request.httpMethod, "DELETE"); request.reply(["removed": true]) }
                return true
            }
            guard path.contains("/calls/") else { return false }
            XCTAssertTrue(path.contains(self.deviceID.uuidString.lowercased()))
            if path.hasSuffix("/answer") { request.reply(self.snapshot(state: "answering", claimed: true)) }
            else if path.hasSuffix("/decline") { request.reply(self.snapshot(state: "ended")) }
            else { request.reply(self.snapshot()) }
            if !path.hasSuffix(self.callID.uuidString.lowercased()) { XCTAssertEqual(request.request.httpMethod, "POST"); XCTAssertTrue(try! self.body(request.request).isEmpty) }
            else { XCTAssertEqual(request.request.httpMethod, "GET") }
            return true
        }
        let ringing = try await client.call(callID, for: enrollment)
        XCTAssertFalse(ringing.isUnavailable())
        let wake = try await client.call(callID, for: enrollment, action: .wake)
        XCTAssertEqual(wake.caller?.label, "Example caller")
        let answer = try await client.call(callID, for: enrollment, action: .answer)
        XCTAssertTrue(answer.claimedByThisDevice)
        let declined = try await client.call(callID, for: enrollment, action: .decline)
        XCTAssertTrue(declined.isUnavailable())
        try await client.setVoIPPushToken(Data(repeating: 1, count: 32), for: enrollment)
        try await client.setVoIPPushToken(Data(repeating: 2, count: 32), for: enrollment)
        try await client.setVoIPPushToken(nil, for: enrollment)
        let before = requests.count
        let foreign = ManagedEnrollment(organisationID: organisationID, organisationName: "Other", deviceID: UUID(), installationID: enrollment.installationID, userID: enrollment.userID, localProfileID: enrollment.localProfileID)
        await failure { try await client.call(self.callID, for: foreign) }
        await failure { try await client.setVoIPPushToken(Data(repeating: 1, count: 32), for: foreign) }
        await failure { try await client.configuration(for: foreign) }
        await failure { try await client.report(.init(), for: foreign) }
        await failure(.invalidConfiguration) { try await client.setVoIPPushToken(Data([1]), for: enrollment) }
        XCTAssertEqual(requests.count, before)
    }

    func testChangedReportsCoalesceThrottleRetryAndRetainForcedHeartbeats() async throws {
        let (client, enrollment) = try await signedIn()
        var accepted = true, count = 0
        handler = { request in
            guard request.request.url!.path.hasSuffix("/report") else { return false }
            count += 1; request.reply(["accepted": accepted]); return true
        }
        var calls = ManagedDeviceReport.DirectCalls(accountID: accountID)
        let idle = ManagedDeviceReport(appliedRevision: String(repeating: "a", count: 64), directCalls: [calls])
        try await client.report(idle, for: enrollment, onlyIfChanged: true)
        try await client.report(idle, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 1)
        calls.ringing = 1
        let ringing = ManagedDeviceReport(appliedRevision: idle.appliedRevision, directCalls: [calls])
        try await client.report(ringing, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 1, "Rapid changes wait for the next allowed attempt")
        accepted = false
        await failure(.requestFailed) { try await client.report(ringing, for: enrollment) }
        try await client.report(ringing, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 2, "Failed reports are rate limited too")
        accepted = true
        try await Task.sleep(for: .milliseconds(5100))
        try await client.report(ringing, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 3, "A failed observation must remain pending")
        try await client.report(ringing, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 3)
        try await client.report(ringing, for: enrollment)
        XCTAssertEqual(count, 4, "Regular heartbeats bypass deduplication")
        try client.forgetConfiguration(for: enrollment)
        try await client.report(ringing, for: enrollment, onlyIfChanged: true)
        XCTAssertEqual(count, 5, "Reconnected access must not inherit an old acknowledgement")
    }

    func testReportRevisionConflictIsNotAccessRevocation() async throws {
        let (client, enrollment) = try await signedIn()
        handler = { request in
            guard request.request.url!.path.hasSuffix("/report") else { return false }
            request.reply([:], status: 409); return true
        }
        await failure(.configurationChanged) { try await client.report(.init(), for: enrollment) }
        XCTAssertTrue(client.isSignedIn); XCTAssertTrue(client.enrollments.contains(enrollment))
    }

    func testReportsRemainOrderedWhenAnEarlierRequestIsSlow() async throws {
        let (client, enrollment) = try await signedIn()
        var held: CallHTTP?, count = 0
        handler = { request in
            guard request.request.url!.path.hasSuffix("/report") else { return false }
            count += 1
            if count == 1 { held = request } else { request.reply(["accepted": true]) }
            return true
        }
        let first = Task { try await client.report(.init(registrations: []), for: enrollment) }
        let deadline = Date().addingTimeInterval(3)
        while held == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(held)
        defer { first.cancel() }
        let second = Task { try await client.report(.init(directCalls: []), for: enrollment) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(count, 1, "The newer observation cannot overtake the first")
        held?.reply(["accepted": true])
        try await first.value; try await second.value
        XCTAssertEqual(count, 2)
    }

    func testSetupRedemptionUsesAuthenticatedBodyAndChecksReturnedIdentity() async throws {
        let (client, _) = try await signedIn()
        let reference = String(repeating: "a", count: 43), link = "\(origin)/portal/setup#ref=\(reference)"
        handler = { request in
            guard request.request.url?.path == "/api/client/setup-links/redeem" else { return false }
            XCTAssertEqual(request.request.httpMethod, "POST")
            XCTAssertNil(request.request.url?.query); XCTAssertNil(request.request.url?.fragment)
            XCTAssertEqual(try! self.body(request.request)["reference"] as? String, reference)
            request.reply(["userId": "fixture-member", "organisation": self.organisation]); return true
        }
        let selected = try await client.redeemSetupLink(link)
        XCTAssertEqual(selected.id, organisationID)
        handler = { request in request.reply(["userId": "other-member", "organisation": self.organisation]); return true }
        await failure(.invalidConfiguration) { try await client.redeemSetupLink(link) }
        handler = { request in request.reply([:], status: 404); return true }
        await failure(.accessUnavailable("This setup link is unavailable for your signed-in account. Check your email and ask your administrator for a new link.")) { try await client.redeemSetupLink(link) }
        let before = requests.count
        await failure(.invalidSetupLink) { try await client.redeemSetupLink("https://other.example.invalid/portal/setup#ref=\(reference)") }
        XCTAssertEqual(requests.count, before)
    }

    func testSetupRedemptionCannotSurviveSignOut() async throws {
        let (client, _) = try await signedIn()
        let started = expectation(description: "Setup redemption in flight")
        var pending: CallHTTP?
        handler = { request in
            if request.request.url?.path == "/api/client/setup-links/redeem" { pending = request; started.fulfill(); return true }
            return false
        }
        let redemption = Task { try await client.redeemSetupLink("\(origin)/portal/setup#ref=\(String(repeating: "a", count: 43))") }
        await fulfillment(of: [started], timeout: 3)
        try await client.signOut()
        pending!.reply(["userId": "fixture-member", "organisation": organisation])
        await failure(.cancelled) { try await redemption.value }
        XCTAssertTrue(client.enrollments.isEmpty)
        await failure(.signInRequired) { try await client.redeemSetupLink("invalid") }
    }

    func testUnboundMalformedAndCompetingCallResponsesAreRejected() async throws {
        let (client, enrollment) = try await signedIn()
        var response = snapshot(), status = 200
        handler = { request in request.reply(response, status: status); return true }
        response["id"] = UUID().uuidString
        await failure(.invalidConfiguration) { try await client.call(self.callID, for: enrollment) }
        for alteration in ["caller", "state", "version"] {
            response = snapshot()
            if alteration == "caller" { response["caller"] = ["name": "bad\nlabel", "number": "100"] }
            if alteration == "state" { response["state"] = "invented" }
            if alteration == "version" { response["version"] = 0 }
            await failure { try await client.call(self.callID, for: enrollment) }
        }
        status = 409
        await failure(.callUnavailable) { try await client.call(self.callID, for: enrollment, action: .answer) }
        status = 200; response = snapshot(state: "answering", claimed: false)
        let unavailable = try await client.call(callID, for: enrollment)
        XCTAssertTrue(unavailable.isUnavailable())
        response = snapshot(); response["expiresAt"] = "2020-01-01T00:00:00Z"
        let expired = try await client.call(callID, for: enrollment)
        XCTAssertTrue(expired.isUnavailable())
        response = snapshot(state: "answered", claimed: true); response["expiresAt"] = "2020-01-01T00:00:00Z"
        let connected = try await client.call(callID, for: enrollment)
        XCTAssertFalse(connected.isUnavailable(), "An established call does not expire with its ringing deadline")
        response = ["registered": true, "provider": "fcm"]
        await failure(.invalidConfiguration) { try await client.setVoIPPushToken(Data(repeating: 1, count: 32), for: enrollment) }
        status = 401
        await failure(.signInRequired) { try await client.call(self.callID, for: enrollment) }
        XCTAssertFalse(client.isSignedIn)
        let before = requests.count
        await failure(.signInRequired) { try await client.call(self.callID, for: enrollment, action: .answer) }
        XCTAssertEqual(requests.count, before)
    }

    func testDisconnectInvalidatesPendingCallAndConfigurationBeforeRemoteCleanup() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store)
        _ = try await client.configuration(for: enrollment)
        let started = expectation(description: "Both requests in flight"); started.expectedFulfillmentCount = 2
        let removing = expectation(description: "Remote disconnect in flight")
        var pending: [CallHTTP] = [], deletion: CallHTTP?
        handler = { request in
            if request.request.httpMethod == "DELETE" { deletion = request; removing.fulfill() }
            else { pending.append(request); started.fulfill() }
            return true
        }
        let configuration = Task { try await client.configuration(for: enrollment) }
        let call = Task { try await client.call(self.callID, for: enrollment) }
        await fulfillment(of: [started], timeout: 3)
        let disconnect = Task { try await client.disconnect(enrollment) }
        await fulfillment(of: [removing], timeout: 3)
        XCTAssertTrue(client.enrollments.isEmpty)
        XCTAssertNil(try client.cachedConfiguration(for: enrollment))
        XCTAssertTrue(try self.client(store).enrollments.isEmpty)
        for request in pending { request.reply(request.request.url!.path.hasSuffix("configuration") ? self.configuration : snapshot()) }
        await failure { try await configuration.value }
        await failure { try await call.value }
        XCTAssertFalse(store.values.keys.contains { $0.contains("configuration.") })
        deletion!.reply(["signedOut": true]); try await disconnect.value
    }

    func testSignOutClearsAuthorityAndSavedSecretsBeforeNetworkAndFailsClosedOnStorageError() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store)
        _ = try await client.configuration(for: enrollment)
        let removing = expectation(description: "Remote cleanup")
        var deletion: CallHTTP?
        handler = { request in deletion = request; removing.fulfill(); return true }
        let logout = Task { try await client.signOut() }
        await fulfillment(of: [removing], timeout: 3)
        XCTAssertFalse(client.isSignedIn); XCTAssertNil(client.identity); XCTAssertTrue(client.enrollments.isEmpty)
        XCTAssertTrue(store.values.isEmpty)
        XCTAssertFalse(try self.client(store).isSignedIn)
        let before = requests.count
        await failure(.signInRequired) { try await client.call(self.callID, for: enrollment) }
        XCTAssertEqual(requests.count, before)
        deletion!.reply([:], status: 503); try await logout.value
        handler = nil
        let (second, _) = try await signedIn(store)
        store.failRemoval = true
        await failure(.storageUnavailable) { try await second.signOut() }
        XCTAssertFalse(second.isSignedIn); XCTAssertTrue(second.enrollments.isEmpty)
    }

    func testPushHintsAreOpaqueBoundedAndNeverContainCallerAuthority() throws {
        let now = Date(), expiry = ISO8601DateFormatter().string(from: Date().addingTimeInterval(45))
        let base: [String: Any] = ["schemaVersion": 1, "deviceId": deviceID.uuidString, "callId": callID.uuidString, "expiresAt": expiry]
        XCTAssertEqual(IncomingManagedCall.parse(apns: ["aps": [:], "sipper": base], now: now)?.deviceId, deviceID)
        for field in ["schemaVersion", "deviceId", "callId", "expiresAt", "caller"] {
            var invalid = base
            if field == "schemaVersion" { invalid[field] = true }
            else { invalid[field] = field == "expiresAt" ? "2099-01-01T00:00:00Z" : "not-an-id" }
            XCTAssertNil(IncomingManagedCall.parse(apns: ["sipper": invalid], now: now))
        }
        var expired = base; expired["expiresAt"] = "2020-01-01T00:00:00Z"
        XCTAssertNil(IncomingManagedCall.parse(apns: ["sipper": expired], now: now))
        XCTAssertNil(IncomingManagedCall.parse(apns: [:]))
    }

    private func directoryContact(_ id: UUID = UUID()) -> [String: Any] {
        ["id": id.uuidString, "name": "Example Reception", "company": "Fictional Company", "revision": 1,
         "updatedAt": "2026-01-01T00:00:00Z", "numbers": [["label": "Work", "number": "+12025550101"]]]
    }
    private func directoryPage(_ contacts: [[String: Any]], revision: UUID, more: Bool = false, expiry: Date = Date().addingTimeInterval(3600)) -> [String: Any] {
        ["organisation": ["id": organisationID.uuidString, "name": "Example customer"], "deviceId": deviceID.uuidString,
         "revision": revision.uuidString, "expiresAt": ISO8601DateFormatter().string(from: expiry), "contacts": contacts,
         "nextCursor": more ? contacts.last!["id"]! : NSNull()]
    }

    func testDirectoryPublishesOnlyCompleteBoundPagesWithEarliestExpiryAndSecureReload() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), revision = UUID()
        let contacts = (0..<101).map { _ in directoryContact() }, expiry = Date().addingTimeInterval(120)
        var pages = 0
        handler = { request in
            XCTAssertEqual(request.request.url?.path.lowercased(), "/api/client/devices/\(self.deviceID.uuidString.lowercased())/directory")
            XCTAssertEqual(request.request.httpMethod, "GET")
            XCTAssertEqual(request.request.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertNil(client.directories[enrollment.deviceID], "Partial pages must never appear")
            let query = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)!.queryItems
            if pages == 0 { XCTAssertNil(query); request.reply(self.directoryPage(Array(contacts.prefix(100)), revision: revision, more: true, expiry: expiry)) }
            else {
                XCTAssertEqual(query?.first(where: { $0.name == "after" })?.value, contacts[99]["id"] as? String)
                XCTAssertEqual(query?.first(where: { $0.name == "revision" })?.value, revision.uuidString)
                request.reply(self.directoryPage([contacts[100]], revision: revision))
            }
            pages += 1; return true
        }
        let value = try await client.directory(for: enrollment)
        XCTAssertEqual(pages, 2); XCTAssertEqual(value.contacts.count, 101)
        XCTAssertEqual(value.expiresAt.timeIntervalSince1970, floor(expiry.timeIntervalSince1970), accuracy: 0.01)
        XCTAssertEqual(try self.client(store).directories[deviceID], value)
        XCTAssertTrue(value.contacts[0].matches("(202) 555-0101"))
        XCTAssertEqual(try client.directoryNumber("+12025550101", contactID: value.contacts[0].id, for: enrollment), "+12025550101")
        XCTAssertThrowsError(try client.directoryNumber("999", contactID: value.contacts[0].id, for: enrollment))
        XCTAssertThrowsError(try client.directoryNumber("+12025550101", contactID: UUID(), for: enrollment))
        try client.expireDirectories(now: expiry.addingTimeInterval(1))
        XCTAssertTrue(client.directories.isEmpty); XCTAssertNil(try client.cachedDirectory(for: enrollment))
        XCTAssertFalse(store.values.keys.contains { $0.contains("directory.") })
    }

    func testDirectoryRestartsChangedPagesOnceAndRejectsRepeatedCursorOrMixedRevision() async throws {
        let (client, enrollment) = try await signedIn(), revision = UUID()
        let contacts = (0..<100).map { _ in directoryContact() }
        var step = 0
        handler = { request in
            step += 1
            if step == 1 { request.reply(self.directoryPage(contacts, revision: revision, more: true)) }
            else if step == 2 { request.reply([:], status: 409) }
            else { XCTAssertNil(request.request.url?.query); request.reply(self.directoryPage([], revision: UUID())) }
            return true
        }
        let result = try await client.directory(for: enrollment)
        XCTAssertEqual(step, 3); XCTAssertTrue(result.contacts.isEmpty)
        try client.forgetDirectory(for: enrollment)
        handler = { request in request.reply(self.directoryPage(contacts, revision: revision, more: true)); return true }
        await failure(.invalidDirectory) { try await client.directory(for: enrollment) }
        XCTAssertTrue(client.directories.isEmpty)
        step = 0
        handler = { request in
            step += 1
            request.reply(self.directoryPage(contacts, revision: UUID(), more: true)); return true
        }
        await failure(.directoryChanged) { try await client.directory(for: enrollment) }
        XCTAssertEqual(step, 4, "One bounded restart rather than an endless changed-directory loop")
        XCTAssertTrue(client.directories.isEmpty)
    }

    func testDirectoryRejectsUnsafeUnboundExpiredAndDuplicateDataBeforePublishing() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), revision = UUID()
        var page = directoryPage([directoryContact()], revision: revision)
        handler = { request in request.reply(page); return true }
        for field in ["organisation", "deviceId", "expiresAt", "nextCursor", "contacts"] {
            page = directoryPage([directoryContact()], revision: revision)
            switch field {
            case "organisation": page[field] = ["id": UUID().uuidString, "name": "Other customer"]
            case "deviceId", "nextCursor": page[field] = UUID().uuidString
            case "expiresAt": page[field] = "2020-01-01T00:00:00Z"
            default: let contact = directoryContact(); page[field] = [contact, contact]
            }
            await failure(.invalidDirectory) { try await client.directory(for: enrollment) }
        }
        for number in ["sip:user@example.invalid", "https://example.invalid", "1\n2", "＋123", "+", "1;2", String(repeating: "1", count: 65)] {
            var contact = directoryContact(); contact["numbers"] = [["label": "Work", "number": number]]
            page = directoryPage([contact], revision: revision)
            await failure(.invalidDirectory) { try await client.directory(for: enrollment) }
        }
        var contact = directoryContact(); contact["name"] = "bad\nname"
        page = directoryPage([contact], revision: revision)
        await failure(.invalidDirectory) { try await client.directory(for: enrollment) }
        XCTAssertTrue(client.directories.isEmpty); XCTAssertNil(try client.cachedDirectory(for: enrollment))
        page = directoryPage([directoryContact()], revision: revision); store.failDirectoryWrite = true
        await failure(.storageUnavailable) { try await client.directory(for: enrollment) }
        XCTAssertTrue(client.directories.isEmpty)
    }

    func testDirectoryDenialAndMembershipWithdrawalClearCacheButNetworkFailureDoesNotExtendIt() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), page = directoryPage([directoryContact()], revision: UUID())
        handler = { request in request.reply(page); return true }
        let original = try await client.directory(for: enrollment)
        handler = { request in request.reply([:], status: 503); return true }
        await failure(.serverUnavailable) { try await client.directory(for: enrollment) }
        XCTAssertEqual(client.directories[deviceID], original)
        handler = { request in request.reply([:], status: 403); return true }
        await failure { try await client.directory(for: enrollment) }
        XCTAssertTrue(client.directories.isEmpty); XCTAssertNil(try client.cachedDirectory(for: enrollment))
        handler = { request in request.reply(page); return true }; try await client.directory(for: enrollment)
        handler = { request in request.reply(["user": ["id": "fixture-member", "email": "member@example.invalid"], "organisations": []]); return true }
        try await client.refreshOrganisations()
        XCTAssertTrue(client.directories.isEmpty); XCTAssertNil(try client.cachedDirectory(for: enrollment))
        handler = { request in request.reply(page); return true }; try await client.directory(for: enrollment)
        handler = { request in request.reply([:], status: 401); return true }
        await failure(.signInRequired) { try await client.directory(for: enrollment) }
        XCTAssertTrue(client.directories.isEmpty); XCTAssertFalse(store.values.keys.contains { $0.contains("directory.") })
    }

    func testDirectoryWithdrawalAndSignOutFenceLateResponsesAndCacheIdentity() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), page = directoryPage([directoryContact()], revision: UUID())
        handler = { request in request.reply(page); return true }; try await client.directory(for: enrollment)
        let cacheKey = try XCTUnwrap(store.values.keys.first { $0.contains("directory.") })
        var archive = try JSONSerialization.jsonObject(with: store.values[cacheKey]!) as! [String: Any]
        archive["userID"] = "another-user"; store.values[cacheKey] = try JSONSerialization.data(withJSONObject: archive)
        XCTAssertThrowsError(try client.cachedDirectory(for: enrollment)); XCTAssertNil(store.values[cacheKey])
        let started = expectation(description: "Directory request in flight")
        var pending: CallHTTP?
        handler = { request in pending = request; started.fulfill(); return true }
        let loading = Task { try await client.directory(for: enrollment) }
        await fulfillment(of: [started], timeout: 3)
        try client.forgetConfiguration(for: enrollment)
        pending!.reply(page)
        await failure(.cancelled) { try await loading.value }
        XCTAssertTrue(client.directories.isEmpty); XCTAssertNil(store.values[cacheKey])
        handler = { request in request.reply(page); return true }; try await client.directory(for: enrollment)
        handler = nil; try await client.signOut()
        XCTAssertTrue(client.directories.isEmpty); XCTAssertTrue(store.values.isEmpty)
    }
    func testDirectoryStatusIsBoundEphemeralAndRejectsMalformedPreferences() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), revision = UUID(), id = UUID()
        handler = { request in request.reply(self.directoryPage([self.directoryContact(id)], revision: revision)); return true }
        try await client.directory(for: enrollment)
        let saved = store.values
        let base: [String: Any] = ["deviceId": deviceID.uuidString, "organisationId": organisationID.uuidString,
            "revision": revision.uuidString, "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(50)),
            "contacts": [["contactId": id.uuidString, "availability": "away", "doNotDisturb": true]]]
        var response = base
        handler = { request in
            XCTAssertTrue(request.request.url!.path.hasSuffix("/directory/status")); XCTAssertEqual(request.request.httpMethod, "POST")
            let body = try! self.body(request.request)
            XCTAssertEqual(body["revision"] as? String, revision.uuidString); XCTAssertEqual(body["contactIds"] as? [String], [id.uuidString])
            request.reply(response); return true
        }
        let value = try await client.directoryStatus(contactIDs: [id], for: enrollment)
        XCTAssertEqual(value.label(for: id), "Away · Do Not Disturb")
        XCTAssertLessThanOrEqual(value.expiresAt.timeIntervalSinceNow, 30)
        XCTAssertEqual(value.label(for: id, now: value.expiresAt), "Status unavailable")
        response["contacts"] = [["contactId": id.uuidString, "availability": NSNull(), "doNotDisturb": NSNull()]]
        let hidden = try await client.directoryStatus(contactIDs: [id], for: enrollment)
        XCTAssertEqual(hidden.label(for: id), "Status unavailable")
        let activity: [String: Any] = ["state": "in_call", "source": "device", "observedAt": ISO8601DateFormatter().string(from: Date())]
        response = base; response["contacts"] = [["contactId": id.uuidString, "availability": NSNull(), "doNotDisturb": NSNull(), "activity": activity]]
        let observed = try await client.directoryStatus(contactIDs: [id], for: enrollment)
        XCTAssertEqual(observed.label(for: id), "In a call · App report")
        XCTAssertEqual(observed.label(for: id, now: observed.expiresAt), "Status unavailable")
        for patch: [String: Any] in [["state": "online"], ["source": "pbx"], ["observedAt": "2020-01-01T00:00:00Z"],
            ["observedAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(120))],
            ["observedAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-160))]] {
            response["contacts"] = [["contactId": id.uuidString, "availability": NSNull(), "doNotDisturb": NSNull(), "activity": activity.merging(patch) { _, new in new }]]
            await failure { try await client.directoryStatus(contactIDs: [id], for: enrollment) }
        }
        for field in ["deviceId", "organisationId", "revision", "expiresAt", "contacts"] {
            response = base
            response[field] = field == "expiresAt" ? "2020-01-01T00:00:00Z" : field == "contacts" ? [] : UUID().uuidString
            await failure { try await client.directoryStatus(contactIDs: [id], for: enrollment) }
        }
        for contact: [String: Any] in [
            ["contactId": id.uuidString, "availability": "away"],
            ["contactId": id.uuidString, "availability": "online", "doNotDisturb": true],
            ["contactId": id.uuidString, "availability": NSNull(), "doNotDisturb": true],
            ["contactId": id.uuidString, "availability": "away", "doNotDisturb": "true"],
            ["contactId": UUID().uuidString, "availability": "away", "doNotDisturb": false]
        ] {
            response = base; response["contacts"] = [contact]
            await failure { try await client.directoryStatus(contactIDs: [id], for: enrollment) }
        }
        let count = requests.count
        for ids in [[], [id, id], [UUID()], Array(repeating: id, count: 101)] {
            await failure(.invalidDirectory) { try await client.directoryStatus(contactIDs: ids, for: enrollment) }
        }
        XCTAssertEqual(requests.count, count)
        XCTAssertEqual(Set(store.values.keys), Set(saved.keys))
        // AppAuth is persisted on token access; its archive bytes need not be deterministic.
        XCTAssertEqual(store.values.filter { !$0.key.hasSuffix(".authentication") }, saved.filter { !$0.key.hasSuffix(".authentication") })
        XCTAssertEqual(try self.client(store).identity, client.identity)
        handler = { request in request.reply([:], status: 403); return true }
        await failure { try await client.directoryStatus(contactIDs: [id], for: enrollment) }
        XCTAssertNil(client.directories[deviceID]); XCTAssertNil(try client.cachedDirectory(for: enrollment))
    }

    func testDirectoryStatusCannotReturnAfterDirectoryWithdrawal() async throws {
        let (client, enrollment) = try await signedIn(), revision = UUID(), id = UUID()
        handler = { request in request.reply(self.directoryPage([self.directoryContact(id)], revision: revision)); return true }
        try await client.directory(for: enrollment)
        let started = expectation(description: "Status request in flight"); var pending: CallHTTP?
        handler = { request in pending = request; started.fulfill(); return true }
        let loading = Task { try await client.directoryStatus(contactIDs: [id], for: enrollment) }
        await fulfillment(of: [started], timeout: 3)
        try client.forgetDirectory(for: enrollment)
        pending!.reply(["deviceId": deviceID.uuidString, "organisationId": organisationID.uuidString, "revision": revision.uuidString,
            "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(30)),
            "contacts": [["contactId": id.uuidString, "availability": "away", "doNotDisturb": false]]])
        await failure(.directoryChanged) { try await loading.value }
        XCTAssertNil(client.directories[deviceID])
    }

}

// Reuse the authenticated device fixture for messaging's network boundary.
extension ManagedCallTests {
    private var messageScope: [String: Any] {
        ["schemaVersion": 1, "organisation": ["id": organisationID.uuidString, "name": "Example customer"],
         "deviceId": deviceID.uuidString, "userId": "fixture-member", "retentionDays": 90,
         "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(45))]
    }
    private func messageConversation(_ id: UUID) -> [String: Any] {
        let date = ISO8601DateFormatter().string(from: Date())
        return ["id": id.uuidString, "kind": "direct", "title": "Alex fixture", "createdAt": date, "updatedAt": date,
                "participants": [["id": "fixture-member", "name": "Fixture member", "lastReadSequence": "0"],
                                 ["id": "alex-fixture", "name": "Alex fixture", "lastReadSequence": "0"]],
                "unread": 1, "lastSequence": "9007199254740994"]
    }
    private func textMessage(_ id: UUID = UUID(), sequence: String = "9007199254740993", text: String = "Plain markup <b>hello</b>\n🌱", sender: String = "alex-fixture") -> [String: Any] {
        ["id": id.uuidString, "sequence": sequence, "text": text, "senderId": sender, "senderName": "Alex fixture",
         "createdAt": ISO8601DateFormatter().string(from: Date())]
    }
    func testGroupChangesValidateJoiningHistoryExactStateAndLeaveWithoutAnArchive() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), id = UUID(), saved = store.values
        let ids = [enrollment.userID, "alex-fixture"]
        var conversation = messageConversation(id)
        conversation["kind"] = "group"; conversation["title"] = "Project"; conversation["revision"] = "9007199254740994"; conversation["ownerId"] = "alex-fixture"
        var raw = messageScope; raw["conversation"] = conversation
        var bodies: [[String: Any]] = []
        handler = { request in
            guard request.request.url?.path.contains("/messages/") == true else { return false }
            if request.request.url!.path.hasSuffix("/group") {
                XCTAssertEqual(request.request.httpMethod, "PUT"); bodies.append(try! self.body(request.request))
            }
            request.reply(raw); return true
        }
        for _ in 0..<2 {
            let c = try await client.updateMessageGroup(id, revision: "9007199254740993", title: " Project ", userIDs: ids, ownerID: "alex-fixture", for: enrollment)
            XCTAssertEqual(c.ownerId, "alex-fixture")
        }
        XCTAssertEqual(bodies[0] as NSDictionary, bodies[1] as NSDictionary)
        for patch in [["revision": "9007199254740992"], ["ownerId": "outsider"], ["title": "Different"]] {
            raw["conversation"] = conversation.merging(patch) { _, new in new }
            await failure(.invalidMessages) { try await client.updateMessageGroup(id, revision: "9007199254740993", title: "Project", userIDs: ids, ownerID: "alex-fixture", for: enrollment) }
        }
        let count = requests.count
        await failure(.invalidMessageInput) { try await client.updateMessageGroup(id, revision: "01", title: "Project", userIDs: ids, ownerID: "alex-fixture", for: enrollment) }
        await failure(.invalidMessageInput) { try await client.updateMessageGroup(id, revision: "1", title: " ", userIDs: ids, ownerID: "alex-fixture", for: enrollment) }
        await failure(.invalidMessageInput) { try await client.updateMessageGroup(id, revision: "1", title: "Project", userIDs: ["alex-fixture"], ownerID: "alex-fixture", for: enrollment) }
        XCTAssertEqual(requests.count, count)
        conversation["participants"] = ids.map { ["id": $0, "name": $0, "lastReadSequence": "9007199254740993", "joinedSequence": "9007199254740993"] }
        raw["conversation"] = conversation; raw["messages"] = [textMessage()]; raw["nextCursor"] = NSNull()
        await failure(.invalidMessages) { try await client.conversationMessages(id, for: enrollment) }
        raw["messages"] = []; let empty = try await client.conversationMessages(id, for: enrollment); XCTAssertTrue(empty.messages.isEmpty)
        raw = messageScope; raw["conversationId"] = id.uuidString; raw["left"] = true
        try await client.leaveMessageGroup(id, for: enrollment)
        raw["conversationId"] = UUID().uuidString
        await failure(.invalidMessages) { try await client.leaveMessageGroup(id, for: enrollment) }
        XCTAssertEqual(Set(store.values.keys), Set(saved.keys))
        // AppAuth rewrites its archive on token access; compare the stable enrolment and identity.
        XCTAssertEqual(store.values.filter { !$0.key.hasSuffix(".authentication") }, saved.filter { !$0.key.hasSuffix(".authentication") })
        XCTAssertEqual(try self.client(store).identity, client.identity)
    }
    func testDesktopMessageAlertsAreBoundOrderedShortLivedAndNeverArchived() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), saved = store.values
        let expiry = ISO8601DateFormatter().string(from: Date().addingTimeInterval(240))
        let alerts: [[String: Any]] = ["9007199254740993", "10000000000000000"].map {
            ["conversationId": UUID().uuidString, "sequence": $0, "expiresAt": expiry]
        }
        var raw = messageScope; raw["alerts"] = alerts; raw["nextCursor"] = NSNull()
        handler = { request in
            XCTAssertTrue(request.request.url!.path.hasSuffix("/messages/alerts"))
            XCTAssertEqual(request.request.httpMethod, "GET")
            XCTAssertEqual(URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.name, "after")
            request.reply(raw); return true
        }
        let page = try await client.messageAlerts(for: enrollment, after: "9007199254740992")
        XCTAssertEqual(page.alerts.map(\.sequence), ["9007199254740993", "10000000000000000"])
        let hint = ManagedMessageNotification(deviceId: enrollment.deviceID, conversationId: page.alerts[0].conversationId, expiresAt: page.alerts[0].expiresAt)
        XCTAssertEqual(ManagedMessageNotification.parse(apns: ["sipper": hint.payload]), hint)
        let original = raw
        let patches: [[String: Any]] = [
            ["userId": "another-user"], ["deviceId": UUID().uuidString], ["expiresAt": expiry],
            ["alerts": alerts.reversed().map { $0 }], ["alerts": [alerts[0], alerts[0]]], ["nextCursor": "10000000000000000"],
            ["alerts": [["conversationId": UUID().uuidString, "sequence": "01", "expiresAt": expiry]]],
            ["alerts": [["conversationId": UUID().uuidString, "sequence": "1", "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-1))]]],
            ["alerts": [["conversationId": UUID().uuidString, "sequence": "1", "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(330))]]],
            ["alerts": Array(repeating: alerts[0], count: 101)]
        ]
        for patch in patches {
            raw = original.merging(patch) { _, next in next }
            await failure(.invalidMessages) { try await client.messageAlerts(for: enrollment) }
        }
        raw = original
        await failure(.invalidMessages) { try await client.messageAlerts(for: enrollment, after: "9007199254740993") }
        let count = requests.count
        await failure(.invalidMessageInput) { try await client.messageAlerts(for: enrollment, after: "01") }
        XCTAssertEqual(requests.count, count)
        XCTAssertEqual(Set(store.values.keys), Set(saved.keys))
        XCTAssertEqual(store.values.filter { !$0.key.hasSuffix(".authentication") }, saved.filter { !$0.key.hasSuffix(".authentication") })
        raw["alerts"] = (1...100).map { ["conversationId": UUID().uuidString, "sequence": String($0), "expiresAt": expiry] }
        raw["nextCursor"] = "100"
        let fullPage = try await client.messageAlerts(for: enrollment)
        XCTAssertEqual(fullPage.nextCursor, "100"); XCTAssertEqual(fullPage.alerts.count, 100)
        let started = expectation(description: "Desktop alert request pending"); var pending: CallHTTP?
        handler = { request in
            guard request.request.url?.path.hasSuffix("/messages/alerts") == true else { return false }
            pending = request; started.fulfill(); return true
        }
        let loading = Task { try await client.messageAlerts(for: enrollment) }
        await fulfillment(of: [started], timeout: 3)
        try await client.disconnect(enrollment); pending?.reply(original)
        await failure(.accessUnavailable("This managed device is unavailable.")) { try await loading.value }
    }

    private func meetingRecord(_ id: UUID, conversation: UUID) -> [String: Any] {
        let now = Date(), formatter = ISO8601DateFormatter()
        return ["id": id.uuidString, "conversationId": conversation.uuidString, "createdBy": "fixture-member",
            "createdAt": formatter.string(from: now), "expiresAt": formatter.string(from: now.addingTimeInterval(86_400)), "endedAt": NSNull(), "controlConfirmedAt": NSNull()]
    }
    private func meetingGrant(_ id: UUID, session: UUID, claimsChange: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        let expiry = Int(Date().timeIntervalSince1970) + 90, identity = "sipper:\(session.uuidString.lowercased())"
        var claims: [String: Any] = ["iss": "fictional-key", "sub": identity, "nbf": expiry - 90, "exp": expiry,
            "video": ["room": "sipper-\(id.uuidString.lowercased())", "roomJoin": true, "canSubscribe": true, "canPublish": true,
                "canPublishData": false, "canUpdateOwnMetadata": false, "canPublishSources": ["microphone", "camera", "screen_share", "screen_share_audio"]]]
        claimsChange(&claims)
        let encode: (Data) -> String = { $0.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        let header = encode(try JSONSerialization.data(withJSONObject: ["alg": "HS256"]))
        let payload = encode(try JSONSerialization.data(withJSONObject: claims))
        // Shaped grant only: the intercepted HTTP fixture does not prove signature/media acceptance.
        return ["schemaVersion": 1, "organisationId": organisationID.uuidString, "meetingId": id.uuidString, "sessionId": session.uuidString,
            "identity": identity, "url": "wss://meet.example.invalid", "token": "\(header).\(payload).\(encode(Data(repeating: 0, count: 32)))",
            "expiresAt": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(expiry)))]
    }
    func testNativeMeetingMetadataExpiresAndPhoneAudioRefusalCannotJoin() async throws {
        let (client, entry) = try await signedIn(), id = UUID(), conversation = UUID()
        let record = meetingRecord(id, conversation: conversation)
        handler = { request in
            guard request.request.url!.path.contains("/conferencing/") else { return false }
            var response = self.messageScope
            response["meeting"] = record; response["available"] = true
            if !request.request.url!.path.hasSuffix("/meeting") {
                response.merge(["canJoin": true, "title": "Fictional meeting", "hostName": "Fixture host", "sessions": []]) { _, next in next }
            }
            request.reply(response); return true
        }
        var released = 0
        let screen = ManagedMeetingSession(client: client, enrollment: entry, conversationID: conversation,
            claimAudio: { false }, releaseAudio: { released += 1 })
        await screen.refresh()
        XCTAssertTrue(screen.canJoin); XCTAssertTrue(screen.host)
        let count = requests.count
        screen.join()
        XCTAssertEqual(requests.count, count); XCTAssertFalse(screen.joining); XCTAssertNil(screen.room)
        XCTAssertEqual(released, 0); XCTAssertTrue(screen.error?.contains("phone call") == true)
        screen.clearExpiredMetadata(now: Date().addingTimeInterval(31))
        XCTAssertNil(screen.details); XCTAssertNil(screen.current); XCTAssertFalse(screen.canJoin); XCTAssertFalse(screen.canControl)
        await screen.refresh(); XCTAssertTrue(screen.canJoin)
        try await client.disconnect(entry)
        await screen.refresh(); await screen.waitForStop()
        XCTAssertFalse(screen.authorised); XCTAssertNil(screen.details); XCTAssertNil(screen.current)
    }
    func testNativeMeetingCancellationWithdrawsExactPendingSessionBeforeReleasingAudio() async throws {
        let store = CallStore(), (client, entry) = try await signedIn(store), id = UUID(), conversation = UUID()
        let record = meetingRecord(id, conversation: conversation)
        var held: CallHTTP?, joined: UUID?, leaves: [UUID] = [], claimed = false
        handler = { request in
            let path = request.request.url!.path
            guard path.contains("/conferencing/") else { return false }
            var response = self.messageScope
            if path.hasSuffix("/join") {
                joined = UUID(uuidString: try! self.body(request.request)["id"] as! String)
                held = request; return true
            }
            if path.hasSuffix("/leave") {
                let sessionID = UUID(uuidString: path.split(separator: "/").dropLast().last!.description)!
                leaves.append(sessionID)
                XCTAssertTrue(claimed, "Phone audio cannot be released before pending join cleanup")
                response.merge(["meetingId": id.uuidString, "sessionId": sessionID.uuidString, "leaveRequested": true]) { _, next in next }
            } else {
                response["available"] = true; response["meeting"] = record
                if !path.hasSuffix("/meeting") { response.merge(["canJoin": true, "title": "Fictional meeting", "hostName": "Fixture host", "sessions": []]) { _, next in next } }
            }
            request.reply(response); return true
        }
        let screen = ManagedMeetingSession(client: client, enrollment: entry, conversationID: conversation,
            claimAudio: { claimed = true; return true }, releaseAudio: { claimed = false })
        await screen.refresh(); screen.join()
        for _ in 0..<100 where held == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(held); XCTAssertTrue(claimed)
        screen.stop()
        XCTAssertTrue(claimed); XCTAssertTrue(screen.stopping); XCTAssertFalse(screen.canJoin)
        if let held, let joined { held.reply(try meetingGrant(id, session: joined)) }
        await screen.waitForStop()
        XCTAssertEqual(leaves, [try XCTUnwrap(joined)]); XCTAssertFalse(claimed)
        XCTAssertNil(screen.room); XCTAssertFalse(screen.stopping); XCTAssertFalse(screen.joining)
        XCTAssertFalse(store.values.values.contains { String(data: $0, encoding: .utf8)?.contains("sipper:" + joined!.uuidString.lowercased()) == true })
    }
    func testMeetingLifecycleKeepsExactRetryIdentitiesAndDoesNotArchiveMediaAuthority() async throws {
        let store = CallStore(), (client, entry) = try await signedIn(store), id = UUID(), conversation = UUID(), nonce = UUID(), session = UUID()
        let saved = store.values, record = meetingRecord(id, conversation: conversation), grant = try meetingGrant(id, session: session)
        var starts: [[String: Any]] = [], joins: [[String: Any]] = [], removedUser = "alex-fixture"
        handler = { request in
            let path = request.request.url!.path
            guard path.contains("/conferencing/") else { return false }
            var response = self.messageScope
            if path.hasSuffix("/meeting") {
                if request.request.httpMethod == "POST" { starts.append(try! self.body(request.request)) }
                response["available"] = true; response["meeting"] = record
            } else if path.hasSuffix("/join") { joins.append(try! self.body(request.request)); response = grant }
            else if path.hasSuffix("/leave") { response["meetingId"] = id.uuidString; response["sessionId"] = session.uuidString; response["leaveRequested"] = true }
            else if request.request.httpMethod == "DELETE" {
                let expected = removedUser.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"))!
                XCTAssertTrue(URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)!.percentEncodedPath.hasSuffix("/people/\(expected)"))
                response["meetingId"] = id.uuidString; response["targetUserId"] = removedUser; response["removalRequested"] = true
            }
            else if path.hasSuffix("/end") { var ended = record; ended["endedAt"] = ISO8601DateFormatter().string(from: Date()); response["meeting"] = ended }
            else {
                response.merge(["meeting": record, "available": true, "canJoin": true, "title": "Fictional meeting", "hostName": "Fixture host", "sessions": []]) { _, next in next }
            }
            request.reply(response); return true
        }
        let current = try await client.currentMeeting(conversationID: conversation, for: entry); XCTAssertEqual(current.meeting?.id, id)
        for _ in 0..<2 {
            let started = try await client.startMeeting(id: nonce, conversationID: conversation, for: entry); XCTAssertEqual(started.meeting?.id, id, "An already-open room may have a different ID")
            let joined = try await client.joinMeeting(id, sessionID: session, for: entry); XCTAssertEqual(joined.sessionId, session)
        }
        XCTAssertEqual(starts[0] as NSDictionary, starts[1] as NSDictionary); XCTAssertEqual(starts[0]["id"] as? String, nonce.uuidString)
        XCTAssertEqual(joins[0] as NSDictionary, joins[1] as NSDictionary)
        let details = try await client.meetingDetails(id, for: entry); XCTAssertTrue(details.canJoin)
        try await client.leaveMeeting(id, sessionID: session, for: entry)
        try await client.removeMeetingPerson("alex-fixture", meetingID: id, for: entry)
        removedUser = "alèx/fixture?x#y%z"
        try await client.removeMeetingPerson(removedUser, meetingID: id, for: entry)
        let ended = try await client.endMeeting(id, for: entry); XCTAssertNotNil(ended.endedAt); XCTAssertNil(ended.controlConfirmedAt)
        let count = requests.count
        await failure(.invalidMeeting) { try await client.removeMeetingPerson(entry.userID, meetingID: id, for: entry) }
        XCTAssertEqual(requests.count, count)
        XCTAssertEqual(Set(store.values.keys), Set(saved.keys))
        XCTAssertEqual(store.values.filter { !$0.key.hasSuffix(".authentication") }, saved.filter { !$0.key.hasSuffix(".authentication") })
        XCTAssertFalse(store.values.values.contains { String(data: $0, encoding: .utf8)?.contains(grant["token"] as! String) == true })
    }
    func testMeetingGrantsAndDetailsRejectForeignExpiredOrBroaderAuthority() async throws {
        let (client, entry) = try await signedIn(), id = UUID(), conversation = UUID(), session = UUID()
        let good = try meetingGrant(id, session: session)
        var raw = good
        handler = { request in
            guard request.request.url?.path.contains("/conferencing/") == true else { return false }
            request.reply(raw); return true
        }
        for change in [
            { $0["organisationId"] = UUID().uuidString }, { $0["meetingId"] = UUID().uuidString }, { $0["sessionId"] = UUID().uuidString },
            { $0["identity"] = "other-person" }, { $0["schemaVersion"] = 2 }, { $0["expiresAt"] = "2099-01-01T00:00:00Z" },
            { $0["expiresAt"] = "2020-01-01T00:00:00Z" }, { $0["token"] = "unsigned" },
            { $0["url"] = "ws://localhost:1234" }, { $0["url"] = "wss://user:secret@meet.example.invalid" },
            { $0["url"] = "wss://meet.example.invalid/rtc" }, { $0["url"] = "wss://meet.example.invalid/?token=anything" }, { $0["url"] = "wss://meet.example.invalid/#fragment" }
        ] as [(inout [String: Any]) -> Void] {
            raw = good; change(&raw)
            await failure(.invalidMeeting) { try await client.joinMeeting(id, sessionID: session, for: entry) }
        }
        for change in [
            { $0["sub"] = "other-session" }, { $0["sip"] = ["admin": true] }, { $0["nbf"] = Int(Date().timeIntervalSince1970) + 300 },
            { claims in var v = claims["video"] as! [String: Any]; v["roomAdmin"] = true; claims["video"] = v },
            { claims in var v = claims["video"] as! [String: Any]; v["canPublishData"] = true; claims["video"] = v },
            { claims in var v = claims["video"] as! [String: Any]; v["canPublishSources"] = ["microphone", "camera", "camera", "screen_share_audio"]; claims["video"] = v },
            { claims in var v = claims["video"] as! [String: Any]; v["canSubscribe"] = 1; claims["video"] = v }
        ] as [(inout [String: Any]) -> Void] {
            raw = try meetingGrant(id, session: session, claimsChange: change)
            await failure(.invalidMeeting) { try await client.joinMeeting(id, sessionID: session, for: entry) }
        }
        let record = meetingRecord(id, conversation: conversation)
        let details = messageScope.merging(["available": true, "canJoin": true, "title": "Fixture", "hostName": NSNull(), "meeting": record, "sessions": []]) { _, next in next }
        let recordedSession: [String: Any] = ["id": session.uuidString, "userId": entry.userID, "name": "Fixture", "deviceId": entry.deviceID.uuidString, "revokedAt": NSNull(), "admittedAt": NSNull(), "controlConfirmedAt": NSNull()]
        for patch in [["userId": "other-user"], ["deviceId": UUID().uuidString], ["available": false], ["title": "\0"],
            ["expiresAt": "2020-01-01T00:00:00Z"], ["expiresAt": "2099-01-01T00:00:00Z"],
            ["meeting": meetingRecord(UUID(), conversation: conversation)], ["sessions": [recordedSession, recordedSession]],
            ["sessions": Array(repeating: recordedSession, count: 101)]
        ] as [[String: Any]] {
            raw = details.merging(patch) { _, next in next }
            await failure(.invalidMeeting) { try await client.meetingDetails(id, for: entry) }
        }
        var ended = record; ended["endedAt"] = ISO8601DateFormatter().string(from: Date())
        raw = details; raw["meeting"] = ended
        await failure(.invalidMeeting) { try await client.meetingDetails(id, for: entry) }
        raw = messageScope; raw["meetingId"] = id.uuidString; raw["sessionId"] = UUID().uuidString; raw["leaveRequested"] = true
        await failure(.invalidMeeting) { try await client.leaveMeeting(id, sessionID: session, for: entry) }
        raw = messageScope; raw["meetingId"] = id.uuidString; raw["targetUserId"] = "other-user"; raw["removalRequested"] = true
        await failure(.invalidMeeting) { try await client.removeMeetingPerson("alex-fixture", meetingID: id, for: entry) }
        raw["targetUserId"] = "alex-fixture"; raw["userId"] = "alex-fixture"
        await failure(.invalidMeeting) { try await client.removeMeetingPerson("alex-fixture", meetingID: id, for: entry) }
        let decoded = try ManagedClient.configurationDecoder().decode(ManagedMeetingGrant.self, from: JSONSerialization.data(withJSONObject: good.merging(["url": "ws://127.0.0.1:1234"]) { _, next in next }))
        XCTAssertThrowsError(try decoded.validate(for: entry, meetingID: id, sessionID: session, allowLocalDevelopment: false))
        XCTAssertNoThrow(try decoded.validate(for: entry, meetingID: id, sessionID: session, allowLocalDevelopment: true))
        handler = { request in
            guard request.request.url?.path.contains("/conferencing/") == true else { return false }
            request.reply([:], status: 429); return true
        }
        await failure(.meetingRateLimit) { try await client.joinMeeting(id, sessionID: session, for: entry) }
    }
    func testLateMeetingGrantCannotSurviveWithdrawalOrDisconnectedOwnership() async throws {
        let (client, entry) = try await signedIn(), id = UUID(), session = UUID()
        var held: CallHTTP?, withdrawn = false
        let started = expectation(description: "Meeting grant is pending")
        handler = { request in
            if request.request.url?.path.contains("/conferencing/") == true { held = request; started.fulfill(); return true }
            if withdrawn, request.request.url?.path.hasSuffix("/organisations") == true {
                var org = self.organisation; org["licensed"] = false
                request.reply(["user": ["id": entry.userID, "email": "member@example.invalid"], "organisations": [org]]); return true
            }
            return false
        }
        let pending = Task { try await client.joinMeeting(id, sessionID: session, for: entry) }
        await fulfillment(of: [started], timeout: 3)
        withdrawn = true; try await client.refreshOrganisations(); held?.reply(try meetingGrant(id, session: session))
        await failure(.meetingUnavailable) { try await pending.value }
        handler = nil; try await client.disconnect(entry)
        let count = requests.count
        await failure { try await client.currentMeeting(conversationID: UUID(), for: entry) }
        XCTAssertEqual(requests.count, count)
        try await client.signOut()
        await failure(.signInRequired) { try await client.joinMeeting(id, sessionID: session, for: entry) }
    }
    func testMessagingScopesPlainTextAndPaginationAreStrictAndNeverArchived() async throws {
        let store = CallStore(), (client, enrollment) = try await signedIn(store), id = UUID(), nonce = UUID()
        let before = "9007199254740994", text = "Line one\n<b>literal markup</b> 🌱", previousStorage = store.values
        var sentIDs: [String] = [], read = false
        handler = { request in
            let path = request.request.url!.path.lowercased()
            guard path.contains("/messages/") else { return false }
            XCTAssertTrue(path.hasPrefix("/api/client/devices/\(enrollment.deviceID.uuidString.lowercased())/messages/"))
            var value = self.messageScope
            if path.hasSuffix("/people") {
                XCTAssertEqual(URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "Alex")
                value["people"] = [["id": "alex-fixture", "name": "Alex fixture"]]; value["nextCursor"] = NSNull()
            } else if path.hasSuffix("/read") {
                XCTAssertEqual(request.request.httpMethod, "POST"); XCTAssertEqual(try! self.body(request.request)["sequence"] as? String, before)
                value["sequence"] = "9223372036854775807"; read = true
            } else if path.hasSuffix("/conversations") {
                if request.request.httpMethod == "POST" {
                    XCTAssertEqual(try! self.body(request.request)["userIds"] as? [String], ["alex-fixture"])
                    value["conversation"] = self.messageConversation(id)
                } else { value["conversations"] = [self.messageConversation(id)]; value["nextCursor"] = NSNull() }
            } else if request.request.httpMethod == "POST" {
                let body = try! self.body(request.request); XCTAssertEqual(body["text"] as? String, text); sentIDs.append(body["id"] as! String)
                value["message"] = self.textMessage(nonce, text: text, sender: enrollment.userID)
            } else {
                XCTAssertEqual(URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, before)
                value["conversation"] = self.messageConversation(id); value["messages"] = [self.textMessage()]; value["nextCursor"] = NSNull()
            }
            request.reply(value); return true
        }
        let people = try await client.messagePeople(for: enrollment, search: "Alex")
        XCTAssertEqual(people.people[0].name, "Alex fixture"); XCTAssertLessThanOrEqual(people.scope.expiresAt.timeIntervalSinceNow, 30)
        let threads = try await client.conversations(for: enrollment); XCTAssertEqual(threads.conversations[0].lastSequence, before)
        let direct = try await client.createConversation(id: UUID(), userIDs: ["alex-fixture"], for: enrollment)
        XCTAssertEqual(direct.id, id, "An existing direct pair can have a different creation UUID")
        let history = try await client.conversationMessages(id, for: enrollment, before: before)
        XCTAssertEqual(history.messages[0].sequence, "9007199254740993"); XCTAssertEqual(history.messages[0].text, "Plain markup <b>hello</b>\n🌱")
        let sent = try await client.sendMessage(id: nonce, text: text, conversationID: id, for: enrollment)
        let retried = try await client.sendMessage(id: nonce, text: text, conversationID: id, for: enrollment)
        XCTAssertEqual(retried, sent); XCTAssertEqual(sentIDs, [nonce.uuidString, nonce.uuidString])
        try await client.markConversationRead(id, sequence: before, for: enrollment); XCTAssertTrue(read)
        XCTAssertEqual(Set(store.values.keys), Set(previousStorage.keys), "No message, recipient or read-state archive")
        XCTAssertFalse(store.values.values.contains { String(data: $0, encoding: .utf8)?.contains(text) == true })
        let count = requests.count
        await failure(.invalidMessageInput) { try await client.sendMessage(id: UUID(), text: "\0", conversationID: id, for: enrollment) }
        await failure(.invalidMessageInput) { try await client.sendMessage(id: UUID(), text: String(repeating: "🌱", count: 2049), conversationID: id, for: enrollment) }
        await failure(.invalidMessageInput) { try await client.conversationMessages(id, for: enrollment, before: "1", after: "2") }
        await failure(.invalidMessageInput) { try await client.createConversation(id: UUID(), userIDs: [enrollment.userID], for: enrollment) }
        await failure(.invalidMessageInput) { try await client.createConversation(id: UUID(), userIDs: ["alex-fixture", "bea-fixture"], for: enrollment) }
        XCTAssertEqual(requests.count, count)
    }
    func testMessagingRejectsWrongScopeMalformedSequencesRecipientsAndExpiredPages() async throws {
        let (client, enrollment) = try await signedIn(), id = UUID()
        var raw = messageScope; raw["conversation"] = messageConversation(id); raw["messages"] = [textMessage()]; raw["nextCursor"] = NSNull()
        handler = { request in
            guard request.request.url?.path.contains("/messages/") == true else { return false }
            request.reply(raw); return true
        }
        for change in [
            { $0["userId"] = "another-user" }, { $0["deviceId"] = UUID().uuidString },
            { $0["organisation"] = ["id": UUID().uuidString, "name": "Other customer"] },
            { $0["expiresAt"] = "2020-01-01T00:00:00Z" }, { $0["expiresAt"] = "2099-01-01T00:00:00Z" },
            { $0["schemaVersion"] = 2 }, { $0["retentionDays"] = 0 }, { $0["conversation"] = self.messageConversation(UUID()) },
            { $0["messages"] = [self.textMessage(sequence: "01")] }, { $0["messages"] = [self.textMessage(sequence: "9223372036854775808")] },
            { $0["messages"] = [self.textMessage(sequence: "2"), self.textMessage(sequence: "1")] },
            { $0["messages"] = Array(repeating: self.textMessage(), count: 101) }, { $0["nextCursor"] = "1" },
        ] as [(inout [String: Any]) -> Void] {
            let original = raw; change(&raw)
            await failure(.invalidMessages) { try await client.conversationMessages(id, for: enrollment) }; raw = original
        }
        handler = { request in
            guard request.request.url?.path.contains("/messages/") == true else { return false }
            request.reply([:], status: 429); return true
        }
        await failure(.messageRateLimit) { try await client.conversations(for: enrollment) }
        handler = { request in
            guard request.request.url?.path.contains("/messages/") == true else { return false }
            var value = self.messageScope; value["people"] = [["id": "alex-fixture", "name": "Alex"], ["id": "alex-fixture", "name": "Duplicate"]]
            value["nextCursor"] = NSNull(); request.reply(value); return true
        }
        await failure(.invalidMessages) { try await client.messagePeople(for: enrollment) }
    }
    func testLateMessagingCannotSurviveObservedWithdrawalOrUseADisconnectedSignedOutDevice() async throws {
        let (client, enrollment) = try await signedIn(), id = UUID()
        var held: CallHTTP?, withdrawn = false
        let started = expectation(description: "Message history is pending")
        handler = { request in
            if request.request.url?.path.contains("/messages/") == true { held = request; started.fulfill(); return true }
            if withdrawn, request.request.url?.path.hasSuffix("/organisations") == true {
                var organisation = self.organisation; organisation["status"] = "suspended"
                request.reply(["user": ["id": enrollment.userID, "email": "member@example.invalid"], "organisations": [organisation]]); return true
            }
            return false
        }
        let task = Task { try await client.conversationMessages(id, for: enrollment) }
        await fulfillment(of: [started], timeout: 3)
        withdrawn = true; try await client.refreshOrganisations()
        var raw = messageScope; raw["conversation"] = messageConversation(id); raw["messages"] = [textMessage()]; raw["nextCursor"] = NSNull()
        held?.reply(raw)
        await failure(.accessUnavailable("Messaging is unavailable for this customer.")) { try await task.value }
        handler = nil; try await client.disconnect(enrollment)
        let count = requests.count
        await failure { try await client.conversations(for: enrollment) }; XCTAssertEqual(requests.count, count)
        try await client.signOut()
        await failure(.signInRequired) { try await client.conversationMessages(id, for: enrollment) }
    }
}
