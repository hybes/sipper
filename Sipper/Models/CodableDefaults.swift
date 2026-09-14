import Foundation

extension Date {
    /// Now, rounded to whole milliseconds so a timestamp compares equal after a JSON round trip.
    static func stamp() -> Date {
        Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded() / 1000)
    }
}

enum JSONDates {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// ISO 8601 with milliseconds.
    static let encoding = JSONEncoder.DateEncodingStrategy.custom { date, encoder in
        var container = encoder.singleValueContainer()
        try container.encode(fractional.string(from: date))
    }

    /// Accepts ISO 8601 with or without fractional seconds (older files have none).
    static let decoding = JSONDecoder.DateDecodingStrategy.custom { decoder in
        let container = try decoder.singleValueContainer()
        let string = try container.decode(String.self)
        if let date = fractional.date(from: string) ?? whole.date(from: string) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognised date \(string)")
    }
}

/// Decoding helpers so persisted JSON keeps working when new fields are added.
extension KeyedDecodingContainer {
    func decode<T: Decodable>(_ key: Key, default defaultValue: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? defaultValue
    }

    func decodeOptional<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }
}
