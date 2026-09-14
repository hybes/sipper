import XCTest
@testable import Sipper

final class RecordingConverterTests: XCTestCase {
    func testConvertsWAVToM4A() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sipper-rec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wav = directory.appendingPathComponent("2026-09-08 12.00.00 from 1002 via 1001 · Test.wav")
        try RingtoneSynth.wavData(for: .classicUK).write(to: wav)

        let done = expectation(description: "conversion finished")
        var outcome: Result<URL, Error>?
        RecordingConverter.convertToM4A(wav) { result in
            outcome = result
            done.fulfill()
        }
        wait(for: [done], timeout: 30)

        let url = try XCTUnwrap(outcome).get()
        XCTAssertEqual(url.pathExtension, "m4a")
        let size = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        XCTAssertGreaterThan(size, 1000, "an audible ringtone should encode to more than a header")
    }
}
