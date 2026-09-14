import XCTest
@testable import Sipper

final class SIPAccountTests: XCTestCase {
    private func account(username: String = "1001",
                         domain: String = "pbx.example.com",
                         server: String = "",
                         port: Int? = nil,
                         transport: SIPTransport = .udp,
                         displayName: String = "",
                         label: String = "",
                         authUsername: String = "") -> SIPAccount {
        SIPAccount(profileID: UUID(),
                   label: label,
                   displayName: displayName,
                   username: username,
                   authUsername: authUsername,
                   domain: domain,
                   server: server,
                   port: port,
                   transport: transport)
    }

    // MARK: Registrar and proxy

    func testRegistrarURIUsesTheDomainAndCarriesTheTransport() {
        // Every transport, udp included, is spelt out so pjsua never has to guess.
        XCTAssertEqual(account(transport: .udp).registrarURI, "sip:pbx.example.com;transport=udp")
        XCTAssertEqual(account(transport: .tcp).registrarURI, "sip:pbx.example.com;transport=tcp")
        XCTAssertEqual(account(transport: .tls).registrarURI, "sip:pbx.example.com;transport=tls")
        XCTAssertEqual(account(server: "edge.example.com", port: 5080, transport: .tcp).registrarURI,
                       "sip:pbx.example.com;transport=tcp",
                       "the registrar is always the domain, never the server")
    }

    func testProxyURIDefaultsToDomainAndTransportPort() {
        XCTAssertEqual(account(transport: .udp).proxyURI, "sip:pbx.example.com:5060;transport=udp;lr")
        XCTAssertEqual(account(transport: .tcp).proxyURI, "sip:pbx.example.com:5060;transport=tcp;lr")
        XCTAssertEqual(account(transport: .tls).proxyURI, "sip:pbx.example.com:5061;transport=tls;lr")
    }

    func testProxyURIUsesSeparateServerAndCustomPort() {
        XCTAssertEqual(account(server: "edge.example.com", port: 5080, transport: .tcp).proxyURI,
                       "sip:edge.example.com:5080;transport=tcp;lr")
        XCTAssertEqual(account(server: "edge.example.com", transport: .tls).proxyURI,
                       "sip:edge.example.com:5061;transport=tls;lr")
        XCTAssertEqual(account(port: 15060).proxyURI, "sip:pbx.example.com:15060;transport=udp;lr")
    }

    func testProxyURIBracketsIPv6Servers() {
        XCTAssertEqual(account(server: "2001:db8::1").proxyURI, "sip:[2001:db8::1]:5060;transport=udp;lr")
        XCTAssertEqual(account(server: "[2001:db8::1]", port: 5070, transport: .tcp).proxyURI,
                       "sip:[2001:db8::1]:5070;transport=tcp;lr",
                       "an already bracketed host is not double-bracketed")
        XCTAssertEqual(account(server: "192.0.2.10").proxyURI, "sip:192.0.2.10:5060;transport=udp;lr")
    }

    func testEffectiveValues() {
        let plain = account()
        XCTAssertEqual(plain.effectiveServer, "pbx.example.com")
        XCTAssertEqual(plain.effectivePort, 5060)
        XCTAssertEqual(plain.effectiveAuthUsername, "1001")
        XCTAssertFalse(plain.usesSeparateServer)

        let separate = account(server: "edge.example.com", port: 5080, transport: .tls, authUsername: "auth1001")
        XCTAssertEqual(separate.effectiveServer, "edge.example.com")
        XCTAssertEqual(separate.effectivePort, 5080)
        XCTAssertEqual(separate.effectiveAuthUsername, "auth1001")
        XCTAssertTrue(separate.usesSeparateServer)

        XCTAssertFalse(account(server: "PBX.EXAMPLE.COM").usesSeparateServer, "server equal to the domain is not separate")
    }

    // MARK: Address of record

    func testAddressOfRecordWithoutDisplayName() {
        XCTAssertEqual(account().addressOfRecord, "sip:1001@pbx.example.com")
        XCTAssertEqual(account(displayName: "   ").addressOfRecord, "sip:1001@pbx.example.com", "whitespace-only names are ignored")
    }

    func testAddressOfRecordQuotesDisplayNameAndNeutralisesQuotes() {
        XCTAssertEqual(account(displayName: "Alex Morgan").addressOfRecord, "\"Alex Morgan\" <sip:1001@pbx.example.com>")
        XCTAssertEqual(account(displayName: " Alex ").addressOfRecord, "\"Alex\" <sip:1001@pbx.example.com>")
        let quoted = account(displayName: "Alex \"The Voice\" H").addressOfRecord
        XCTAssertEqual(quoted, "\"Alex 'The Voice' H\" <sip:1001@pbx.example.com>")
        XCTAssertEqual(quoted.filter { $0 == "\"" }.count, 2, "inner quotes must not break the quoted string")
    }

    // MARK: Dialling

    func testCallURIForPlainDigitsUsesTheAccountDomainAndTransport() {
        XCTAssertEqual(account().callURI(for: "2001"), "sip:2001@pbx.example.com;transport=udp")
        XCTAssertEqual(account(transport: .tcp).callURI(for: "2001"), "sip:2001@pbx.example.com;transport=tcp")
        XCTAssertEqual(account(transport: .tls).callURI(for: "2001"), "sip:2001@pbx.example.com;transport=tls")
    }

    func testCallURINormalisesFormattedNumbers() {
        XCTAssertEqual(account().callURI(for: " +44 (0)20 7946-0958 "), "sip:+4402079460958@pbx.example.com;transport=udp")
        XCTAssertEqual(account().callURI(for: "020.7946.0958"), "sip:02079460958@pbx.example.com;transport=udp")
        XCTAssertEqual(account().callURI(for: "*97#"), "sip:*97#@pbx.example.com;transport=udp", "* and # are dialable")
    }

    func testCallURIForUserAtHostAndFullURIs() {
        XCTAssertEqual(account().callURI(for: "alice@other.example.com"), "sip:alice@other.example.com")
        XCTAssertEqual(account(transport: .tcp).callURI(for: "alice@other.example.com"), "sip:alice@other.example.com",
                       "explicit hosts do not get the account transport appended")
        XCTAssertEqual(account().callURI(for: "sip:bob@x.example.com;transport=tls"), "sip:bob@x.example.com;transport=tls")
        XCTAssertEqual(account().callURI(for: "  SIPS:bob@x.example.com  "), "SIPS:bob@x.example.com")
    }

    func testNormaliseDialString() {
        XCTAssertEqual(SIPAccount.normaliseDialString("+44 (0)20-7946.0958"), "+4402079460958")
        XCTAssertEqual(SIPAccount.normaliseDialString("*97#"), "*97#")
        XCTAssertEqual(SIPAccount.normaliseDialString("1234AbCd"), "1234AbCd", "DTMF letters survive")
        XCTAssertEqual(SIPAccount.normaliseDialString("ext. 12"), "12")
        XCTAssertEqual(SIPAccount.normaliseDialString(""), "")
    }

    // MARK: Matching and labels

    func testMatchesUsernameExactlyAndDomainCaseInsensitively() {
        let a = account(username: "1001", domain: "pbx.example.com")
        XCTAssertTrue(a.matches(username: "1001", domain: "PBX.Example.COM"))
        XCTAssertFalse(a.matches(username: "1001", domain: "other.example.com"))
        XCTAssertFalse(a.matches(username: "1002", domain: "pbx.example.com"))
        XCTAssertFalse(a.matches(username: "1001 ", domain: "pbx.example.com"), "usernames are compared exactly")
    }

    func testDisplayLabelFallsBackToUserAtDomain() {
        XCTAssertEqual(account().displayLabel, "1001@pbx.example.com")
        XCTAssertEqual(account().defaultLabel, "1001@pbx.example.com")
        XCTAssertEqual(account(label: "Desk").displayLabel, "Desk")
    }

    // MARK: Validation

    func testValidAccountHasNoErrors() {
        XCTAssertEqual(account().validationErrors, [])
        XCTAssertEqual(account(server: "edge.example.com", port: 65535, transport: .tls).validationErrors, [])
    }

    func testValidationErrors() {
        XCTAssertEqual(account(username: "  ").validationErrors.count, 1)
        XCTAssertTrue(account(username: "").validationErrors[0].contains("Username"))
        XCTAssertTrue(account(domain: "").validationErrors[0].contains("Domain"))
        XCTAssertTrue(account(domain: "pbx example.com").validationErrors[0].contains("spaces"))
        XCTAssertTrue(account(port: 0).validationErrors[0].contains("Port"))
        XCTAssertTrue(account(port: 65536).validationErrors[0].contains("Port"))

        var expiry = account()
        expiry.registrationExpiry = 30
        XCTAssertTrue(expiry.validationErrors[0].contains("expiry"))
        expiry.registrationExpiry = 86401
        XCTAssertEqual(expiry.validationErrors.count, 1)
        expiry.registrationExpiry = 60
        XCTAssertEqual(expiry.validationErrors, [])
    }

    func testMultipleProblemsAreAllReported() {
        let broken = account(username: "", domain: "", port: 99999)
        XCTAssertEqual(broken.validationErrors.count, 3)
    }

    // MARK: Transport helpers

    func testTransportParsesLooselyAndKnowsDefaultPorts() {
        XCTAssertEqual(SIPTransport(loosely: " TLS "), .tls)
        XCTAssertEqual(SIPTransport(loosely: "Udp"), .udp)
        XCTAssertNil(SIPTransport(loosely: ""))
        XCTAssertNil(SIPTransport(loosely: nil))
        XCTAssertNil(SIPTransport(loosely: "sctp"))
        XCTAssertEqual(SIPTransport.udp.defaultPort, 5060)
        XCTAssertEqual(SIPTransport.tcp.defaultPort, 5060)
        XCTAssertEqual(SIPTransport.tls.defaultPort, 5061)
    }
}
