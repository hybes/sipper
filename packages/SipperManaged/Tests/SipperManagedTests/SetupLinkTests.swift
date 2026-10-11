import XCTest
@testable import SipperManaged

final class SetupLinkTests: XCTestCase {
    func testSetupReferencesAcceptOnlyTheConfiguredOriginAndExactLinkShape() throws {
        let server = URL(string: "https://sipper.example.invalid")!, reference = String(repeating: "a", count: 43)
        let web = "https://sipper.example.invalid/portal/setup#ref=\(reference)"
        let native = "sipper://setup?server=https%3A%2F%2Fsipper.example.invalid&reference=\(reference)"
        for value in [web, native] { XCTAssertEqual(try ManagedSetupLink(url: URL(string: value)!, serverURL: server).reference, reference) }
        for value in [web.replacingOccurrences(of: "sipper.example", with: "other.example"),
                      web.replacingOccurrences(of: "https:", with: "http:"), web + "&extra=1",
                      web.replacingOccurrences(of: "#ref", with: "?ref"), web + "a",
                      native + "&reference=\(reference)", native + "#extra", native + "&password=secret",
                      native.replacingOccurrences(of: "//setup", with: "//user@setup"),
                      native.replacingOccurrences(of: "//setup", with: "//setup:999"),
                      native.replacingOccurrences(of: "//setup?", with: "//setup/other?"),
                      native.replacingOccurrences(of: "sipper:", with: "sipper-development:"),
                      "sipper://setup?server=https%3A%2F%2Fsipper.example.invalid%2Fevil&reference=\(reference)"] {
            XCTAssertThrowsError(try ManagedSetupLink(url: URL(string: value)!, serverURL: server))
        }
        let local = URL(string: "http://localhost:3100")!
        XCTAssertEqual(try ManagedSetupLink(url: URL(string: "sipper-development://setup?server=http%3A%2F%2Flocalhost%3A3100&reference=\(reference)")!, serverURL: local).reference, reference)
    }
}
