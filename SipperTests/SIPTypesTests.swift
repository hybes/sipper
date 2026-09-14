import XCTest
@testable import Sipper

final class SIPAddressTests: XCTestCase {
    func testQuotedDisplayNameWithAngleBracketsAndTag() {
        let address = SIPAddress.parse("\"Alex Morgan\" <sip:1001@pbx.example.com>;tag=1a2b3c")
        XCTAssertEqual(address.displayName, "Alex Morgan")
        XCTAssertEqual(address.uri, "sip:1001@pbx.example.com")
        XCTAssertEqual(address.user, "1001")
        XCTAssertEqual(address.host, "pbx.example.com")
    }

    func testUnquotedDisplayName() {
        let address = SIPAddress.parse("Alex <sip:1001@pbx.example.com>")
        XCTAssertEqual(address.displayName, "Alex")
        XCTAssertEqual(address.user, "1001")
    }

    func testBareURIWithParameters() {
        let address = SIPAddress.parse("sip:1001@pbx.example.com;transport=tcp;ob")
        XCTAssertEqual(address.displayName, "")
        XCTAssertEqual(address.uri, "sip:1001@pbx.example.com")
        XCTAssertEqual(address.user, "1001")
        XCTAssertEqual(address.host, "pbx.example.com")
    }

    func testURIParametersAndHeadersInsideBracketsAreStrippedFromUserAndHost() {
        let address = SIPAddress.parse("<sip:1001@pbx.example.com:5080;transport=tls?Subject=hi>")
        XCTAssertEqual(address.user, "1001")
        XCTAssertEqual(address.host, "pbx.example.com", "port and parameters are not part of the host")
    }

    func testTelURI() {
        let address = SIPAddress.parse("tel:+442079460958")
        XCTAssertEqual(address.displayName, "")
        XCTAssertEqual(address.uri, "tel:+442079460958")
        XCTAssertEqual(address.user, "+442079460958", "tel URIs carry the number as the user part")
        XCTAssertEqual(address.host, "")
    }

    func testSecureURIWithPort() {
        let address = SIPAddress.parse("\"Alice\" <sips:alice@secure.example.com:5061>")
        XCTAssertEqual(address.displayName, "Alice")
        XCTAssertEqual(address.user, "alice")
        XCTAssertEqual(address.host, "secure.example.com")
    }

    func testSchemeIsCaseInsensitive() {
        let address = SIPAddress.parse("SIP:1001@PBX.example.com")
        XCTAssertEqual(address.user, "1001")
        XCTAssertEqual(address.host, "PBX.example.com")
    }

    func testEscapedQuotesInDisplayName() {
        let address = SIPAddress.parse("\"Alex \\\"The Voice\\\" H\" <sip:1001@pbx.example.com>")
        XCTAssertEqual(address.displayName, "Alex \"The Voice\" H")
        XCTAssertEqual(address.user, "1001")
    }

    func testIPv6HostWithPort() {
        let address = SIPAddress.parse("<sip:1001@[2001:db8::1]:5060>")
        XCTAssertEqual(address.user, "1001")
        XCTAssertEqual(address.host, "2001:db8::1", "brackets and port are stripped, the address itself is kept intact")
    }

    func testMissingUser() {
        let address = SIPAddress.parse("sip:pbx.example.com")
        XCTAssertEqual(address.user, "")
        XCTAssertEqual(address.host, "pbx.example.com")

        let bracketed = SIPAddress.parse("<sip:pbx.example.com:5060>")
        XCTAssertEqual(bracketed.user, "")
        XCTAssertEqual(bracketed.host, "pbx.example.com")
    }

    func testPercentEncodedUserIsDecoded() {
        let address = SIPAddress.parse("sip:%2B441234@pbx.example.com")
        XCTAssertEqual(address.user, "+441234")
    }

    func testSurroundingWhitespaceIsIgnored() {
        let address = SIPAddress.parse("  \"Alex\" <sip:1001@pbx.example.com>  \r\n")
        XCTAssertEqual(address.displayName, "Alex")
        XCTAssertEqual(address.user, "1001")
    }

    func testEmptyInput() {
        let address = SIPAddress.parse("")
        XCTAssertEqual(address, SIPAddress(displayName: "", uri: "", user: "", host: ""))
    }
}

final class VoicemailInfoTests: XCTestCase {
    func testParsesWaitingSummaryWithCounts() {
        let info = VoicemailInfo.parse(body: "Messages-Waiting: yes\r\nVoice-Message: 2/5 (0/0)")
        XCTAssertTrue(info.hasMessages)
        XCTAssertEqual(info.newCount, 2)
        XCTAssertEqual(info.oldCount, 5)
    }

    func testParsesNoMessages() {
        let info = VoicemailInfo.parse(body: "Messages-Waiting: no\r\nVoice-Message: 0/3 (0/0)")
        XCTAssertFalse(info.hasMessages)
        XCTAssertEqual(info.newCount, 0)
        XCTAssertEqual(info.oldCount, 3)
        XCTAssertEqual(VoicemailInfo.parse(body: "Messages-Waiting: no"), .none)
    }

    func testEmptyBody() {
        XCTAssertEqual(VoicemailInfo.parse(body: ""), .none)
        XCTAssertEqual(VoicemailInfo.parse(body: "\r\n"), .none)
    }

    func testHeaderNamesAreCaseInsensitiveAndNewMessagesImplyWaiting() {
        let info = VoicemailInfo.parse(body: "messages-waiting: NO\nvoice-message: 1/0")
        XCTAssertTrue(info.hasMessages, "a positive new count means there are messages regardless of the flag")
        XCTAssertEqual(info.newCount, 1)
        XCTAssertEqual(info.oldCount, 0)
    }

    func testIgnoresUnrelatedHeaders() {
        let info = VoicemailInfo.parse(body: "Message-Account: sip:*97@pbx.example.com\r\nMessages-Waiting: yes\r\nFax-Message: 4/1\r\n")
        XCTAssertTrue(info.hasMessages)
        XCTAssertEqual(info.newCount, 0, "fax counts are not voice messages")
    }
}

final class SIPTypeDisplayTests: XCTestCase {
    func testRegistrationStateLabels() {
        XCTAssertTrue(RegistrationState.registered(expiresIn: 300, since: Date()).isRegistered)
        XCTAssertFalse(RegistrationState.registering.isRegistered)
        XCTAssertTrue(RegistrationState.failed(code: 401, reason: "Unauthorized").isFailed)
        XCTAssertEqual(RegistrationState.failed(code: 401, reason: "Unauthorized").shortLabel, "Failed (401)")
        XCTAssertEqual(RegistrationState.failed(code: 0, reason: "Engine not running").shortLabel, "Failed")
        XCTAssertEqual(RegistrationState.failed(code: 0, reason: "Engine not running").detail, "Engine not running")
        XCTAssertEqual(RegistrationState.failed(code: 403, reason: "Forbidden").detail, "403 Forbidden")
    }

    func testCodecDisplayName() {
        XCTAssertEqual(CodecInfo(id: "opus/48000/2", priority: 1).displayName, "opus 48 kHz stereo")
        XCTAssertEqual(CodecInfo(id: "PCMU/8000/1", priority: 1).displayName, "PCMU 8 kHz")
        XCTAssertEqual(CodecInfo(id: "weird", priority: 1).displayName, "weird")
    }

    func testCallSnapshotDerivedValues() {
        let ringing = CallSnapshot.fixture(accountID: UUID(), remoteNumber: "2001")
        XCTAssertTrue(ringing.isActive)
        XCTAssertTrue(ringing.isRinging)
        XCTAssertEqual(ringing.displayName, "2001")

        let ended = ringing.ended()
        XCTAssertFalse(ended.isActive)
        XCTAssertFalse(ended.isRinging)

        XCTAssertEqual(CallSnapshot.fixture(accountID: UUID(), remoteNumber: "2001", remoteName: "Alice").displayName, "Alice")
    }
}
