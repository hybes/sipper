import Foundation

/// Ring buffer of PJSIP log lines. Appends can come from any thread; readers use
/// `snapshot()`. `onChange` is coalesced and delivered on the main thread.
final class SIPLogBuffer {
    private let lock = NSLock()
    private var lines: [String] = []
    private var pendingNotify = false
    let capacity: Int

    var onChange: (() -> Void)?

    init(capacity: Int = 4000) {
        self.capacity = capacity
    }

    /// Set SIPPER_LOG_STDERR=1 to mirror app log lines to stderr (development aid).
    private static let mirrorsToStandardError = ProcessInfo.processInfo.environment["SIPPER_LOG_STDERR"] == "1"

    func append(_ line: String) {
        if Self.mirrorsToStandardError, line.hasPrefix("Sipper:") {
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }
        lock.lock()
        lines.append(line)
        if lines.count > capacity {
            lines.removeFirst(lines.count - capacity)
        }
        let shouldNotify = !pendingNotify
        pendingNotify = true
        lock.unlock()

        if shouldNotify {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                self.pendingNotify = false
                self.lock.unlock()
                self.onChange?()
            }
        }
    }

    func snapshot() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return lines
    }

    func clear() {
        lock.lock()
        lines.removeAll()
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.onChange?() }
    }

    func export() -> String {
        snapshot().joined(separator: "\n")
    }
}
