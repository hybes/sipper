import Foundation

/// Chrome native messaging host mode. Chrome launches the Sipper binary with the
/// extension origin as its first argument and talks JSON over stdin/stdout with a
/// 4-byte native-endian length prefix. See docs/PROTOCOL.md.
enum NativeMessagingHost {
    static let hostName = "com.hybes.sipper"

    static func shouldRun(arguments: [String]) -> Bool {
        arguments.dropFirst().contains { $0.hasPrefix("chrome-extension://") || $0 == "--native-messaging-host" }
    }

    static func run() -> Never {
        let input = FileHandle.standardInput
        let output = FileHandle.standardOutput
        while let message = readMessage(from: input) {
            let response = handle(message)
            write(response, to: output)
        }
        exit(0)
    }

    static func readMessage(from handle: FileHandle) -> [String: Any]? {
        let header = handle.readData(ofLength: 4)
        guard header.count == 4 else { return nil }
        let length = header.withUnsafeBytes { $0.load(as: UInt32.self) }
        guard length > 0, length < 64 * 1024 * 1024 else { return nil }
        var body = Data()
        while body.count < Int(length) {
            let chunk = handle.readData(ofLength: Int(length) - body.count)
            if chunk.isEmpty { return nil }
            body.append(chunk)
        }
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            return ["type": "invalid"]
        }
        return object
    }

    static func write(_ message: [String: Any], to handle: FileHandle) {
        guard let body = try? JSONSerialization.data(withJSONObject: message) else { return }
        var length = UInt32(body.count)
        var data = Data(bytes: &length, count: 4)
        data.append(body)
        handle.write(data)
    }

    static func handle(_ message: [String: Any]) -> [String: Any] {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        switch message["type"] as? String {
        case "ping":
            return ["ok": true, "type": "pong", "version": version]
        case "add-accounts":
            guard let payload = message["payload"] else {
                return ["ok": false, "error": "Missing payload."]
            }
            guard payload is [String: Any], JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload) else {
                return ["ok": false, "error": "Payload is not valid JSON."]
            }
            do {
                let request = try ImportParser.parse(json: data)
                guard let url = ImportParser.makeURL(jsonData: data) else {
                    return ["ok": false, "error": "Could not build the import link."]
                }
                try openInApp(url)
                return ["ok": true, "type": "queued", "count": request.candidates.count]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        case "invalid":
            return ["ok": false, "error": "Message was not valid JSON."]
        default:
            return ["ok": false, "error": "Unknown message type."]
        }
    }

    /// Hands the URL to the running app (or launches it) through Launch Services.
    private static func openInApp(_ url: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [url.absoluteString]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            throw NSError(domain: "Sipper", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: "Could not open Sipper (open exited with \(process.terminationStatus))."])
        }
    }
}
