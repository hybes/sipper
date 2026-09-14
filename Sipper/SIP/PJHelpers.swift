import Foundation

/// Owns C strings for the lifetime of a pjsua call that copies its inputs.
final class CStringPool {
    private var pointers: [UnsafeMutablePointer<CChar>] = []

    func pj(_ string: String) -> pj_str_t {
        let copy = strdup(string)!
        pointers.append(copy)
        return pj_str_t(ptr: copy, slen: pj_ssize_t(strlen(copy)))
    }

    deinit {
        pointers.forEach { free($0) }
    }
}

extension pj_str_t {
    var string: String {
        guard let ptr, slen > 0 else { return "" }
        return String(decoding: UnsafeRawBufferPointer(start: UnsafeRawPointer(ptr), count: Int(slen)), as: UTF8.self)
    }
}

/// Converts fixed-size C char arrays (imported as tuples) to Swift strings.
func cString<T>(_ tuple: T) -> String {
    withUnsafeBytes(of: tuple) { raw in
        let bytes = raw.prefix { $0 != 0 }
        return String(decoding: bytes, as: UTF8.self)
    }
}

func pjErrorMessage(_ status: pj_status_t) -> String {
    var buffer = [CChar](repeating: 0, count: 256)
    sipper_pj_strerror(status, &buffer, buffer.count)
    return String(cString: buffer)
}

func pjCheck(_ status: pj_status_t, _ operation: String) throws {
    guard status == PJ_SUCCESS.rawValue else {
        throw SIPEngineError.pjsip(operation: operation, status: status, message: pjErrorMessage(status))
    }
}

extension pj_status_t {
    var isSuccess: Bool { self == PJ_SUCCESS.rawValue }
}
