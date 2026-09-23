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

/// A window candidate reduced to exactly what selection needs. `SCWindow` has no public
/// initializer, so this is what makes `selectCaptureWindowIndex` testable without the real OS.
struct CapturableWindow: Equatable {
    let bundleId: String?
    let isOnScreen: Bool
    let frame: CGRect
}

/// Confirmed live against Ghostty: an app can register more than one on-screen window for
/// itself — an untitled decorative sliver (a tab bar or title strip) alongside the real content
/// window — and picking the first match has no reason to prefer the real one. The largest by
/// area reliably is the real one; a decorative sliver is never the biggest thing on screen.
/// Returns an index into `windows` rather than a window, so the caller can look up whatever
/// richer type (a real `SCWindow`) that index actually came from.
func selectCaptureWindowIndex(from windows: [CapturableWindow], bundleId: String) -> Int? {
    windows.indices
        .filter { windows[$0].bundleId == bundleId && windows[$0].isOnScreen }
        .max(by: { windows[$0].frame.width * windows[$0].frame.height
            < windows[$1].frame.width * windows[$1].frame.height })
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
        let candidates = content.windows.map {
            CapturableWindow(bundleId: $0.owningApplication?.bundleIdentifier, isOnScreen: $0.isOnScreen, frame: $0.frame)
        }
        guard
            let index = selectCaptureWindowIndex(from: candidates, bundleId: bundleId)
        else {
            throw ScreenCaptureError.windowNotFound
        }
        let window = content.windows[index]

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = Self.maxDimension / max(window.frame.width, window.frame.height, 1)
        config.width = Int(window.frame.width * min(scale, 1))
        config.height = Int(window.frame.height * min(scale, 1))
        // `window.frame` is in points; the window's actual captured content renders at the
        // display's native (often 2x Retina) pixel size. Without this, ScreenCaptureKit draws
        // that native-size content at the top-left corner of the width/height above and leaves
        // the rest of the buffer blank, instead of scaling the real content down to fit — the
        // "real content squeezed into a strip, blank elsewhere" bug this fixes.
        config.scalesToFit = true
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
