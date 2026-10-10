import Foundation

/// Local UI state for one accepted Start. Closing a pill never changes capture authority.
/// Samples are amplitude scalars only and are never included in status or diagnostics.
struct MeetingRecordingPresentation: Equatable {
    enum State: String {
        case recording = "Recording", paused = "Paused", noAudio = "No audio", reconnecting = "Reconnecting"
        case recovering = "Recovering audio…", interrupted = "Recording paused", error = "Capture needs attention"
    }
    private(set) var active = false
    private(set) var hidden = false
    private(set) var state: State = .noAudio
    private(set) var interruptionWarning: String?
    private(set) var canPause = false
    private(set) var elapsedMilliseconds: UInt64 = 0
    private(set) var meterLevels = [Float](repeating: 0, count: 3)
    var showsAttention: Bool { interruptionWarning != nil || (active && state == .recovering) }
    var canHide: Bool { !showsAttention }
    var showsPill: Bool { showsAttention || (active && !hidden) }
    var showsRedDot: Bool { active }
    var elapsedText: String {
        let seconds = elapsedMilliseconds / 1000
        return String(format: "%02llu:%02llu", seconds / 60, seconds % 60)
    }

    mutating func acceptedStart() {
        self = Self()
        active = true
    }
    mutating func hide() { if canHide { hidden = true } }
    mutating func show() { hidden = false }
    mutating func stop() { self = Self() }

    mutating func update(phase: MeetingCaptureHost.Phase, reconnecting: Bool, elapsedMilliseconds: UInt64,
                         level: Float, interruptionWarning: String? = nil) {
        self.interruptionWarning = interruptionWarning
        canPause = phase == .recording || phase == .recovering
        if interruptionWarning != nil {
            canPause = false
            // Cleanup can fail after the session ended. Its warning must survive even when
            // the ordinary recording surfaces were already cleared or explicitly hidden.
            if ![.ready, .recording, .recovering, .paused].contains(phase) { active = false }
            state = phase == .error ? .error : .interrupted
            self.elapsedMilliseconds = elapsedMilliseconds
            meterLevels = [Float](repeating: 0, count: meterLevels.count)
            return
        }
        guard active else { canPause = false; return }
        guard [.ready, .recording, .recovering, .paused].contains(phase) else { stop(); return }
        self.elapsedMilliseconds = elapsedMilliseconds
        let captured = phase == .recording && level.isFinite ? min(1, max(0, level)) : 0
        if phase == .recovering { state = .recovering }
        else if phase == .paused { state = .paused }
        else if reconnecting { state = .reconnecting }
        else { state = captured > 0 ? .recording : .noAudio }
        if captured == 0 {
            meterLevels = [Float](repeating: 0, count: meterLevels.count)
        } else {
            meterLevels.removeFirst()
            meterLevels.append(captured)
        }
    }
}
