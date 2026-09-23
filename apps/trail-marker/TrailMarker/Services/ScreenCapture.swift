import AppKit
import ScreenCaptureKit

enum ScreenCaptureError: Error, Equatable {
    /// No on-screen window is exactly the one the policy checked: none matched, more than one
    /// matched, or focus moved to another window while the picture was being taken (#2643).
    /// Nothing is described.
    case identityMismatch
    /// Screen Recording was refused between the permission check and the capture, or the capture
    /// itself failed.
    case captureFailed
}

/// Captures one specific window, the one `Observation.window` identified, downscaled and held
/// only in memory (rung3 spec §4). A protocol so the escalation logic in `FocusRuntime` can be
/// tested without ever asking the real OS for a screen.
protocol WindowCapturing {
    func capture(_ window: WindowIdentity, pid: pid_t, maxDimension: CGFloat) async throws -> CGImage
}

/// A window candidate reduced to exactly what matching needs. `SCWindow` has no public
/// initializer, so this is what makes `matchCaptureWindowIndex` testable without the real OS.
struct CapturableWindow: Equatable {
    let pid: pid_t?
    /// Nil when ScreenCaptureKit can't read it; a window with no readable title never matches.
    let title: String?
    let isOnScreen: Bool
    let frame: CGRect
}

/// The one on-screen window of `pid` whose frame and title match `identity`, or nil when there
/// isn't exactly one. Replaces "the app's largest window" (#2643): a small ordinary window in
/// front of a larger private one of the same browser must never authorise a picture of the
/// private one. Two identical candidates are ambiguous, so neither is taken.
func matchCaptureWindowIndex(from windows: [CapturableWindow], pid: pid_t, identity: WindowIdentity) -> Int? {
    let matches = windows.indices.filter {
        windows[$0].pid == pid && windows[$0].isOnScreen
            && identity.matches(frame: windows[$0].frame, title: windows[$0].title)
    }
    return matches.count == 1 ? matches[0] : nil
}

struct ScreenCaptureKitCapture: WindowCapturing {
    /// The longest side after downscaling. A vision model answering "what is this" needs far less
    /// than a full-resolution Retina screenshot, and every extra pixel is more image data leaving
    /// the Mac.
    static let maxDimension: CGFloat = 1024

    /// Re-reads the app's focused window after the picture is taken, so a focus change during the
    /// capture discards it. Injectable for tests; the real one asks Accessibility.
    var focusedWindow: (pid_t) -> WindowIdentity? = { WorkspaceFrontmostSource.focusedWindowIdentity(pid: $0) }

    func capture(_ identity: WindowIdentity, pid: pid_t, maxDimension: CGFloat = Self.maxDimension) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        let candidates = content.windows.map {
            CapturableWindow(
                pid: $0.owningApplication?.processID, title: $0.title, isOnScreen: $0.isOnScreen, frame: $0.frame
            )
        }
        guard let index = matchCaptureWindowIndex(from: candidates, pid: pid, identity: identity) else {
            throw ScreenCaptureError.identityMismatch
        }
        let window = content.windows[index]

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = maxDimension / max(window.frame.width, window.frame.height, 1)
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

        guard let now = focusedWindow(pid), now.matches(identity) else {
            throw ScreenCaptureError.identityMismatch
        }
        return image
    }
}

/// The picture only becomes bytes on its way to a vision source (or the Test preview), never
/// earlier, so Focus and later Backtrack share one in-memory image type.
enum JPEGEncoding {
    static func encode(_ image: CGImage) throws -> Data {
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
            throw ScreenCaptureError.captureFailed
        }
        return jpeg
    }
}
