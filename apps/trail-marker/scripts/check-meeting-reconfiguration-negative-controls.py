#!/usr/bin/env python3
"""Hosted-Mac source-reconfiguration controls; --check is portable anchor validation only.

Reuse the existing runner's strict semantic XCTest recognition, source restoration,
and restored-positive rerun. No synthetic result is reported as native proof.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import signal
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("meeting_voice_negative", HERE / "check-meeting-voice-negative-controls.py")
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
RUNNER = SHARED.RUNNER
MEETINGS = RUNNER.APP / "TrailMarker/Meetings"
CONTROLS = [
    ("MeetingSourceRecoveryTests", {
        "name": "recovery-cooldown-requires-recording-acknowledgment",
        "source": MEETINGS / "MeetingSourceRecovery.swift",
        "test": "testCompletedRecoveryCooldownRequiresRecordingAcknowledgmentAndThirtySeconds",
        "before": "guard let completedAt = recordingAcknowledgedAt, now >= completedAt else { return false }",
        "after": "let completedAt = recordingAcknowledgedAt ?? 0; guard now >= completedAt else { return false }",
        "assertion": "Control, acquisition and unacknowledged recording cannot start the completed cooldown",
    }),
    ("MeetingSourceRecoveryTests", {
        "name": "recovery-cooldown-preserves-active-episode",
        "source": MEETINGS / "MeetingSourceRecovery.swift",
        "test": "testImmediateRecurringRecoveryRetainsDeadlineAndCancelsCompletedCooldown",
        "before": "        recordingAcknowledgedAt = nil",
        "after": "        // Mutation: retain a completed cooldown during a new active attempt.",
        "assertion": "A fresh in-progress attempt must never inherit an earlier completed cooldown",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "recovery-exhaustion-message-is-not-network",
        "source": MEETINGS / "MeetingCaptureContracts.swift",
        "test": "testRecoveryDeadlineCancelsBlockedAcquisitionWithoutWaitingForHardware",
        "before": 'case .recoveryExhausted: return "Audio recovery could not finish. Capture is paused. Press Resume in Moss to try again."',
        "after": 'case .recoveryExhausted: return "Moss is unreachable. Capture is paused. Reconnect and press Resume in Moss."',
        "assertion": "A slow native or permission answer must pause with a recovery-specific explanation",
    }),
    ("MeetingCaptureFailureDiagnosticTests", {
        "name": "scope-discard-does-not-duplicate-coverage",
        "source": MEETINGS / "MeetingCaptureRuntime.swift",
        "test": "testRuntimeReportsOnceBeforeDiscardingFailedOutputScopeAndKeepsWireGapReason",
        "before": "if let covered = alreadyReported, covered.source == gap.source, covered.epoch == gap.epoch,",
        "after": "if let covered = Optional<MeetingAudioGap>.none, covered.source == gap.source, covered.epoch == gap.epoch,",
        "assertion": "Scope failure must report each discarded track exactly once",
    }),
    ("MeetingCaptureFailureDiagnosticTests", {
        "name": "scope-discard-respects-cutoff",
        "source": MEETINGS / "MeetingCaptureRuntime.swift",
        "test": "testScopeDiscardClipsPartialCallbacksAtPauseWithoutDuplicateCoverage",
        "before": "let end = min(discarded.endNanoseconds, entry.cutoff ?? discarded.endNanoseconds)",
        "after": "let end = discarded.endNanoseconds",
        "assertion": "Discarded scope coverage must be clipped at the pause cutoff on both tracks",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "recovery-deadline-is-not-authorization-lease",
        "source": MEETINGS / "MeetingCaptureHost.swift",
        "test": "testLateAcquisitionDeadlinePausesWithoutExpiringRecordingAuthorization",
        "before": "                runtime.updateCaptureLease(until: leaseDeadlineNanoseconds)\n                connectivityMessage = nil",
        "after": "                runtime.updateCaptureLease(until: min(leaseDeadlineNanoseconds, recoveryIntent == nil ? UInt64.max : recoveryBudget?.deadline ?? 0))\n                connectivityMessage = nil",
        "assertion": "Recovery deadline must not become the recording authorization lease",
    }),
    ("MeetingCaptureFailureDiagnosticTests", {
        "name": "diagnostic-read-does-not-lock-audio-ring",
        "source": MEETINGS / "MeetingAudioBuffer.swift",
        "test": "testDiagnosticReadDoesNotWaitForAnInProgressSampleReader",
        "before": "    var failureDiagnostic: MeetingAudioFailureDiagnostic? {\n        if callbackFailures.value & 1 != 0 { return scopeDiagnostic.latest }",
        "after": "    var failureDiagnostic: MeetingAudioFailureDiagnostic? {\n        _ = failure // Mutation: reenter the audio ring lock while reading a diagnostic.\n        if callbackFailures.value & 1 != 0 { return scopeDiagnostic.latest }",
        "assertion": "Diagnostic reads must not wait for the held audio ring lock",
    }),
    ("MeetingSourceRecoveryTests", {
        "name": "recovery-health-does-not-require-quiet-peer",
        "source": MEETINGS / "MeetingSourceRecovery.swift",
        "test": "testHealthyRecoveredMicrophoneDoesNotWaitForCallbackFreeOutput",
        "before": "let requiredCounts = counts.filter { requiredHealth.contains($0.key) }",
        "after": "let requiredCounts = counts",
        "assertion": "An unchanged callback-free peer must not prevent sustained recovery health",
    }),
    ("MeetingSourceSelectionTests", {
        "name": "manual-source-edit-cancels-recovery",
        "source": MEETINGS / "MeetingCaptureHost.swift",
        "test": "testManualSourceEditSupersedesAdoptedRecoveryAwaitingRecordingAcknowledgment",
        "before": "        guard selection != currentSourceChoice else { return }\n        cancelSourceRecovery()",
        "after": "        guard selection != currentSourceChoice else { return }",
        "assertion": "An explicit source edit must supersede the pending automatic recovery",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "recovery-source-failure-interrupts-once",
        "source": MEETINGS / "MeetingCaptureHost.swift",
        "test": "testStagedPermissionLossKeepsGapEpochThroughExplicitResume",
        "before": "            discardUnavailableSources()\n            throw error",
        "after": "            sourceChanged()\n            throw error",
        "assertion": "A recovery source failure must publish one interruption",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "recovery-permission-read-race",
        "source": MEETINGS / "MeetingCaptureHost.swift",
        "test": "testRecoveryPermissionFlipBetweenConsecutiveReadsNeverRequestsPermission",
        "before": "        if selection.microphone != nil, ports.microphonePermission() != .granted {\n            guard recoveryIntent == nil else { throw MeetingHostError.permissionDenied }",
        "after": "        if recoveryIntent != nil, selection.microphone != nil, ports.microphonePermission() != .granted {\n            throw MeetingHostError.permissionDenied\n        }\n        if selection.microphone != nil, ports.microphonePermission() != .granted {",
        "assertion": "Automatic recovery must never request microphone permission after a permission-read race",
    }),
    ("MeetingSourceReconfigurationTests", {
        "name": "output-teardown-hard-fault-priority",
        "source": MEETINGS / "CoreAudioMeetingOutput.swift",
        "test": "testQueuedOutputHardEvidenceSurvivesClosedCaptureUntilDisposed",
        "before": "return state & 16 == 0 && (state & 4 == 0 || state & 8 != 0)",
        "after": "return state & 16 == 0 && state & 4 == 0",
        "assertion": "Output teardown must retain all hard failures",
    }),
    ("MeetingMicrophoneCaptureTests", {
        "name": "microphone-teardown-verification-drain",
        "source": MEETINGS / "MeetingMicrophoneCapture.swift",
        "test": "testPendingMicrophoneCapacityAndReadFaultsDrainBeforeDisposal",
        "before": "        context?.verifyFormatIfNeeded()",
        "after": "        // Mutation: lose the pending old-unit verification.",
        "assertion": "Pending hard verification must run before closing the peer unit",
    }),
    ("MeetingOutputCaptureTests", {
        "name": "output-post-acquisition-physical-routes",
        "source": MEETINGS / "CoreAudioMeetingOutput.swift",
        "test": "testPinnedOutputRoutesRejectChangesBeforeAndDuringAcquisition",
        "before": "            try installed.start()\n            try hardware.verifyOutputRoutes(defaultOutput: expectedDefaultOutputDeviceID, systemOutput: expectedSystemOutputDeviceID)",
        "after": "            try installed.start()",
        "assertion": "Both physical output routes must be verified after acquisition",
    }),
    ("MeetingSourceReconfigurationTests", {
        "name": "supported-new-rate-evidence",
        "source": MEETINGS / "MeetingAudioBuffer.swift",
        "test": "testRateChangeDoesNotRemapOldCounterOrInventLeaseExpiry",
        "before": "failLocked(.sourceReconfigured, diagnostic: .init(.bufferFormat)); return nil",
        "after": "failLocked(.invalidFormat, diagnostic: .init(.bufferFormat)); return nil",
        "assertion": "A slower rate must not map the previous counter to an artificial 180-second lease boundary",
    }),
    ("MeetingSourceRecoveryTests", {
        "name": "old-epoch-expiry-does-not-pause-replacement",
        "source": MEETINGS / "MeetingCaptureRuntime.swift",
        "test": "testResumeAfterUnknownReceiptExpiryKeepsFreshCaptureRecording",
        "before": "lostUnknownReceipt = lostUnknownReceipt || pending[index].buffer.epoch == machine.epoch",
        "after": "lostUnknownReceipt = true",
        "assertion": "Old expiry and late receipts cannot pause a new stream",
    }),
    ("MeetingSourceRecoveryTests", {
        "name": "recovery-hard-evidence-priority",
        "source": MEETINGS / "MeetingCaptureRuntime.swift",
        "test": "testHardFailureOnEitherClosedSourceWinsAfterSoftFault",
        "before": "recoveryEvidence.allSatisfy { $0.failure == nil || $0.failure == .sourceReconfigured }",
        "after": "true",
        "assertion": "A later hard fault must invalidate retained evidence",
    }),
    ("MeetingSourceRecoveryTests", {
        "name": "bounded-recovery-attempts",
        "source": MEETINGS / "MeetingSourceRecovery.swift",
        "test": "testEpisodeBudgetBoundsRetriesAndRequiresSustainedHealth",
        "before": "guard now < deadline, attempts < 3 else { return false }",
        "after": "guard now < deadline else { return false }",
        "assertion": "Recovery attempts must share a bounded episode",
    }),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    RUNNER.self_test()
    for test_class, control in CONTROLS:
        SHARED.select(test_class, control)
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} reconfiguration anchors. Native XCTest execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-reconfiguration-negative-", dir=os.environ.get("RUNNER_TEMP")))
    for test_class, control in CONTROLS:
        original = SHARED.select(test_class, control)
        RUNNER.run_control(control, original, folder)
    print("Reconfiguration mutations failed named assertions and passed after source restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
