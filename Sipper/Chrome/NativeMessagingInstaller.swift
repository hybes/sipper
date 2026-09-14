import Foundation

/// Writes the native messaging host manifest for Chromium-based browsers so the
/// Chrome extension can talk to Sipper without the "Open Sipper?" prompt.
struct NativeMessagingInstaller {
    struct Browser: Identifiable, Hashable {
        let id: String
        let name: String
        /// Directory that holds NativeMessagingHosts, relative to ~/Library/Application Support.
        let supportSubdirectory: String
        /// App bundle names used to detect whether the browser is installed.
        let appNames: [String]
    }

    enum Status: Equatable {
        case notInstalled
        case installed
        case installedElsewhere(path: String)
        case browserMissing
    }

    struct Entry: Identifiable, Equatable {
        let browser: Browser
        var status: Status
        var manifestPath: String
        var id: String { browser.id }
    }

    static let browsers: [Browser] = [
        Browser(id: "chrome", name: "Google Chrome", supportSubdirectory: "Google/Chrome", appNames: ["Google Chrome"]),
        Browser(id: "chrome-beta", name: "Google Chrome Beta", supportSubdirectory: "Google/Chrome Beta", appNames: ["Google Chrome Beta"]),
        Browser(id: "chromium", name: "Chromium", supportSubdirectory: "Chromium", appNames: ["Chromium"]),
        Browser(id: "edge", name: "Microsoft Edge", supportSubdirectory: "Microsoft Edge", appNames: ["Microsoft Edge"]),
        Browser(id: "vivaldi", name: "Vivaldi", supportSubdirectory: "Vivaldi", appNames: ["Vivaldi"]),
        Browser(id: "arc", name: "Arc", supportSubdirectory: "Arc/User Data", appNames: ["Arc"]),
        Browser(id: "helium", name: "Helium", supportSubdirectory: "net.imput.helium", appNames: ["Helium"]),
        // Brave reads Chrome's directory; it is covered by the Chrome entry.
    ]

    /// Extension ID pinned by the manifest "key" in extension/manifest.json.
    static let defaultExtensionID = ChromeExtension.pinnedID

    let extensionID: String
    let executablePath: String
    let applicationSupport: URL

    init(extensionID: String = NativeMessagingInstaller.defaultExtensionID,
         executablePath: String = Bundle.main.executableURL?.path ?? "",
         applicationSupport: URL? = nil) {
        self.extensionID = extensionID
        self.executablePath = executablePath
        self.applicationSupport = applicationSupport
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    func manifestURL(for browser: Browser) -> URL {
        applicationSupport
            .appendingPathComponent(browser.supportSubdirectory, isDirectory: true)
            .appendingPathComponent("NativeMessagingHosts", isDirectory: true)
            .appendingPathComponent("\(NativeMessagingHost.hostName).json")
    }

    func manifest() -> [String: Any] {
        [
            "name": NativeMessagingHost.hostName,
            "description": "Sipper SIP phone",
            "path": executablePath,
            "type": "stdio",
            "allowed_origins": ["chrome-extension://\(extensionID)/"],
        ]
    }

    func isBrowserInstalled(_ browser: Browser) -> Bool {
        let supportDir = applicationSupport.appendingPathComponent(browser.supportSubdirectory, isDirectory: true)
        if FileManager.default.fileExists(atPath: supportDir.path) { return true }
        for name in browser.appNames {
            for base in ["/Applications", NSHomeDirectory() + "/Applications"] {
                if FileManager.default.fileExists(atPath: "\(base)/\(name).app") { return true }
            }
        }
        return false
    }

    func status() -> [Entry] {
        Self.browsers.map { browser in
            let url = manifestURL(for: browser)
            var status: Status = isBrowserInstalled(browser) ? .notInstalled : .browserMissing
            if let data = try? Data(contentsOf: url),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let path = object["path"] as? String ?? ""
                let origins = object["allowed_origins"] as? [String] ?? []
                if path == executablePath, origins.contains("chrome-extension://\(extensionID)/") {
                    status = .installed
                } else {
                    status = .installedElsewhere(path: path)
                }
            }
            return Entry(browser: browser, status: status, manifestPath: url.path)
        }
    }

    /// Installs for every browser that appears to be present. Returns the browsers written.
    @discardableResult
    func install(includeMissingBrowsers: Bool = false) throws -> [Browser] {
        var written: [Browser] = []
        let data = try JSONSerialization.data(withJSONObject: manifest(), options: [.prettyPrinted, .sortedKeys])
        for browser in Self.browsers where includeMissingBrowsers || isBrowserInstalled(browser) {
            let url = manifestURL(for: browser)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            written.append(browser)
        }
        return written
    }

    func uninstall() {
        for browser in Self.browsers {
            try? FileManager.default.removeItem(at: manifestURL(for: browser))
        }
    }
}

enum ChromeExtension {
    /// Must match extension/EXTENSION_ID. Updated when the extension key changes.
    static let pinnedID = "gdijljkcflnaikcbjeahedncdgbceehp"
}
