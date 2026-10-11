import XCTest
import AppAuth
@testable import SipperManaged

private final class AuthenticationStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ data: Data, key: String) throws { values[key] = data }
    func remove(_ key: String) throws { values[key] = nil }
}

private final class FixtureHTTP: URLProtocol {
    static var user = "fixture-user"
    static var status = 200
    static var organisations: [[String: Any]] = []
    static var handler: ((FixtureHTTP) -> Bool)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if Self.handler?(self) == true { return }
        XCTAssertEqual(request.url?.path, "/api/client/organisations")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-access-token")
        reply(["user": ["id": Self.user, "email": "member@example.invalid"], "organisations": Self.organisations], status: Self.status)
    }
    func reply(_ value: [String: Any], status: Int = 200) {
        let data = try! JSONSerialization.data(withJSONObject: value)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class AuthenticationTests: XCTestCase {
    private func tokenState() -> OIDAuthState {
        let configuration = OIDServiceConfiguration(authorizationEndpoint: URL(string: "https://sipper.example.invalid/api/auth/oauth2/authorize")!, tokenEndpoint: URL(string: "https://sipper.example.invalid/api/auth/oauth2/token")!)
        let request = OIDTokenRequest(configuration: configuration, grantType: OIDGrantTypeAuthorizationCode,
            authorizationCode: "fictional-code", redirectURL: URL(string: "com.hybes.sipper:/oauth/callback"),
            clientID: "sipper-macos", clientSecret: nil, scopes: ["sipper:client"], refreshToken: nil, codeVerifier: "fictional-verifier", additionalParameters: nil)
        let response = OIDTokenResponse(request: request, parameters: ["access_token": "fictional-access-token" as NSString, "token_type": "Bearer" as NSString, "expires_in": 3600 as NSNumber])
        return OIDAuthState(authorizationResponse: nil, tokenResponse: response, registrationResponse: nil)
    }
    private func client(_ store: AuthenticationStore) throws -> ManagedClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureHTTP.self]
        return try ManagedClient(serverURL: URL(string: "https://sipper.example.invalid")!, clientID: "sipper-macos", storage: store, sessionConfiguration: configuration)
    }

    func testCallingPreferencesRequireConfirmationAndBecomeUnknownOnFailure() async throws {
        let org = UUID(), other = UUID()
        FixtureHTTP.status = 200; FixtureHTTP.user = "fixture-user"
        FixtureHTTP.organisations = [org, other].map { ["id": $0.uuidString, "name": "Example customer", "status": "active", "licensed": false, "doNotDisturb": false] }
        defer { FixtureHTTP.organisations = []; FixtureHTTP.handler = nil; FixtureHTTP.status = 200 }
        let store = AuthenticationStore(), client = try client(store)
        try await client.acceptAuthentication(tokenState())
        var response: Any = true, status = 200, writes = 0
        FixtureHTTP.handler = { fixture in
            guard fixture.request.url?.path.hasSuffix("/calling-preference") == true else { return false }
            writes += 1
            XCTAssertEqual(fixture.request.url?.path, "/api/client/organisations/\(org.uuidString)/calling-preference")
            XCTAssertEqual(fixture.request.httpMethod, "PATCH")
            XCTAssertEqual(fixture.request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-access-token")
            fixture.reply(["doNotDisturb": response], status: status); return true
        }
        try await client.setDoNotDisturb(true, organisationID: org)
        XCTAssertEqual(client.organisations[0].doNotDisturb, true); XCTAssertEqual(client.organisations[1].doNotDisturb, false)
        XCTAssertTrue(client.enrollments.isEmpty, "A preference never grants a device or a licence")
        do { try await client.setDoNotDisturb(true, organisationID: UUID()); XCTFail() } catch { XCTAssertEqual(writes, 1) }
        status = 403
        do { try await client.setDoNotDisturb(false, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].doNotDisturb) }
        try await client.refreshOrganisations(); XCTAssertEqual(client.organisations[0].doNotDisturb, false)
        status = 200; response = "true"
        do { try await client.setDoNotDisturb(true, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].doNotDisturb) }
        try await client.refreshOrganisations(); response = false
        do { try await client.setDoNotDisturb(true, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].doNotDisturb) }
        FixtureHTTP.status = 503
        do { try await client.refreshOrganisations(); XCTFail() } catch { XCTAssertTrue(client.organisations.allSatisfy { $0.doNotDisturb == nil }) }
        FixtureHTTP.status = 200; FixtureHTTP.organisations[0]["status"] = "suspended"
        try await client.refreshOrganisations()
        do { try await client.setDoNotDisturb(true, organisationID: org); XCTFail() } catch { XCTAssertEqual(writes, 4) }
        FixtureHTTP.organisations[0]["doNotDisturb"] = nil
        try await client.refreshOrganisations(); XCTAssertNil(client.organisations[0].doNotDisturb, "Missing on an older server means unknown, not Off")
        XCTAssertTrue(try self.client(store).organisations.isEmpty, "Preferences are not restored from an old cached session")
    }

    func testAvailabilityRequiresConfirmationAndDoesNotChangeDoNotDisturb() async throws {
        let org = UUID()
        FixtureHTTP.status = 200; FixtureHTTP.user = "fixture-user"
        FixtureHTTP.organisations = [["id": org.uuidString, "name": "Example customer", "status": "active", "licensed": false, "doNotDisturb": true, "availability": "unset"]]
        defer { FixtureHTTP.organisations = []; FixtureHTTP.handler = nil; FixtureHTTP.status = 200 }
        let store = AuthenticationStore(), client = try client(store)
        try await client.acceptAuthentication(tokenState())
        var response: Any = "away", status = 200
        FixtureHTTP.handler = { fixture in
            guard fixture.request.url?.path.hasSuffix("/calling-preference") == true else { return false }
            fixture.reply(["availability": response], status: status); return true
        }
        try await client.setAvailability(.away, organisationID: org)
        XCTAssertEqual(client.organisations[0].availability, .away)
        XCTAssertEqual(client.organisations[0].doNotDisturb, true)
        do { try await client.setAvailability(.busy, organisationID: UUID()); XCTFail() } catch {}
        response = "available"
        do { try await client.setAvailability(.busy, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].availability) }
        XCTAssertEqual(client.organisations[0].doNotDisturb, true)
        try await client.refreshOrganisations(); status = 503
        do { try await client.setAvailability(.busy, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].availability) }
        try await client.refreshOrganisations(); status = 200; response = "unknown-state"
        do { try await client.setAvailability(.busy, organisationID: org); XCTFail() } catch { XCTAssertNil(client.organisations[0].availability) }
        FixtureHTTP.organisations[0]["availability"] = nil
        try await client.refreshOrganisations()
        do { try await client.setAvailability(.busy, organisationID: org); XCTFail() } catch {}
        XCTAssertTrue(try self.client(store).organisations.isEmpty)
    }

    func testCallingPreferenceWriteSupersedesAnOlderReadAndCannotSurviveSignOut() async throws {
        let org = UUID()
        FixtureHTTP.status = 200; FixtureHTTP.user = "fixture-user"
        FixtureHTTP.organisations = [["id": org.uuidString, "name": "Example customer", "status": "active", "licensed": true, "doNotDisturb": false]]
        defer { FixtureHTTP.organisations = []; FixtureHTTP.handler = nil }
        let client = try client(AuthenticationStore()); try await client.acceptAuthentication(tokenState())
        let readStarted = expectation(description: "Older membership read"), writeStarted = expectation(description: "Pending preference write")
        var heldRead: FixtureHTTP?, heldWrite: FixtureHTTP?, holdWrite = false
        FixtureHTTP.handler = { fixture in
            if fixture.request.url?.path.hasSuffix("/organisations") == true { heldRead = fixture; readStarted.fulfill(); return true }
            if fixture.request.url?.path.hasSuffix("/calling-preference") == true {
                if holdWrite { heldWrite = fixture; writeStarted.fulfill() }
                else { fixture.reply(["doNotDisturb": true]) }
                return true
            }
            return false
        }
        let refresh = Task { try await client.refreshOrganisations() }
        await fulfillment(of: [readStarted], timeout: 3)
        try await client.setDoNotDisturb(true, organisationID: org)
        heldRead?.reply(["user": ["id": "fixture-user", "email": "member@example.invalid"], "organisations": FixtureHTTP.organisations])
        do { try await refresh.value; XCTFail() } catch { XCTAssertEqual(error as? ManagedError, .cancelled) }
        XCTAssertEqual(client.organisations[0].doNotDisturb, true)
        holdWrite = true
        let writing = Task { try await client.setDoNotDisturb(false, organisationID: org) }
        await fulfillment(of: [writeStarted], timeout: 3)
        XCTAssertEqual(client.organisations[0].doNotDisturb, true)
        do { try await client.refreshOrganisations(); XCTFail() } catch { XCTAssertEqual(error as? ManagedError, .cancelled) }
        try await client.signOut()
        heldWrite?.reply(["doNotDisturb": false])
        do { try await writing.value; XCTFail() } catch { XCTAssertEqual(error as? ManagedError, .cancelled) }
        XCTAssertTrue(client.organisations.isEmpty); XCTAssertFalse(client.isSignedIn)
    }

    func testFirstSignInBindsIdentityBeforeSavingAndRestoresIt() async throws {
        FixtureHTTP.user = "fixture-user"; FixtureHTTP.status = 200
        let store = AuthenticationStore(), client = try client(store)
        XCTAssertFalse(client.isSignedIn)
        try await client.acceptAuthentication(tokenState())
        XCTAssertEqual(client.identity?.id, "fixture-user")
        XCTAssertTrue(client.isSignedIn)
        XCTAssertEqual(store.values.count, 1)
        let restored = try self.client(store)
        XCTAssertEqual(restored.identity?.id, "fixture-user")
        XCTAssertTrue(restored.isSignedIn)
    }

    func testDifferentIdentityCannotReplaceExistingSession() async throws {
        FixtureHTTP.user = "fixture-user"; FixtureHTTP.status = 200
        let store = AuthenticationStore(), client = try client(store)
        try await client.acceptAuthentication(tokenState())
        let previous = store.values
        FixtureHTTP.user = "different-user"
        do { try await client.acceptAuthentication(tokenState()); XCTFail("Expected identity rejection") }
        catch { XCTAssertEqual(client.identity?.id, "fixture-user") }
        XCTAssertEqual(store.values, previous)
        XCTAssertEqual(try self.client(store).identity?.id, "fixture-user")
    }

    func testFailedIdentityLookupCannotPersistAnUnboundToken() async throws {
        FixtureHTTP.status = 503
        defer { FixtureHTTP.status = 200 }
        let store = AuthenticationStore(), client = try client(store)
        do { try await client.acceptAuthentication(tokenState()); XCTFail("Expected service failure") }
        catch { XCTAssertFalse(client.isSignedIn); XCTAssertNil(client.identity) }
        XCTAssertTrue(store.values.isEmpty)
    }
}
