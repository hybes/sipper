import AVFoundation
import Foundation

/// Converts PJSIP's WAV recordings to AAC (.m4a) to save space.
enum RecordingConverter {
    enum ConversionError: LocalizedError {
        case unsupported
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .unsupported: return "This Mac cannot export AAC audio."
            case .failed(let detail): return detail
            }
        }
    }

    static func convertToM4A(_ source: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        let asset = AVURLAsset(url: source)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            completion(.failure(ConversionError.unsupported))
            return
        }
        let destination = source.deletingPathExtension().appendingPathExtension("m4a")
        try? FileManager.default.removeItem(at: destination)
        session.outputURL = destination
        session.outputFileType = .m4a
        session.exportAsynchronously {
            DispatchQueue.main.async {
                switch session.status {
                case .completed:
                    completion(.success(destination))
                default:
                    completion(.failure(ConversionError.failed(session.error?.localizedDescription ?? "Export did not complete.")))
                }
            }
        }
    }
}
