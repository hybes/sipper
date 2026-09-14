import XCTest
@testable import Sipper

final class RingtoneSynthTests: XCTestCase {
    private func uint32(_ data: Data, at offset: Int) -> UInt32 {
        data.subdata(in: offset..<offset + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
    }

    private func uint16(_ data: Data, at offset: Int) -> UInt16 {
        data.subdata(in: offset..<offset + 2).withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) }.littleEndian
    }

    private func ascii(_ data: Data, at offset: Int) -> String {
        String(decoding: data.subdata(in: offset..<offset + 4), as: UTF8.self)
    }

    func testEveryRingtoneProducesAWellFormedWAVFile() {
        for choice in RingtoneChoice.allCases {
            let data = RingtoneSynth.wavData(for: choice)
            XCTAssertGreaterThan(data.count, 44, "\(choice) has no sample data")
            XCTAssertEqual(ascii(data, at: 0), "RIFF", "\(choice)")
            XCTAssertEqual(uint32(data, at: 4), UInt32(data.count - 8), "\(choice) RIFF chunk size")
            XCTAssertEqual(ascii(data, at: 8), "WAVE", "\(choice)")
            XCTAssertEqual(ascii(data, at: 12), "fmt ", "\(choice)")
            XCTAssertEqual(uint32(data, at: 16), 16, "\(choice) PCM fmt chunk length")
            XCTAssertEqual(uint16(data, at: 20), 1, "\(choice) PCM format tag")
            XCTAssertEqual(uint16(data, at: 22), 1, "\(choice) mono")
            XCTAssertEqual(uint32(data, at: 24), UInt32(RingtoneSynth.sampleRate), "\(choice) sample rate")
            XCTAssertEqual(uint32(data, at: 28), UInt32(RingtoneSynth.sampleRate) * 2, "\(choice) byte rate")
            XCTAssertEqual(uint16(data, at: 32), 2, "\(choice) block align")
            XCTAssertEqual(uint16(data, at: 34), 16, "\(choice) bits per sample")
            XCTAssertEqual(ascii(data, at: 36), "data", "\(choice)")
            XCTAssertEqual(uint32(data, at: 40), UInt32(data.count - 44), "\(choice) data chunk size")
            XCTAssertEqual((data.count - 44) % 2, 0, "\(choice) whole 16-bit samples")
        }
    }

    func testAudibleRingtonesContainSignalAndSilence() {
        for choice in RingtoneChoice.allCases where choice != .silent {
            let data = RingtoneSynth.wavData(for: choice)
            let pcm = data.subdata(in: 44..<data.count)
            let samples: [Int16] = pcm.withUnsafeBytes { raw in
                (0..<pcm.count / 2).map { raw.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self) }
            }
            let peak = samples.map { abs(Int($0)) }.max() ?? 0
            XCTAssertGreaterThan(peak, 8_000, "\(choice) should be clearly audible")
            XCTAssertLessThanOrEqual(peak, 32_000, "\(choice) must not clip")
            XCTAssertTrue(samples.suffix(Int(RingtoneSynth.sampleRate * 0.5)).allSatisfy { $0 == 0 },
                          "\(choice) should end with a pause so the loop has a ring cadence")
            XCTAssertGreaterThan(Double(samples.count) / RingtoneSynth.sampleRate, 1.0, "\(choice) one cadence is longer than a second")
        }
    }

    func testSilentRingtoneIsAllZeros() {
        let data = RingtoneSynth.wavData(for: .silent)
        let pcm = data.subdata(in: 44..<data.count)
        XCTAssertEqual(pcm.count, Int(RingtoneSynth.sampleRate) * 2, "one second of 16-bit silence")
        XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
    }

    func testCachedWAVReturnsTheSameBytesAsSynthesis() {
        XCTAssertEqual(RingtoneSynth.cachedWAV(for: .marimba), RingtoneSynth.wavData(for: .marimba))
        XCTAssertEqual(RingtoneSynth.cachedWAV(for: .marimba), RingtoneSynth.cachedWAV(for: .marimba))
    }

    func testRingtoneChoicesHaveDistinctDisplayNames() {
        let names = RingtoneChoice.allCases.map(\.displayName)
        XCTAssertEqual(Set(names).count, names.count)
        XCTAssertTrue(names.allSatisfy { !$0.isEmpty })
    }
}
