import XCTest
@testable import SipperManaged

final class ConfigurationTests: XCTestCase {
    private let organisationID = UUID(), deviceID = UUID(), accountID = UUID()
    private func fixture(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> ManagedConfiguration {
        var object: [String: Any] = [
            "schemaVersion": 1, "organisation": ["id": organisationID.uuidString, "name": "Example customer"],
            "deviceId": deviceID.uuidString, "revision": String(repeating: "a", count: 64),
            "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
            "accounts": [["id": accountID.uuidString, "label": "Fixture extension", "mode": "direct", "revision": 1, "password": "fictional-fixture",
                          "settings": ["username": "100", "authUsername": "", "domain": "pbx.example.invalid", "server": "sip.example.invalid", "port": NSNull(),
                                       "transport": "tls", "srtp": "required", "displayName": "Example", "voicemailNumber": "*97", "useICE": true, "stunServer": ""]]],
        ]
        change(&object)
        return try ManagedClient.configurationDecoder().decode(ManagedConfiguration.self, from: JSONSerialization.data(withJSONObject: object))
    }
    @MainActor func testValidConfigurationAndFractionalTimestamps() throws {
        let config = try fixture { $0["expiresAt"] = ISO8601DateFormatter.sipperFractional.string(from: Date().addingTimeInterval(3600)) }
        XCTAssertNoThrow(try config.validate(organisationID: organisationID, deviceID: deviceID))
        XCTAssertEqual(config.accounts.first?.settings.transport, "tls")
    }
    func testDirectCallingPreferenceDecodesStrictlyAndSurvivesTheProtectedCacheFormat() throws {
        XCTAssertNil(try fixture().accounts[0].doNotDisturb)
        for value in [true, false, "true", 1, NSNull()] as [Any] {
            let read = { try self.fixture { raw in
                var accounts = raw["accounts"] as! [[String: Any]]
                accounts[0]["doNotDisturb"] = value; raw["accounts"] = accounts
            } }
            if type(of: value) == Bool.self {
                let config = try read(), encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
                let restored = try ManagedClient.configurationDecoder().decode(ManagedConfiguration.self, from: encoder.encode(config))
                XCTAssertEqual(restored.accounts[0].doNotDisturb, value as? Bool)
            } else { XCTAssertThrowsError(try read()) }
        }
    }
    @MainActor func testConfigurationCannotBeReusedForAnotherCustomerOrDevice() throws {
        let config = try fixture()
        XCTAssertThrowsError(try config.validate(organisationID: UUID(), deviceID: deviceID))
        XCTAssertThrowsError(try config.validate(organisationID: organisationID, deviceID: UUID()))
    }
    @MainActor func testExpiredAndUnsupportedConfigurationsAreRejected() throws {
        let expired = try fixture { $0["expiresAt"] = "2020-01-01T00:00:00.000Z" }
        XCTAssertThrowsError(try expired.validate(organisationID: organisationID, deviceID: deviceID))
        let future = try fixture { $0["schemaVersion"] = 99 }
        XCTAssertThrowsError(try future.validate(organisationID: organisationID, deviceID: deviceID))
    }
    @MainActor func testDuplicateAccountsAndUnreasonableExpiryAreRejected() throws {
        let duplicated = try fixture { data in let accounts = data["accounts"] as! [[String: Any]]; data["accounts"] = accounts + accounts }
        XCTAssertThrowsError(try duplicated.validate(organisationID: organisationID, deviceID: deviceID))
        let future = try fixture { $0["expiresAt"] = "2099-01-01T00:00:00Z" }
        XCTAssertThrowsError(try future.validate(organisationID: organisationID, deviceID: deviceID))
    }
    @MainActor func testUnsafeServerURLsAreRejectedAndLocalDevelopmentIsExplicit() throws {
        let store = MemoryStore()
        for value in ["http://sipper.dev", "https://user:password@sipper.dev", "https://sipper.dev/path", "https://sipper.dev?key=anything"] {
            XCTAssertThrowsError(try ManagedClient(serverURL: URL(string: value)!, clientID: "sipper-macos", storage: store))
        }
        XCTAssertThrowsError(try ManagedClient(serverURL: URL(string: "http://localhost:3100")!, clientID: "sipper-macos", storage: store))
        XCTAssertNoThrow(try ManagedClient(serverURL: URL(string: "http://localhost:3100")!, clientID: "sipper-macos", storage: store, allowLocalDevelopment: true))
    }
    func testGatewayAccountsRequireTLSAndMandatorySRTP() throws {
        for (transport, srtp, accepted) in [("tls", "required", true), ("tcp", "required", false), ("udp", "required", false), ("tls", "optional", false), ("tls", "disabled", false)] {
            let config = try fixture { data in
                var accounts = data["accounts"] as! [[String: Any]]
                accounts[0]["mode"] = "gateway"
                var settings = accounts[0]["settings"] as! [String: Any]
                settings["transport"] = transport; settings["srtp"] = srtp
                accounts[0]["settings"] = settings; data["accounts"] = accounts
            }
            if accepted { XCTAssertNoThrow(try config.validate(organisationID: organisationID, deviceID: deviceID)) }
            else { XCTAssertThrowsError(try config.validate(organisationID: organisationID, deviceID: deviceID)) }
        }
    }
}
private final class MemoryStore: ManagedSecretStore {
    var values: [String: Data] = [:]
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ data: Data, key: String) throws { values[key] = data }
    func remove(_ key: String) throws { values[key] = nil }
}
private extension ISO8601DateFormatter {
    static var sipperFractional: ISO8601DateFormatter { let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value }
}
