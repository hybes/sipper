import Foundation

enum DevelopmentEnvironment {
    static var profileDirectory: String? {
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["SIPPER_PROFILE_DIRECTORY"], path.hasPrefix("/") { return path }
        if Bundle.main.bundleIdentifier == "com.hybes.sipper.development" {
            return FileManager.default.temporaryDirectory.appendingPathComponent("Sipper-Managed-Development").path
        }
        #endif
        return nil
    }

    static var managedServer: URL? {
        #if DEBUG
        guard profileDirectory != nil else { return nil }
        if let value = ProcessInfo.processInfo.environment["SIPPER_MANAGED_SERVER"] { return URL(string: value) }
        if Bundle.main.bundleIdentifier == "com.hybes.sipper.development" { return URL(string: "http://localhost:3100") }
        #endif
        return nil
    }
}
