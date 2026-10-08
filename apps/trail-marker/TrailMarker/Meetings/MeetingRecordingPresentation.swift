import Foundation

/// Local UI state for one accepted Start. Closing a pill never changes capture authority.
/// Samples are amplitude scalars only and are never included in status or diagnostics.
struct MeetingRecordingPresentation: Equatable {
    enum State: String { case recording = "Recording", paused = "Paused", noAudio = "No audio", reconnecting = "Reconnecting" }
    private(set) var active = false
    private(set) var hidden = false
    private(set) var state: State = .noAudio
    private(set) var elapsedMilliseconds: UInt64 = 0
    private(set) var meterLevels = [Float](repeating: 0, count: 3)
    var showsPill: Bool { active && !hidden }
    var showsRedDot: Bool { active }
    var elapsedText: String {
        let seconds = elapsedMilliseconds / 1000
        return String(format: "%02llu:%02llu", seconds / 60, seconds % 60)
    }

    mutating func acceptedStart() {
        self = Self()
        active = true
    }
    mutating func hide() { hidden = true }
    mutating func show() { hidden = false }
    mutating func stop() { self = Self() }

    mutating func update(phase: MeetingCaptureHost.Phase, reconnecting: Bool, elapsedMilliseconds: UInt64, level: Float) {
        guard active else { return }
        guard [.ready, .recording, .paused].contains(phase) else { stop(); return }
        self.elapsedMilliseconds = elapsedMilliseconds
        let captured = phase == .recording && level.isFinite ? min(1, max(0, level)) : 0
        if phase == .paused { state = .paused }
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
