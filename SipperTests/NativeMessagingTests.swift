import XCTest
@testable import Sipper

final class NativeMessagingHostTests: XCTestCase {
    // MARK: Launch detection

    func testShouldRunOnlyWhenLaunchedByABrowserOrExplicitFlag() {
        XCTAssertTrue(NativeMessagingHost.shouldRun(arguments: ["/Applications/Sipper.app/Contents/MacOS/Sipper", "chrome-extension://abcdefghijklmnop/"]))
        XCTAssertTrue(NativeMessagingHost.shouldRun(arguments: ["Sipper", "--native-messaging-host"]))
        XCTAssertFalse(NativeMessagingHost.shouldRun(arguments: ["Sipper"]))
        XCTAssertFalse(NativeMessagingHost.shouldRun(arguments: ["Sipper", "-NSDocumentRevisionsDebugMode", "YES"]))
        XCTAssertFalse(NativeMessagingHost.shouldRun(arguments: ["chrome-extension://abc/"]), "the first argument is the executable, not an origin")
        XCTAssertFalse(NativeMessagingHost.shouldRun(arguments: []))
    }

    // MARK: Message handling

    func testPingRepliesPongWithTheAppVersion() {
        let reply = NativeMessagingHost.handle(["type": "ping"])
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertEqual(reply["type"] as? String, "pong")
        let version = reply["version"] as? String ?? ""
        XCTAssertFalse(version.isEmpty)
        if let bundleVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            XCTAssertEqual(version, bundleVersion)
        }
        XCTAssertTrue(JSONSerialization.isValidJSONObject(reply), "replies must be serialisable for the wire")
    }

    func testAddAccountsWithoutPayloadFails() {
        let reply = NativeMessagingHost.handle(["type": "add-accounts"])
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["error"] as? String, "Missing payload.")
        XCTAssertNil(reply["type"])
    }

    func testAddAccountsWithInvalidDocumentReportsTheParserError() {
        let unsupported = NativeMessagingHost.handle(["type": "add-accounts", "payload": ["version": 2, "accounts": [["username": "1"]]]])
        XCTAssertEqual(unsupported["ok"] as? Bool, false)
        XCTAssertEqual(unsupported["error"] as? String, ImportError.unsupportedVersion(2).errorDescription)

        let empty = NativeMessagingHost.handle(["type": "add-accounts", "payload": ["version": 1, "accounts": []]])
        XCTAssertEqual(empty["ok"] as? Bool, false)
        XCTAssertEqual(empty["error"] as? String, ImportError.noAccounts.errorDescription)

        let missingVersion = NativeMessagingHost.handle(["type": "add-accounts", "payload": ["accounts": []]])
        XCTAssertEqual(missingVersion["ok"] as? Bool, false)
        let detail = missingVersion["error"] as? String ?? ""
        XCTAssertTrue(detail.contains("version"), "the error should say which key is missing, got: \(detail)")
    }

    func testUnknownAndMalformedMessageTypes() {
        XCTAssertEqual(NativeMessagingHost.handle(["type": "reboot"])["ok"] as? Bool, false)
        XCTAssertEqual(NativeMessagingHost.handle(["type": "reboot"])["error"] as? String, "Unknown message type.")
        XCTAssertEqual(NativeMessagingHost.handle([:])["error"] as? String, "Unknown message type.")
        XCTAssertEqual(NativeMessagingHost.handle(["type": 42])["error"] as? String, "Unknown message type.")
        XCTAssertEqual(NativeMessagingHost.handle(["type": "invalid"])["error"] as? String, "Message was not valid JSON.")
    }

    // MARK: Framing

    private func readAll(_ handle: FileHandle) -> Data {
        handle.readDataToEndOfFile()
    }

    func testWriteFramesWithNativeEndianLengthPrefix() throws {
        let pipe = Pipe()
        NativeMessagingHost.write(["type": "pong", "ok": true], to: pipe.fileHandleForWriting)
        try pipe.fileHandleForWriting.close()
        let framed = readAll(pipe.fileHandleForReading)

        XCTAssertGreaterThan(framed.count, 4)
        let length = framed.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        XCTAssertEqual(Int(length), framed.count - 4)
        let body = try JSONSerialization.jsonObject(with: framed.dropFirst(4)) as? [String: Any]
        XCTAssertEqual(body?["type"] as? String, "pong")
        XCTAssertEqual(body?["ok"] as? Bool, true)
    }

    func testReadMessageRoundTripsThroughAPipe() throws {
        let pipe = Pipe()
        NativeMessagingHost.write(["type": "ping", "n": 1, "text": "héllo · wörld"], to: pipe.fileHandleForWriting)
        NativeMessagingHost.write(["type": "add-accounts", "payload": ["version": 1]], to: pipe.fileHandleForWriting)
        try pipe.fileHandleForWriting.close()

        let first = NativeMessagingHost.readMessage(from: pipe.fileHandleForReading)
        XCTAssertEqual(first?["type"] as? String, "ping")
        XCTAssertEqual(first?["n"] as? Int, 1)
        XCTAssertEqual(first?["text"] as? String, "héllo · wörld")

        let second = NativeMessagingHost.readMessage(from: pipe.fileHandleForReading)
        XCTAssertEqual(second?["type"] as? String, "add-accounts")
        XCTAssertEqual((second?["payload"] as? [String: Any])?["version"] as? Int, 1)

        XCTAssertNil(NativeMessagingHost.readMessage(from: pipe.fileHandleForReading), "end of input ends the loop")
    }

    func testReadMessageWithInvalidJSONBodyYieldsAnInvalidMarker() throws {
        let pipe = Pipe()
        let body = Data("not json".utf8)
        var length = UInt32(body.count)
        var framed = Data(bytes: &length, count: 4)
        framed.append(body)
        pipe.fileHandleForWriting.write(framed)
        try pipe.fileHandleForWriting.close()

        let message = NativeMessagingHost.readMessage(from: pipe.fileHandleForReading)
        XCTAssertEqual(message?["type"] as? String, "invalid")
        XCTAssertEqual(NativeMessagingHost.handle(message ?? [:])["ok"] as? Bool, false)
    }

    func testReadMessageRejectsZeroLengthTruncatedAndOversizedFrames() throws {
        let zero = Pipe()
        var zeroLength = UInt32(0)
        zero.fileHandleForWriting.write(Data(bytes: &zeroLength, count: 4))
        try zero.fileHandleForWriting.close()
        XCTAssertNil(NativeMessagingHost.readMessage(from: zero.fileHandleForReading))

        let truncated = Pipe()
        var claimed = UInt32(100)
        var partial = Data(bytes: &claimed, count: 4)
        partial.append(Data("{\"type\":\"ping\"}".utf8))
        truncated.fileHandleForWriting.write(partial)
        try truncated.fileHandleForWriting.close()
        XCTAssertNil(NativeMessagingHost.readMessage(from: truncated.fileHandleForReading), "a frame cut short by EOF is dropped")

        let oversized = Pipe()
        var huge = UInt32(64 * 1024 * 1024)
        oversized.fileHandleForWriting.write(Data(bytes: &huge, count: 4))
        try oversized.fileHandleForWriting.close()
        XCTAssertNil(NativeMessagingHost.readMessage(from: oversized.fileHandleForReading))

        let short = Pipe()
        short.fileHandleForWriting.write(Data([1, 2]))
        try short.fileHandleForWriting.close()
        XCTAssertNil(NativeMessagingHost.readMessage(from: short.fileHandleForReading), "an incomplete header is EOF")
    }

    func testTopLevelArrayIsNotAValidMessage() throws {
        let pipe = Pipe()
        let body = Data("[1,2,3]".utf8)
        var length = UInt32(body.count)
        var framed = Data(bytes: &length, count: 4)
        framed.append(body)
        pipe.fileHandleForWriting.write(framed)
        try pipe.fileHandleForWriting.close()
        XCTAssertEqual(NativeMessagingHost.readMessage(from: pipe.fileHandleForReading)?["type"] as? String, "invalid")
    }
}

final class NativeMessagingInstallerTests: XCTestCase {
    private var support: URL!
    private let extensionID = "abcdefghijklmnopabcdefghijklmnop"
    private let executable = "/Applications/Sipper.app/Contents/MacOS/Sipper"

    override func setUp() {
        super.setUp()
        support = TestSupport.makeTemporaryDirectory(for: self)
    }

    private func makeInstaller(executablePath: String? = nil, extensionID: String? = nil) -> NativeMessagingInstaller {
        NativeMessagingInstaller(extensionID: extensionID ?? self.extensionID,
                                 executablePath: executablePath ?? executable,
                                 applicationSupport: support)
    }

    private func browser(_ id: String) -> NativeMessagingInstaller.Browser {
        NativeMessagingInstaller.browsers.first { $0.id == id }!
    }

    private func manifestObject(at url: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func testManifestContent() {
        let manifest = makeInstaller().manifest()
        XCTAssertEqual(manifest["name"] as? String, "com.hybes.sipper")
        XCTAssertEqual(manifest["name"] as? String, NativeMessagingHost.hostName)
        XCTAssertEqual(manifest["path"] as? String, executable)
        XCTAssertEqual(manifest["type"] as? String, "stdio")
        XCTAssertEqual(manifest["allowed_origins"] as? [String], ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
                       "Chrome requires the trailing slash on the origin")
        XCTAssertFalse((manifest["description"] as? String ?? "").isEmpty)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(manifest))
    }

    func testManifestLocationsFollowChromeConventions() {
        let installer = makeInstaller()
        XCTAssertEqual(installer.manifestURL(for: browser("chrome")).path,
                       support.appendingPathComponent("Google/Chrome/NativeMessagingHosts/com.hybes.sipper.json").path)
        XCTAssertEqual(installer.manifestURL(for: browser("edge")).lastPathComponent, "com.hybes.sipper.json")
        XCTAssertEqual(installer.manifestURL(for: browser("arc")).path,
                       support.appendingPathComponent("Arc/User Data/NativeMessagingHosts/com.hybes.sipper.json").path)
        XCTAssertEqual(Set(NativeMessagingInstaller.browsers.map(\.id)).count, NativeMessagingInstaller.browsers.count, "browser ids are unique")
    }

    func testInstallForAllBrowsersWritesEveryManifestAndStatusReportsInstalled() throws {
        let installer = makeInstaller()
        let written = try installer.install(includeMissingBrowsers: true)
        XCTAssertEqual(written.map(\.id), NativeMessagingInstaller.browsers.map(\.id))

        for browser in NativeMessagingInstaller.browsers {
            let url = installer.manifestURL(for: browser)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "\(browser.name) manifest missing")
            let object = try manifestObject(at: url)
            XCTAssertEqual(object["path"] as? String, executable, browser.name)
            XCTAssertEqual(object["allowed_origins"] as? [String], ["chrome-extension://\(extensionID)/"], browser.name)
            XCTAssertEqual(object["name"] as? String, NativeMessagingHost.hostName, browser.name)
        }

        let entries = installer.status()
        XCTAssertEqual(entries.count, NativeMessagingInstaller.browsers.count)
        for entry in entries {
            XCTAssertEqual(entry.status, .installed, entry.browser.name)
            XCTAssertEqual(entry.manifestPath, installer.manifestURL(for: entry.browser).path)
        }
    }

    func testInstallIsIdempotentAndOverwritesStaleManifests() throws {
        let stale = makeInstaller(executablePath: "/old/location/Sipper")
        try stale.install(includeMissingBrowsers: true)
        let current = makeInstaller()
        XCTAssertEqual(current.status().map(\.status), Array(repeating: .installedElsewhere(path: "/old/location/Sipper"), count: NativeMessagingInstaller.browsers.count))

        try current.install(includeMissingBrowsers: true)
        try current.install(includeMissingBrowsers: true)
        XCTAssertTrue(current.status().allSatisfy { $0.status == .installed })
        XCTAssertEqual(try manifestObject(at: current.manifestURL(for: browser("chrome")))["path"] as? String, executable)
    }

    func testStatusDistinguishesNotInstalledInstalledElsewhereAndInstalled() throws {
        let installer = makeInstaller()
        let chrome = browser("chrome")
        let edge = browser("edge")
        let chromium = browser("chromium")

        // Chrome's profile directory exists but there is no manifest.
        try FileManager.default.createDirectory(at: support.appendingPathComponent(chrome.supportSubdirectory, isDirectory: true),
                                                withIntermediateDirectories: true)
        // Edge has a manifest that points at a different binary.
        let edgeURL = installer.manifestURL(for: edge)
        try FileManager.default.createDirectory(at: edgeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var foreign = installer.manifest()
        foreign["path"] = "/Volumes/Other/Sipper.app/Contents/MacOS/Sipper"
        try JSONSerialization.data(withJSONObject: foreign).write(to: edgeURL)
        // Chromium has a manifest for our binary but a different extension.
        let chromiumURL = installer.manifestURL(for: chromium)
        try FileManager.default.createDirectory(at: chromiumURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var otherExtension = installer.manifest()
        otherExtension["allowed_origins"] = ["chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/"]
        try JSONSerialization.data(withJSONObject: otherExtension).write(to: chromiumURL)

        let byID = Dictionary(uniqueKeysWithValues: installer.status().map { ($0.id, $0.status) })
        XCTAssertEqual(byID["chrome"], .notInstalled)
        XCTAssertEqual(byID["edge"], .installedElsewhere(path: "/Volumes/Other/Sipper.app/Contents/MacOS/Sipper"))
        XCTAssertEqual(byID["chromium"], .installedElsewhere(path: executable), "a manifest for another extension must be replaced")
        for entry in installer.status() where !["chrome", "edge", "chromium"].contains(entry.id) {
            XCTAssertTrue(entry.status == .notInstalled || entry.status == .browserMissing, "\(entry.browser.name): \(entry.status)")
        }
    }

    func testUnreadableManifestCountsAsInstalledElsewhere() throws {
        let installer = makeInstaller()
        let url = installer.manifestURL(for: browser("vivaldi"))
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: url)
        let status = installer.status().first { $0.id == "vivaldi" }?.status
        XCTAssertEqual(status, .installedElsewhere(path: ""), "an empty manifest is present but not ours")
    }

    func testInstallWithoutMissingBrowsersOnlyWritesDetectedOnes() throws {
        let installer = makeInstaller()
        let chromium = browser("chromium")
        try FileManager.default.createDirectory(at: support.appendingPathComponent(chromium.supportSubdirectory, isDirectory: true),
                                                withIntermediateDirectories: true)

        let written = try installer.install(includeMissingBrowsers: false)
        XCTAssertTrue(written.contains(chromium), "a browser with a profile directory counts as installed")
        for browser in NativeMessagingInstaller.browsers {
            let exists = FileManager.default.fileExists(atPath: installer.manifestURL(for: browser).path)
            XCTAssertEqual(exists, written.contains(browser), "\(browser.name) manifest presence should match the returned list")
        }
    }

    func testUninstallRemovesEveryManifest() throws {
        let installer = makeInstaller()
        try installer.install(includeMissingBrowsers: true)
        installer.uninstall()
        for browser in NativeMessagingInstaller.browsers {
            XCTAssertFalse(FileManager.default.fileExists(atPath: installer.manifestURL(for: browser).path), browser.name)
        }
        XCTAssertFalse(installer.status().contains { $0.status == .installed })
        installer.uninstall() // a second uninstall must not throw or crash
    }

    func testDefaultsPointAtTheRunningBinaryAndPinnedExtension() {
        let installer = NativeMessagingInstaller(applicationSupport: support)
        XCTAssertEqual(installer.extensionID, ChromeExtension.pinnedID)
        XCTAssertEqual(installer.executablePath, Bundle.main.executableURL?.path ?? "")
        XCTAssertEqual(installer.applicationSupport, support)
    }
}
