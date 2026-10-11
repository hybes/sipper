import XCTest
@testable import SipperIOS

@MainActor
final class GatewayBoundaryTests: XCTestCase {
    func testNativeParserRequiresExactlyOneCanonicalCallHeader() throws {
        // Initialise PJSIP on this thread without opening any transports or audio.
        XCTAssertEqual(pj_init(), 0)
        defer { pj_shutdown() }
        XCTAssertEqual(pjlib_util_init(), 0)
        var cache = pj_caching_pool(), policy = pj_pool_factory_default_policy
        pj_caching_pool_init(&cache, &policy, 0)
        defer { pj_caching_pool_destroy(&cache) }
        var endpoint: OpaquePointer?
        XCTAssertEqual(pjsip_endpt_create(&cache.factory, "gateway-header-fixture", &endpoint), 0)
        let endpt = try XCTUnwrap(endpoint)
        defer { pjsip_endpt_destroy(endpt) }
        let pool = try XCTUnwrap(pjsip_endpt_create_pool(endpt, "parser-fixture", 4096, 4096))
        defer { pjsip_endpt_release_pool(endpt, pool) }
        let id = "12065d41-5ef7-4b67-8b53-254b223f72a1"
        func parse(_ headers: String, method: String = "INVITE", body: String = "") -> String? {
            let message = "\(method) sip:fixture@gateway.example.invalid SIP/2.0\r\nVia: SIP/2.0/TLS 127.0.0.1:5061;branch=z9hG4bKfixture\r\nFrom: <sip:100@example.invalid>;tag=fixture\r\nTo: <sip:fixture@gateway.example.invalid>\r\nCall-ID: parser-fixture\r\nCSeq: 1 \(method)\r\n\(headers)Content-Length: \(body.utf8.count)\r\n\r\n\(body)"
            var bytes = Array(message.utf8CString), output = [CChar](repeating: 0, count: 37)
            return bytes.withUnsafeMutableBufferPointer { buffer in
                let parsed = pjsip_parse_msg(pool, buffer.baseAddress, buffer.count - 1, nil)
                return sipper_gateway_call_id(parsed, &output, output.count) == 1 ? String(cString: output) : nil
            }
        }
        XCTAssertEqual(parse("X-Sipper-Call-ID: \(id)\r\n"), id)
        XCTAssertEqual(parse("x-sipper-call-id: \(id.uppercased())\r\n"), id.uppercased())
        XCTAssertNil(parse(""))
        XCTAssertNil(parse("X-Sipper-Call-ID: \(id)\r\nX-Sipper-Call-ID: \(id)\r\n"))
        XCTAssertNil(parse("X-Sipper-Call-ID: \(id), \(id)\r\n"))
        XCTAssertNil(parse("X-Sipper-Call-ID: invalid\r\n"))
        XCTAssertNil(parse("", body: "X-Sipper-Call-ID: \(id)\r\n"))
        XCTAssertNil(parse("X-Sipper-Call-ID: \(id)\r\n", method: "OPTIONS"))
    }

    func testEngineRejectsGatewayAccountsWithoutVerifiedTLSAndMandatoryMediaEncryption() throws {
        let engine = SIPEngine()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        var account = SIPAccount(profileID: UUID(), username: "fixture", domain: "gateway.example.invalid", transport: .udp)
        account.managed = ManagedAccountBinding(organisationID: UUID(), deviceID: UUID(), accountID: UUID(), expiresAt: Date().addingTimeInterval(60), mode: .gateway)
        for transport in [SIPTransport.udp, .tcp, .tls] {
            account.transport = transport
            engine.syncAccounts([(account, "fictional-password")])
            XCTAssertFalse(engine.hasApplied([(account, "fictional-password")]))
            XCTAssertThrowsError(try engine.makeCall(accountID: account.id, uri: account.callURI(for: "100")))
        }
        engine.stop()
        settings.verifyTLSCertificates = false
        try engine.start(settings: settings)
        account.srtp = .mandatory
        engine.syncAccounts([(account, "fictional-password")])
        XCTAssertFalse(engine.hasApplied([(account, "fictional-password")]))
    }
}
