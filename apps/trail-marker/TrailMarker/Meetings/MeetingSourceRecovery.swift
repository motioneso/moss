import Foundation

/// One monotonic budget spans control retries and immediately recurring device faults.
/// Only sustained healthy callbacks replenish it; a successful RPC alone never does.
struct MeetingSourceRecoveryBudget {
    let deadline: UInt64
    private(set) var attempts = 0
    var healthySince: UInt64?
    private var priorCallbacks: [MeetingAudioSource: UInt64] = [:]

    init(now: UInt64, leaseDeadline: UInt64) {
        let (end, overflow) = now.addingReportingOverflow(12_000_000_000)
        deadline = min(overflow ? UInt64.max : end, leaseDeadline)
    }

    mutating func beginAttempt(at now: UInt64) -> Bool {
        guard now < deadline, attempts < 3 else { return false }
        attempts += 1
        healthySince = nil
        priorCallbacks = [:]
        return true
    }

    func remaining(at now: UInt64) -> TimeInterval {
        now < deadline ? Double(deadline - now) / 1_000_000_000 : 0
    }

    mutating func observeCallbacks(_ counts: [MeetingAudioSource: UInt64], at now: UInt64) -> Bool {
        let healthy = !counts.isEmpty && Set(counts.keys) == Set(priorCallbacks.keys) &&
            counts.allSatisfy { source, count in count > (priorCallbacks[source] ?? 0) }
        priorCallbacks = counts
        guard healthy else { healthySince = nil; return false }
        if let start = healthySince { return now >= start && now - start >= 2_000_000_000 }
        healthySince = now
        return false
    }
}

/// This is automatic same-source recovery, not a user source-change or Resume intent.
struct MeetingSourceRecoveryIntent {
    let body: MeetingCaptureControlBody
    let original: MeetingInventorySnapshot.Resolved
    var acknowledged = false
    var started = false
    var retryAtNanoseconds: UInt64 = 0

    func matches(_ capture: MeetingRemoteCapture) -> Bool {
        guard let epoch = body.expectedEpoch, epoch < UInt64.max else { return false }
        return capture.grantId == body.grantId && capture.generation == body.expectedGeneration + 1 &&
            capture.epoch == epoch + 1 && capture.selection == body.selection && capture.desired == "recording"
    }
}
