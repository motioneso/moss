import AppKit
import ScreenCaptureKit

enum ScreenCaptureError: Error, Equatable {
    /// No on-screen window matches the bundle id, or Screen Recording was refused between the
    /// permission check and the capture.
    case windowNotFound
    case captureFailed
}

/// Captures the single frontmost window for one app, downscaled, and hands back JPEG bytes held
/// only in memory (rung3 spec §4). A protocol so the escalation logic in `FocusRuntime` can be
/// tested without ever asking the real OS for a screen.
protocol WindowCapturing {
    func captureFrontmostWindow(bundleId: String) async throws -> Data
}

struct ScreenCaptureKitCapture: WindowCapturing {
    /// The longest side after downscaling. A vision model answering "what is this" needs far less
    /// than a full-resolution Retina screenshot, and every extra pixel is more image data leaving
    /// the Mac.
    static let maxDimension: CGFloat = 1024

    func captureFrontmostWindow(bundleId: String) async throws -> Data {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        guard
            let window = content.windows.first(where: {
                $0.owningApplication?.bundleIdentifier == bundleId && $0.isOnScreen
            })
        else {
            throw ScreenCaptureError.windowNotFound
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = Self.maxDimension / max(window.frame.width, window.frame.height, 1)
        config.width = Int(window.frame.width * min(scale, 1))
        config.height = Int(window.frame.height * min(scale, 1))
        config.showsCursor = false

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            throw ScreenCaptureError.captureFailed
        }

        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6])
        else {
            throw ScreenCaptureError.captureFailed
        }
        return jpeg
    }
}
