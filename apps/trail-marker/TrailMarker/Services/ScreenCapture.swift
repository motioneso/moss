import AppKit
import ScreenCaptureKit

enum ScreenCaptureError: Error, Equatable {
    /// No on-screen window of the app is exactly the one Accessibility identified: none matched
    /// or more than one did (#2643). Nothing is captured.
    ///
    /// `debugDetail` lists the identity and every same-process candidate (title, frame,
    /// on-screen). It is filled only in Debug builds, for the on-screen focus log; a Release build
    /// leaves it empty, so window titles never reach an error that could be shown or sent.
    case noMatchingWindow(debugDetail: String)
    /// A window was captured, but Accessibility's focused window changed while it was taken, so
    /// the picture is dropped. `debugDetail` (Debug only) has the before and after identities.
    case focusMovedDuringCapture(debugDetail: String)
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
    /// Kept for the Debug diagnostics only; matching uses the frame (see `matchesCaptureWindow`).
    let title: String?
    let isOnScreen: Bool
    let frame: CGRect
}

/// The one on-screen window of `pid` whose frame matches `identity`, or nil when there
/// isn't exactly one. Replaces "the app's largest window" (#2643): a small ordinary window in
/// front of a larger private one of the same browser must never authorise a picture of the
/// private one. Two identical candidates are ambiguous, so neither is taken.
func matchCaptureWindowIndex(
    from windows: [CapturableWindow], pid: pid_t, identity: WindowIdentity
) -> Int? {
    let matches = windows.indices.filter {
        let window = windows[$0]
        return window.pid == pid && window.isOnScreen
            && identity.matchesCaptureWindow(frame: window.frame)
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

    func capture(
        _ identity: WindowIdentity, pid: pid_t, maxDimension: CGFloat = Self.maxDimension
    ) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        let candidates = content.windows.map {
            CapturableWindow(
                pid: $0.owningApplication?.processID, title: $0.title, isOnScreen: $0.isOnScreen, frame: $0.frame
            )
        }
        guard let index = matchCaptureWindowIndex(from: candidates, pid: pid, identity: identity) else {
            throw ScreenCaptureError.noMatchingWindow(
                debugDetail: CaptureDiagnostics.noMatch(identity: identity, pid: pid, candidates: candidates)
            )
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

        let after = focusedWindow(pid)
        guard let after, after.matches(identity) else {
            throw ScreenCaptureError.focusMovedDuringCapture(
                debugDetail: CaptureDiagnostics.moved(before: identity, after: after)
            )
        }
        return image
    }
}

/// Text for the Debug focus log only. Every function returns "" in a Release build, so no
/// window title is ever formatted outside Debug.
enum CaptureDiagnostics {
    static func describe(_ identity: WindowIdentity?) -> String {
        guard let identity else { return "none (Accessibility couldn't read it)" }
        return "\"\(identity.title)\" \(frameText(identity.frame))"
    }

    static func noMatch(identity: WindowIdentity, pid: pid_t, candidates: [CapturableWindow]) -> String {
        #if DEBUG
        let own = candidates.filter { $0.pid == pid }
        var lines = [
            "no single matching window. AX: \(describe(identity)); \(own.count) window(s) of pid \(pid):"
        ]
        for window in own {
            let title = window.title.map { "\"\($0)\"" } ?? "(title unreadable)"
            lines.append("  \(title) \(frameText(window.frame)) onScreen=\(window.isOnScreen)")
        }
        return lines.joined(separator: "\n")
        #else
        return ""
        #endif
    }

    static func moved(before: WindowIdentity, after: WindowIdentity?) -> String {
        #if DEBUG
        return "focus moved during capture. before: \(describe(before)); after: \(describe(after))"
        #else
        return ""
        #endif
    }

    private static func frameText(_ frame: CGRect) -> String {
        "(\(Int(frame.minX)), \(Int(frame.minY)), \(Int(frame.width))x\(Int(frame.height)))"
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
