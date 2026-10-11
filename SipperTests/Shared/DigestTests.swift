import XCTest
#if os(macOS)
@testable import Sipper
#else
@testable import SipperIOS
#endif

@MainActor
final class DigestTests: XCTestCase {
    func testAppleDigestMatchesIndependentMD5AndSHA256Vectors() throws {
        let engine = SIPEngine()
        try engine.useNullAudioForTesting()
        var settings = AppSettings(); settings.sipLogLevel = 0
        try engine.start(settings: settings)
        defer { engine.stop() }
        XCTAssertNotEqual(pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_SHA256), 0)
        XCTAssertNotEqual(pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_MD5), 0)
        XCTAssertEqual(pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_SHA512_256), 0)

        // Independent Python hashlib results for these fictional SIP credentials.
        // Exercise plaintext and precomputed HA1, with and without qop=auth.
        let vectors: [(pjsip_auth_algorithm_type, String, String, String)] = [
            (PJSIP_AUTH_ALGORITHM_MD5, "6ed95453a57e566844a08695e5a1a199",
             "6959df71868067682c6db2defb831db7", "7944a3694fccdce2c01931d2339c8de2"),
            (PJSIP_AUTH_ALGORITHM_SHA256, "49f3ed35a62752031cd3ca126a8601b21bf2e699d3ca0dc3397f6fe83d268ec3",
             "bb04beee75c843dff563f1474665933c437041e324e3aeb360551f1e4164a802", "c2f3bac63507f4c6d28ec16df297891ae7af9d0ed7384a089b2352396f34bb01"),
        ]
        for (algorithm, ha1, withoutQop, withQop) in vectors {
            for precomputed in [false, true] {
                for useQop in [false, true] {
                    let pool = CStringPool()
                    var nonce = pool.pj("fixture-nonce"), count = pool.pj("00000001")
                    var clientNonce = pool.pj("fixture-cnonce"), qop = pool.pj(useQop ? "auth" : "")
                    var uri = pool.pj("sip:sipper.test"), realm = pool.pj("sipper.test"), method = pool.pj("REGISTER")
                    var credential = pjsip_cred_info()
                    credential.username = pool.pj("ios-test")
                    credential.data = pool.pj(precomputed ? ha1 : "local-ios-test")
                    credential.data_type = Int32((precomputed ? PJSIP_CRED_DATA_DIGEST : PJSIP_CRED_DATA_PLAIN_PASSWD).rawValue)
                    credential.algorithm_type = algorithm
                    var output = pool.pj(String(repeating: " ", count: 64))
                    XCTAssertEqual(pjsip_auth_create_digest2(&output, &nonce, &count, &clientNonce, &qop, &uri, &realm, &credential, &method, algorithm), Int32(PJ_SUCCESS.rawValue))
                    XCTAssertEqual(output.string, useQop ? withQop : withoutQop)
                }
            }
        }
    }
}
