import XCTest
@testable import Sipper

final class ImportParserTests: XCTestCase {
    /// The example from docs/PROTOCOL.md.
    private let documentedExampleURL = URL(string: "sipper://add-accounts?payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19")!
    private let documentedExampleJSON = #"{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"s3cret"}]}"#

    private func importError(_ url: URL) -> ImportError? {
        do {
            _ = try ImportParser.parse(url: url)
            return nil
        } catch {
            return error as? ImportError
        }
    }

    private func importError(json: String) -> ImportError? {
        do {
            _ = try ImportParser.parse(json: Data(json.utf8))
            return nil
        } catch {
            return error as? ImportError
        }
    }

    private func url(payload: String) -> URL {
        var components = URLComponents()
        components.scheme = "sipper"
        components.host = "add-accounts"
        components.queryItems = [URLQueryItem(name: "payload", value: payload)]
        return components.url!
    }

    private func candidate(_ accountJSON: String) throws -> ImportCandidate {
        let request = try ImportParser.parse(json: Data(#"{"version":1,"accounts":[\#(accountJSON)]}"#.utf8))
        return try XCTUnwrap(request.candidates.first)
    }

    // MARK: base64url

    func testDecodesBase64URLWithAndWithoutPadding() {
        XCTAssertEqual(ImportParser.decodeBase64URL("aGVsbG8"), Data("hello".utf8))
        XCTAssertEqual(ImportParser.decodeBase64URL("aGVsbG8="), Data("hello".utf8))
        XCTAssertEqual(ImportParser.decodeBase64URL("  aGVsbG8=\n"), Data("hello".utf8), "surrounding whitespace is tolerated")
    }

    func testDecodesURLSafeAlphabet() {
        // 0xfb 0xff 0xbf encodes to "+/+/" in standard base64 and "-_-_" in base64url.
        let bytes = Data([0xfb, 0xff, 0xbf])
        XCTAssertEqual(ImportParser.encodeBase64URL(bytes), "-_-_")
        XCTAssertEqual(ImportParser.decodeBase64URL("-_-_"), bytes)
        XCTAssertEqual(ImportParser.decodeBase64URL("+/+/"), bytes, "standard alphabet is still accepted")
    }

    func testRejectsInvalidBase64URL() {
        XCTAssertNil(ImportParser.decodeBase64URL("a"), "a single leftover character can never be valid")
        XCTAssertNil(ImportParser.decodeBase64URL("!!!!"))
        XCTAssertNil(ImportParser.decodeBase64URL("aGVs bG8"))
    }

    func testEncodeRoundTripsArbitraryBytesWithoutPaddingOrUnsafeCharacters() {
        let bytes = Data((0...255).map { UInt8($0) })
        let encoded = ImportParser.encodeBase64URL(bytes)
        XCTAssertFalse(encoded.contains("="))
        XCTAssertFalse(encoded.contains("+"))
        XCTAssertFalse(encoded.contains("/"))
        XCTAssertEqual(ImportParser.decodeBase64URL(encoded), bytes)
    }

    // MARK: URL recognition

    func testRecognisesImportURLsInHostAndPathForms() {
        XCTAssertTrue(ImportParser.isImportURL(URL(string: "sipper://add-accounts?payload=abc")!))
        XCTAssertTrue(ImportParser.isImportURL(URL(string: "sipper:///add-accounts?payload=abc")!))
        XCTAssertTrue(ImportParser.isImportURL(URL(string: "sipper:add-accounts?payload=abc")!))
        XCTAssertTrue(ImportParser.isImportURL(URL(string: "SIPPER://ADD-ACCOUNTS?payload=abc")!), "scheme and action are case-insensitive")
    }

    func testRejectsOtherSchemesAndActions() {
        XCTAssertFalse(ImportParser.isImportURL(URL(string: "https://add-accounts?payload=abc")!))
        XCTAssertFalse(ImportParser.isImportURL(URL(string: "sipper://ping")!))
        XCTAssertFalse(ImportParser.isImportURL(URL(string: "sipper://")!))
        XCTAssertEqual(importError(URL(string: "https://example.com/add-accounts")!), .notAnImportURL)
    }

    // MARK: Happy path

    func testParsesTheDocumentedExampleURL() throws {
        let request = try ImportParser.parse(url: documentedExampleURL)
        XCTAssertEqual(request.provider, "manual", "no source means a manual import")
        XCTAssertNil(request.profileName)
        XCTAssertNil(request.sourceURL)
        XCTAssertEqual(request.candidates.count, 1)
        XCTAssertEqual(request.validCount, 1)

        let candidate = try XCTUnwrap(request.candidates.first)
        XCTAssertTrue(candidate.isValid)
        XCTAssertFalse(candidate.isUpdate)
        XCTAssertEqual(candidate.account.username, "1001")
        XCTAssertEqual(candidate.account.domain, "pbx.example.com")
        XCTAssertEqual(candidate.password, "s3cret")
    }

    func testParsesTheFullDocumentedDocument() throws {
        let json = """
        {
          "version": 1,
          "source": {
            "provider": "fusionpbx",
            "url": "https://pbx.example.com/app/extensions/extension_edit.php?id=1",
            "title": "Extension 1001"
          },
          "profile": { "name": "pbx.example.com" },
          "accounts": [
            {
              "label": "1001 · Alex",
              "displayName": "Alex Morgan",
              "username": "1001",
              "authUsername": "1001",
              "password": "s3cret",
              "domain": "tenant.pbx.example.com",
              "server": "pbx.example.com",
              "port": 5060,
              "transport": "udp",
              "callerIdName": "Alex Morgan",
              "callerIdNumber": "01onward",
              "voicemailNumber": "*97",
              "notes": "Desk phone"
            }
          ]
        }
        """
        let request = try ImportParser.parse(json: Data(json.utf8))
        XCTAssertEqual(request.provider, "fusionpbx")
        XCTAssertEqual(request.sourceURL, "https://pbx.example.com/app/extensions/extension_edit.php?id=1")
        XCTAssertEqual(request.sourceTitle, "Extension 1001")
        XCTAssertEqual(request.profileName, "pbx.example.com")

        let account = try XCTUnwrap(request.candidates.first).account
        XCTAssertEqual(account.label, "1001 · Alex")
        XCTAssertEqual(account.displayName, "Alex Morgan")
        XCTAssertEqual(account.username, "1001")
        XCTAssertEqual(account.authUsername, "", "auth username equal to the username is stored as 'same as username'")
        XCTAssertEqual(account.domain, "tenant.pbx.example.com")
        XCTAssertEqual(account.server, "pbx.example.com", "a server that differs from the domain is kept")
        XCTAssertNil(account.port, "the transport's default port is stored as nil")
        XCTAssertEqual(account.transport, .udp)
        XCTAssertEqual(account.callerIDName, "Alex Morgan")
        XCTAssertEqual(account.callerIDNumber, "01onward")
        XCTAssertEqual(account.voicemailNumber, "*97")
        XCTAssertEqual(account.notes, "Desk phone")
        XCTAssertEqual(account.source, "fusionpbx")
        XCTAssertTrue(account.isEnabled)
    }

    func testUnknownQueryParametersAreIgnored() throws {
        let url = URL(string: "sipper://add-accounts?foo=bar&payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19&baz=1")!
        XCTAssertEqual(try ImportParser.parse(url: url).candidates.count, 1)
    }

    func testMakeURLRoundTripsAndMatchesTheDocumentedEncoding() throws {
        let url = try XCTUnwrap(ImportParser.makeURL(jsonData: Data(documentedExampleJSON.utf8)))
        XCTAssertEqual(url.scheme, "sipper")
        XCTAssertEqual(url.host, "add-accounts")
        XCTAssertTrue(ImportParser.isImportURL(url))
        XCTAssertEqual(url.absoluteString, documentedExampleURL.absoluteString)

        let request = try ImportParser.parse(url: url)
        XCTAssertEqual(request.candidates.map(\.account.username), ["1001"])
        XCTAssertEqual(request.candidates.map(\.password), ["s3cret"])
    }

    func testMakeURLSurvivesUnicodeAndSymbols() throws {
        let json = #"{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"p+/=ß&?#","label":"Alex · Büro"}]}"#
        let url = try XCTUnwrap(ImportParser.makeURL(jsonData: Data(json.utf8)))
        let candidate = try XCTUnwrap(try ImportParser.parse(url: url).candidates.first)
        XCTAssertEqual(candidate.password, "p+/=ß&?#")
        XCTAssertEqual(candidate.account.label, "Alex · Büro")
    }

    // MARK: Errors

    func testMissingOrEmptyPayload() {
        XCTAssertEqual(importError(URL(string: "sipper://add-accounts")!), .missingPayload)
        XCTAssertEqual(importError(URL(string: "sipper://add-accounts?payload=")!), .missingPayload)
        XCTAssertEqual(importError(URL(string: "sipper://add-accounts?other=1")!), .missingPayload)
    }

    func testInvalidBase64Payload() {
        XCTAssertEqual(importError(url(payload: "!!!")), .invalidBase64)
    }

    func testInvalidJSONReportsTheMissingKey() {
        guard case .invalidJSON(let detail)? = importError(json: "{}") else {
            return XCTFail("expected invalidJSON")
        }
        XCTAssertTrue(detail.contains("version"), "detail should name the missing key, got: \(detail)")

        guard case .invalidJSON(let accountsDetail)? = importError(json: #"{"version":1}"#) else {
            return XCTFail("expected invalidJSON")
        }
        XCTAssertTrue(accountsDetail.contains("accounts"), "got: \(accountsDetail)")
    }

    func testInvalidJSONReportsTypeMismatchAndCorruptData() {
        guard case .invalidJSON(let mismatch)? = importError(json: #"{"version":"one","accounts":[]}"#) else {
            return XCTFail("expected invalidJSON")
        }
        XCTAssertFalse(mismatch.isEmpty)

        guard case .invalidJSON(let corrupt)? = importError(json: "not json at all") else {
            return XCTFail("expected invalidJSON")
        }
        XCTAssertFalse(corrupt.isEmpty)

        let described = ImportError.invalidJSON("missing key “version”").errorDescription ?? ""
        XCTAssertTrue(described.contains("missing key “version”"), "the detail must reach the user-facing message")
    }

    func testUnsupportedVersion() {
        XCTAssertEqual(importError(json: #"{"version":2,"accounts":[{"username":"1"}]}"#), .unsupportedVersion(2))
        XCTAssertEqual(importError(json: #"{"version":0,"accounts":[]}"#), .unsupportedVersion(0))
    }

    func testNoAccounts() {
        XCTAssertEqual(importError(json: #"{"version":1,"accounts":[]}"#), .noAccounts)
    }

    func testPayloadTooLarge() {
        let oversizedURLPayload = String(repeating: "A", count: ImportParser.maxPayloadBytes * 2 + 1)
        XCTAssertEqual(importError(url(payload: oversizedURLPayload)), .payloadTooLarge)

        let oversizedJSON = Data(count: ImportParser.maxPayloadBytes + 1)
        XCTAssertThrowsError(try ImportParser.parse(json: oversizedJSON)) { error in
            XCTAssertEqual(error as? ImportError, .payloadTooLarge)
        }
    }

    // MARK: Candidate validation

    func testMissingUsernameDomainAndPasswordMarkTheCandidateInvalid() throws {
        let candidate = try candidate(#"{"username":"   ","domain":"","password":""}"#)
        XCTAssertFalse(candidate.isValid)
        XCTAssertEqual(candidate.validationErrors.count, 3)
        XCTAssertTrue(candidate.validationErrors.contains { $0.localizedCaseInsensitiveContains("username") })
        XCTAssertTrue(candidate.validationErrors.contains { $0.localizedCaseInsensitiveContains("domain") })
        XCTAssertTrue(candidate.validationErrors.contains { $0.localizedCaseInsensitiveContains("password") })
    }

    func testInvalidCandidatesDoNotCountAsValidButAreStillListed() throws {
        let request = try ImportParser.parse(json: Data(#"""
        {"version":1,"accounts":[
          {"username":"1001","domain":"pbx.example.com","password":"a"},
          {"username":"","domain":"pbx.example.com","password":"b"}
        ]}
        """#.utf8))
        XCTAssertEqual(request.candidates.count, 2)
        XCTAssertEqual(request.validCount, 1)
    }

    func testUnknownTransportIsAnError() throws {
        let candidate = try candidate(#"{"username":"1001","domain":"pbx.example.com","password":"x","transport":"sctp"}"#)
        XCTAssertFalse(candidate.isValid)
        XCTAssertEqual(candidate.validationErrors.count, 1)
        XCTAssertTrue(candidate.validationErrors[0].contains("sctp"))
    }

    func testTransportIsParsedLoosely() throws {
        XCTAssertEqual(try candidate(#"{"username":"1","domain":"d","password":"x","transport":" TLS "}"#).account.transport, .tls)
        XCTAssertEqual(try candidate(#"{"username":"1","domain":"d","password":"x","transport":"Tcp"}"#).account.transport, .tcp)
        XCTAssertEqual(try candidate(#"{"username":"1","domain":"d","password":"x","transport":""}"#).account.transport, .udp, "blank transport falls back to udp")
    }

    func testOutOfRangePortIsAnError() throws {
        let tooHigh = try candidate(#"{"username":"1","domain":"d","password":"x","port":70000}"#)
        XCTAssertFalse(tooHigh.isValid)
        XCTAssertTrue(tooHigh.validationErrors[0].contains("70000"))

        let zero = try candidate(#"{"username":"1","domain":"d","password":"x","port":0}"#)
        XCTAssertFalse(zero.isValid)
    }

    func testDefaultPortForTheTransportIsStoredAsNil() throws {
        XCTAssertNil(try candidate(#"{"username":"1","domain":"d","password":"x","port":5060}"#).account.port)
        XCTAssertNil(try candidate(#"{"username":"1","domain":"d","password":"x","transport":"tls","port":5061}"#).account.port)
        XCTAssertEqual(try candidate(#"{"username":"1","domain":"d","password":"x","port":5061}"#).account.port, 5061,
                       "5061 is not the default for udp so it must be kept")
        XCTAssertEqual(try candidate(#"{"username":"1","domain":"d","password":"x","transport":"tcp","port":5080}"#).account.port, 5080)
    }

    func testDefaults() throws {
        let account = try candidate(#"{"username":"1001","domain":"pbx.example.com","password":"x"}"#).account
        XCTAssertEqual(account.transport, .udp)
        XCTAssertNil(account.port)
        XCTAssertEqual(account.server, "")
        XCTAssertEqual(account.authUsername, "")
        XCTAssertEqual(account.voicemailNumber, "*97")
        XCTAssertEqual(account.label, "")
        XCTAssertEqual(account.displayName, "")
        XCTAssertEqual(account.source, "manual")
        XCTAssertEqual(account.displayLabel, "1001@pbx.example.com")
    }

    func testServerEqualToDomainIsCleared() throws {
        let same = try candidate(#"{"username":"1","domain":"pbx.example.com","password":"x","server":"PBX.Example.COM"}"#).account
        XCTAssertEqual(same.server, "", "case-insensitive match with the domain means 'same as domain'")
        XCTAssertFalse(same.usesSeparateServer)

        let different = try candidate(#"{"username":"1","domain":"tenant.pbx.example.com","password":"x","server":"pbx.example.com"}"#).account
        XCTAssertEqual(different.server, "pbx.example.com")
        XCTAssertTrue(different.usesSeparateServer)
    }

    func testAuthUsernameEqualToUsernameIsCleared() throws {
        XCTAssertEqual(try candidate(#"{"username":"1001","domain":"d","password":"x","authUsername":"1001"}"#).account.authUsername, "")
        let distinct = try candidate(#"{"username":"1001","domain":"d","password":"x","authUsername":"1001-auth"}"#).account
        XCTAssertEqual(distinct.authUsername, "1001-auth")
        XCTAssertEqual(distinct.effectiveAuthUsername, "1001-auth")
    }

    func testStringsAreTrimmed() throws {
        let account = try candidate(#"{"username":" 1001 ","domain":"\n pbx.example.com ","password":"x","label":"  Desk  ","server":"  pbx.example.com  ","voicemailNumber":" *98 ","notes":"  n  "}"#).account
        XCTAssertEqual(account.username, "1001")
        XCTAssertEqual(account.domain, "pbx.example.com")
        XCTAssertEqual(account.label, "Desk")
        XCTAssertEqual(account.server, "", "trimmed server equal to the domain is cleared")
        XCTAssertEqual(account.voicemailNumber, "*98")
        XCTAssertEqual(account.notes, "n")
    }

    func testEachCandidateGetsAUniqueIDAndAPlaceholderProfile() throws {
        let request = try ImportParser.parse(json: Data(#"""
        {"version":1,"accounts":[
          {"username":"1001","domain":"pbx.example.com","password":"a"},
          {"username":"1002","domain":"pbx.example.com","password":"b"}
        ]}
        """#.utf8))
        XCTAssertEqual(Set(request.candidates.map(\.id)).count, 2)
        XCTAssertEqual(Set(request.candidates.map(\.account.id)).count, 2)
    }
}
