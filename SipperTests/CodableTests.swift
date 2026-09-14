import XCTest
@testable import Sipper

final class ModelCodableTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(type, from: Data(json.utf8))
    }

    // MARK: SIPAccount

    func testSIPAccountMinimalJSONAppliesDefaults() throws {
        let profileID = UUID()
        let id = UUID()
        let account = try decode(SIPAccount.self, #"{"id":"\#(id.uuidString)","profileID":"\#(profileID.uuidString)","username":"1001","domain":"pbx.example.com"}"#)
        XCTAssertEqual(account.id, id)
        XCTAssertEqual(account.profileID, profileID)
        XCTAssertEqual(account.transport, .udp)
        XCTAssertNil(account.port)
        XCTAssertTrue(account.isEnabled)
        XCTAssertEqual(account.registrationExpiry, 300)
        XCTAssertEqual(account.srtp, .disabled)
        XCTAssertEqual(account.voicemailNumber, "*97")
        XCTAssertEqual(account.source, "manual")
        XCTAssertEqual(account.label, "")
        XCTAssertFalse(account.useICE)
    }

    func testSIPAccountRequiresIdentityFields() {
        XCTAssertThrowsError(try decode(SIPAccount.self, #"{"id":"\#(UUID().uuidString)","profileID":"\#(UUID().uuidString)","domain":"d"}"#), "username is required")
        XCTAssertThrowsError(try decode(SIPAccount.self, #"{"id":"\#(UUID().uuidString)","profileID":"\#(UUID().uuidString)","username":"u"}"#), "domain is required")
        XCTAssertThrowsError(try decode(SIPAccount.self, #"{"username":"u","domain":"d"}"#), "id and profileID are required")
    }

    func testSIPAccountIgnoresUnknownKeysAndBadEnumValues() throws {
        let account = try decode(SIPAccount.self, #"""
        {"id":"\#(UUID().uuidString)","profileID":"\#(UUID().uuidString)","username":"1001","domain":"d",
         "transport":"sctp","srtp":"maybe","port":"not-a-number","futureField":{"nested":true}}
        """#)
        XCTAssertEqual(account.transport, .udp, "an unknown transport from a newer version falls back to the default")
        XCTAssertEqual(account.srtp, .disabled)
        XCTAssertNil(account.port)
    }

    func testSIPAccountRoundTrip() throws {
        let original = SIPAccount(profileID: UUID(), label: "Desk", displayName: "Alex", username: "1001",
                                  authUsername: "auth", domain: "pbx.example.com", server: "edge.example.com",
                                  port: 5080, transport: .tls, isEnabled: false, registrationExpiry: 600,
                                  srtp: .mandatory, stunServer: "stun.example.com", useICE: true,
                                  voicemailNumber: "*98", callerIDName: "Alex", callerIDNumber: "0207",
                                  notes: "n", sortOrder: 3, createdAt: TestSupport.fixedDate, source: "fusionpbx")
        let decoded = try decoder.decode(SIPAccount.self, from: encoder.encode(original))
        XCTAssertEqual(decoded, original)
    }

    // MARK: Profile

    func testProfileMinimalJSONAppliesDefaults() throws {
        let id = UUID()
        let profile = try decode(Profile.self, #"{"id":"\#(id.uuidString)"}"#)
        XCTAssertEqual(profile.id, id)
        XCTAssertEqual(profile.name, "Profile")
        XCTAssertEqual(profile.colorName, .blue)
        XCTAssertEqual(profile.iconName, "building.2")
        XCTAssertTrue(profile.isEnabled)
        XCTAssertEqual(profile.sortOrder, 0)
        XCTAssertThrowsError(try decode(Profile.self, #"{"name":"No id"}"#))
    }

    func testProfileUnknownColorFallsBack() throws {
        let profile = try decode(Profile.self, #"{"id":"\#(UUID().uuidString)","name":"Work","colorName":"chartreuse","extra":1}"#)
        XCTAssertEqual(profile.name, "Work")
        XCTAssertEqual(profile.colorName, .blue)
    }

    func testProfileRoundTrip() throws {
        let original = Profile(name: "Work", colorName: .teal, iconName: "briefcase", isEnabled: false, sortOrder: 2, createdAt: TestSupport.fixedDate)
        XCTAssertEqual(try decoder.decode(Profile.self, from: encoder.encode(original)), original)
    }

    // MARK: CallRecord

    func testCallRecordMinimalJSONAppliesDefaults() throws {
        let id = UUID()
        let accountID = UUID()
        let record = try decode(CallRecord.self, #"{"id":"\#(id.uuidString)","accountID":"\#(accountID.uuidString)"}"#)
        XCTAssertEqual(record.id, id)
        XCTAssertEqual(record.accountID, accountID)
        XCTAssertEqual(record.direction, .outgoing)
        XCTAssertEqual(record.outcome, .failed)
        XCTAssertEqual(record.remoteNumber, "")
        XCTAssertNil(record.connectedAt)
        XCTAssertNil(record.endedAt)
        XCTAssertEqual(record.statusCode, 0)
        XCTAssertEqual(record.duration, 0)
        XCTAssertFalse(record.wasMissed)
    }

    func testCallRecordUnknownOutcomeFallsBack() throws {
        let record = try decode(CallRecord.self, #"{"id":"\#(UUID().uuidString)","accountID":"\#(UUID().uuidString)","direction":"incoming","outcome":"voicemail"}"#)
        XCTAssertEqual(record.direction, .incoming)
        XCTAssertEqual(record.outcome, .failed)
    }

    func testCallRecordRoundTripAndDerivedValues() throws {
        let start = TestSupport.fixedDate
        let original = CallRecord(accountID: UUID(), direction: .incoming, outcome: .completed, remoteNumber: "2001",
                                  remoteName: "Alice", remoteURI: "sip:2001@pbx.example.com", startedAt: start,
                                  connectedAt: start.addingTimeInterval(5), endedAt: start.addingTimeInterval(35),
                                  statusCode: 200, statusText: "OK")
        let decoded = try decoder.decode(CallRecord.self, from: encoder.encode(original))
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.duration, 30)
        XCTAssertEqual(decoded.displayName, "Alice")
        XCTAssertFalse(decoded.wasMissed)

        let missed = CallRecord(accountID: UUID(), direction: .incoming, outcome: .missed, remoteNumber: "2001")
        XCTAssertTrue(missed.wasMissed)
        XCTAssertEqual(missed.displayName, "2001")
        XCTAssertFalse(CallRecord(accountID: UUID(), direction: .outgoing, outcome: .missed, remoteNumber: "1").wasMissed,
                       "only incoming calls can be missed")
    }

    // MARK: Contact

    func testContactMinimalJSONAndNumbersDefaults() throws {
        let contact = try decode(Contact.self, #"{"id":"\#(UUID().uuidString)","name":"Bob","numbers":[{"number":"2001"}]}"#)
        XCTAssertEqual(contact.name, "Bob")
        XCTAssertEqual(contact.numbers.count, 1)
        XCTAssertEqual(contact.numbers[0].label, "Work")
        XCTAssertEqual(contact.primaryNumber, "2001")
        XCTAssertFalse(contact.isFavorite)
        XCTAssertNil(contact.preferredAccountID)
    }

    func testContactRoundTripAndHelpers() throws {
        let original = Contact(name: "Alex Morgan", company: "Example Ltd", numbers: [ContactNumber(label: "Mobile", number: "07700 900123")],
                               preferredAccountID: UUID(), isFavorite: true, notes: "n", createdAt: TestSupport.fixedDate)
        XCTAssertEqual(try decoder.decode(Contact.self, from: encoder.encode(original)), original)
        XCTAssertEqual(original.initials, "AM")
        XCTAssertEqual(Contact(name: "alice").initials, "A")
        XCTAssertEqual(Contact(name: "").initials, "")
        XCTAssertTrue(original.matches(number: "07700-900-123"))
        XCTAssertFalse(original.matches(number: "+447700900123"), "a leading + is significant")
        XCTAssertFalse(original.matches(number: ""))
    }

    // MARK: AppSettings

    func testAppSettingsFromEmptyObjectEqualsDefaults() throws {
        XCTAssertEqual(try decode(AppSettings.self, "{}"), AppSettings())
    }

    func testAppSettingsPartialAndInvalidValues() throws {
        let settings = try decode(AppSettings.self, #"{"ringVolume":0.25,"ringtone":"bagpipes","defaultTransport":"tls","sipLogLevel":"loud","unknownSetting":true}"#)
        XCTAssertEqual(settings.ringVolume, 0.25)
        XCTAssertEqual(settings.ringtone, .classicUK, "unknown ringtone falls back to the default")
        XCTAssertEqual(settings.defaultTransport, .tls)
        XCTAssertEqual(settings.sipLogLevel, 4, "wrong type falls back to the default")
        XCTAssertTrue(settings.showNotifications)

        let echo = try decode(AppSettings.self, #"{"echoMode":"bogus","echoCancellation":false}"#)
        XCTAssertEqual(echo.echoMode, AppSettings().echoMode, "an unknown echo mode (or the retired boolean key) falls back to the default")
        XCTAssertEqual(try decode(AppSettings.self, #"{"echoMode":"off"}"#).echoMode, .off)
    }

    func testAppSettingsRoundTrip() throws {
        var settings = AppSettings()
        settings.inputDeviceName = "Mic"
        settings.codecs = [CodecPreference(codecID: "opus/48000/2", isEnabled: true), CodecPreference(codecID: "PCMU/8000/1", isEnabled: false)]
        settings.lastUsedAccountID = UUID()
        settings.localTLSPort = 5061
        settings.doNotDisturb = true
        XCTAssertEqual(try decoder.decode(AppSettings.self, from: encoder.encode(settings)), settings)
    }
}

final class PersistenceStoreTests: XCTestCase {
    private var directory: URL!
    private var store: PersistenceStore!

    override func setUp() {
        super.setUp()
        directory = TestSupport.makeTemporaryDirectory(for: self)
        store = PersistenceStore(directory: directory)
    }

    func testCreatesDirectoryAndReturnsNilForMissingFiles() {
        let nested = directory.appendingPathComponent("nested/deeper", isDirectory: true)
        let nestedStore = PersistenceStore(directory: nested)
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: nested.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        XCTAssertNil(nestedStore.load([Profile].self, from: StoreFile.profiles))
    }

    func testRoundTripsModelsWithDates() throws {
        let profile = Profile(name: "Work", colorName: .green, createdAt: TestSupport.fixedDate)
        let account = SIPAccount(profileID: profile.id, username: "1001", domain: "pbx.example.com", port: 5080,
                                 transport: .tcp, createdAt: TestSupport.fixedDate)
        let record = CallRecord(accountID: account.id, direction: .incoming, outcome: .completed, remoteNumber: "2001",
                                startedAt: TestSupport.fixedDate, connectedAt: TestSupport.fixedDate.addingTimeInterval(2),
                                endedAt: TestSupport.fixedDate.addingTimeInterval(10), statusCode: 200, statusText: "OK")
        let contact = Contact(name: "Alice", numbers: [ContactNumber(number: "2001")], createdAt: TestSupport.fixedDate)
        var settings = AppSettings()
        settings.lastUsedAccountID = account.id

        try store.save([profile], to: StoreFile.profiles)
        try store.save([account], to: StoreFile.accounts)
        try store.save([record], to: StoreFile.history)
        try store.save([contact], to: StoreFile.contacts)
        try store.save(settings, to: StoreFile.settings)

        XCTAssertEqual(store.load([Profile].self, from: StoreFile.profiles), [profile])
        XCTAssertEqual(store.load([SIPAccount].self, from: StoreFile.accounts), [account])
        XCTAssertEqual(store.load([CallRecord].self, from: StoreFile.history), [record])
        XCTAssertEqual(store.load([Contact].self, from: StoreFile.contacts), [contact])
        XCTAssertEqual(store.load(AppSettings.self, from: StoreFile.settings), settings)
    }

    func testSavedFilesAreReadableJSONWithoutPasswords() throws {
        let account = SIPAccount(profileID: UUID(), username: "1001", domain: "pbx.example.com")
        try store.save([account], to: StoreFile.accounts)
        let text = try String(contentsOf: store.url(for: StoreFile.accounts), encoding: .utf8)
        XCTAssertTrue(text.contains("\"username\""))
        XCTAssertTrue(text.contains("\n"), "pretty printed for inspection")
        XCTAssertFalse(text.lowercased().contains("password"), "passwords live in the password store, never on disk")
    }

    func testCorruptFileIsMovedAsideAndLoadReturnsNil() throws {
        let url = store.url(for: StoreFile.accounts)
        try "this is not json".write(to: url, atomically: true, encoding: .utf8)

        XCTAssertNil(store.load([SIPAccount].self, from: StoreFile.accounts))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "the corrupt file must not be loaded again")

        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        let backups = leftovers.filter { $0.hasPrefix("accounts.json.corrupt-") }
        XCTAssertEqual(backups.count, 1, "the unreadable file is kept for inspection, got \(leftovers)")
        let backupText = try String(contentsOf: directory.appendingPathComponent(backups[0]), encoding: .utf8)
        XCTAssertEqual(backupText, "this is not json")
    }

    func testWrongShapeIsAlsoTreatedAsCorrupt() throws {
        let url = store.url(for: StoreFile.profiles)
        try #"{"not":"an array"}"#.write(to: url, atomically: true, encoding: .utf8)
        XCTAssertNil(store.load([Profile].self, from: StoreFile.profiles))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testRemoveDeletesTheFile() throws {
        try store.save([Profile(name: "x")], to: StoreFile.profiles)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.url(for: StoreFile.profiles).path))
        store.remove(StoreFile.profiles)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url(for: StoreFile.profiles).path))
        store.remove(StoreFile.profiles) // removing twice is harmless
    }
}
