import Combine
import Foundation
import Sparkle

/// In-app updates through Sparkle. The feed, signing key and check interval are in Info.plist
/// (project.yml); every update is checked against the EdDSA key and Sipper's code signature.
@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published private(set) var canCheckForUpdates = false
    @Published var automaticallyChecksForUpdates = false {
        didSet {
            guard let updater, updater.automaticallyChecksForUpdates != automaticallyChecksForUpdates else { return }
            updater.automaticallyChecksForUpdates = automaticallyChecksForUpdates
        }
    }
    /// Unavailable in development and test builds, which have another bundle ID or no published feed.
    let isAvailable: Bool
    private var controller: SPUStandardUpdaterController?
    private var updater: SPUUpdater? { controller?.updater }
    private var observation: AnyCancellable?

    override init() {
        let environment = ProcessInfo.processInfo.environment
        let testing = NSClassFromString("XCTestCase") != nil || environment["XCTestConfigurationFilePath"] != nil
        isAvailable = !testing && Bundle.main.bundleIdentifier == "com.hybes.sipper"
            && Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil
        super.init()
        guard isAvailable else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        automaticallyChecksForUpdates = controller.updater.automaticallyChecksForUpdates
        observation = controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in self?.canCheckForUpdates = value }
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }

    var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "dev"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// SIPPER_UPDATE_FEED_URL points a copy at a local test feed. Updates must still carry a valid
    /// EdDSA signature from Sipper's key and the same code signature, so this cannot install other software.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        ProcessInfo.processInfo.environment["SIPPER_UPDATE_FEED_URL"]
    }
}
