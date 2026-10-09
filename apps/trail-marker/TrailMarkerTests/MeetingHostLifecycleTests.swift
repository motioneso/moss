import AppKit
import Foundation
import XCTest
@testable import TrailMarker

/// Runs the actual host task/control loop through a synthetic URLProtocol. No source reader,
/// microphone permission API, actual Keychain item, hardware or real network is used.
@MainActor
final class MeetingHostLifecycleTests: XCTestCase {
    func testFirstStartSurvivesMicStartupCounterResetWithoutResume() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { XCTFail("Granted permission must not be requested again"); return false }
        defer { host.shutdown(reason: "Synthetic startup-clock test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
            credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let receiver = try XCTUnwrap(fixture.device.receiver)
        receiver.receive(sampleTime: 0, hostTimeNanoseconds: fixture.monotonic,
            sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.25 })
        receiver.receive(sampleTime: 0, hostTimeNanoseconds: fixture.monotonic + 100_000_000,
            sampleRate: 8000, frameCount: 800,
            sampleAt: { _ in XCTFail("The uncertain startup callback must not be copied"); return 1 })
        receiver.receive(sampleTime: 800, hostTimeNanoseconds: fixture.monotonic + 200_000_000,
            sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        fixture.monotonic += 300_000_000
        host.service()
        XCTAssertEqual(host.phase, .recording, "One Start must survive a bounded microphone counter reset without Resume")
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertEqual(fixture.device.stops, 0)
        XCTAssertEqual(fixture.server.resumeKeys.count, 0)
        XCTAssertTrue(host.diagnostics.contains { $0.contains("cause=microphone-startup-timestamp") },
            "A tolerated startup timestamp must emit the interrupted gap diagnostic")
        XCTAssertTrue(host.pendingGaps.contains { $0.reason == "interrupted" })
    }

    func testFirstStartReconfirmsOneMissingMicrophoneWithoutResumeOrSendingUncertainPCM() async throws {
        for outcome in ["recovered", "still-missing", "late"] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            func snapshot(_ present: Bool) -> MeetingInventorySnapshot {
                let wire = MeetingCaptureInventory(microphones: present ? [
                    .init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")] : [],
                    applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
                    microphonePermission: .granted, systemAudioPermission: .unknown)
                return .init(wire: wire, microphones: present ? ["mic-uid": 42] : [:],
                    applications: [:], processes: [], audioObjects: [:], excluded: [])
            }
            var missingReads = 0
            var trigger = false
            let host = fixture.host(readInventory: {
                guard trigger else { return snapshot(true) }
                missingReads += 1
                if missingReads == 1 { return snapshot(false) }
                // The confirmation read runs with callback admission closed.
                fixture.device.receiver?.receive(sampleTime: 800, hostTimeNanoseconds: 10_100_000_000,
                    sampleRate: 8000, frameCount: 800,
                    sampleAt: { _ in XCTFail("No PCM may be copied while startup sources are uncertain"); return 1 })
                if outcome == "late" { fixture.monotonic += 600_000_000 }
                return snapshot(outcome != "still-missing")
            }) { false }
            defer { host.shutdown(reason: "Synthetic startup source confirmation") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
                credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            fixture.device.receiver?.receive(sampleTime: 0, hostTimeNanoseconds: fixture.monotonic,
                sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.25 })
            fixture.monotonic += 250_000_000
            trigger = true
            host.service()
            trigger = false
            XCTAssertEqual(missingReads, 2, "A startup omission gets exactly one immediate confirmation")
            XCTAssertEqual(fixture.server.audioCount, 0, "Uncertain startup PCM must never be uploaded")
            XCTAssertEqual(fixture.server.resumeKeys.count, 0)
            XCTAssertEqual(fixture.device.starts, 1)
            if outcome == "recovered" {
                XCTAssertEqual(host.phase, .recording, "One Start must survive a reconfirmed startup source omission without Resume")
                XCTAssertEqual(fixture.device.stops, 0)
                XCTAssertNil((fixture.device.receiver as? MeetingAudioBuffer)?.peek(),
                    "The first uncertain snapshot must erase all pre-notice PCM")
                XCTAssertTrue(host.pendingGaps.contains { $0.reason == "interrupted" })
            } else {
                XCTAssertEqual(host.phase, .paused, "Missing or late source confirmation must preserve the safety pause")
                XCTAssertEqual(fixture.device.stops, 1)
            }
        }
    }

    func testStopDuringPermissionWaitRejectsLateGrantAndAllowsNextStart() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "OS permission requested by explicit Start")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            let granted = await withCheckedContinuation { permission = $0 }
            fixture.permission = .granted
            return granted
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let authority = try await fixture.claimWithLostResponseRetry()
        try host.acceptStart(fixture.server.command, claim: authority, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertTrue(host.canStop)
        host.stopFromUserClick()
        try await waitUntil { fixture.server.stopCount == 1 }
        permission?.resume(returning: true)
        permission = nil
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.device.starts, 0, "Late permission must not open either source")
        XCTAssertEqual(fixture.server.claimHashes.count, 2)
        XCTAssertEqual(Set(fixture.server.claimHashes).count, 1, "Lost claim response retries exact local authority")

        // A second explicit Start can use the same host/connection after finalization.
        let next = FixtureServer()
        HostLifecycleProtocol.register(next)
        defer { HostLifecycleProtocol.remove(next.grantId) }
        let nextPending = MeetingPendingStart(command: next.command, connectionId: "connection", deviceId: next.deviceId, secret: String(repeating: "n", count: 43))
        let claim = try await fixture.client.claim(nextPending.body(verifier: String(repeating: "v", count: 43)),
            companionCredential: "tm1_synthetic", recordingProof: String(repeating: "p", count: 43))
        try host.acceptStart(next.command, claim: claim, credential: nextPending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 1)
        host.stopFromUserClick()
        try await waitUntil(timeout: 6) { next.finalized }
    }

    func testExpiredStartDuringPermissionWaitOnlyStopsAndFinalizes() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        fixture.wall = fixture.wall.addingTimeInterval(61)
        // Isolate the Start's wall-clock deadline from the independent monotonic lease.
        // A separate test below expires that lease while the same permission is pending.
        fixture.monotonic += 1_000_000_000
        permission?.resume(returning: true)
        permission = nil
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.server.stopCount, 1)
        XCTAssertEqual(fixture.device.starts, 0)
    }

    func testConnectionTeardownDuringPermissionWaitCannotRestartOldSession() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertTrue(host.shutdown(reason: "Connection ended"))
        permission?.resume(returning: true)
        permission = nil
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertFalse(host.canStop)
    }

    func testPausedClaimWaitsForExplicitResumeWithoutUsingExpiredInitialStart() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.server.browserState("paused", generation: 2)
        var permissionRequests = 0
        let host = fixture.host {
            permissionRequests += 1
            fixture.permission = .granted
            return true
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .paused }
        XCTAssertEqual(permissionRequests, 0)
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertFalse(host.canResumeFromUserClick, "An unstarted claim is not native Resume authority")
        host.resumeFromUserClick()
        XCTAssertEqual(fixture.server.controlCount, 0, "Initial Start remains browser-only")
        fixture.wall = fixture.wall.addingTimeInterval(61)
        fixture.server.browserState("recording", generation: 3)
        try await waitUntil(timeout: 4) { host.phase == .recording }
        XCTAssertEqual(permissionRequests, 1)
        XCTAssertEqual(fixture.device.starts, 1)
        let resumedPoll = try XCTUnwrap(host.pollCompletion)
        XCTAssertTrue(host.shutdown(reason: "Explicit Resume regression finished"))
        await resumedPoll()
        XCTAssertNil(host.pollCompletion)
        XCTAssertEqual(fixture.device.starts, 1, "Closing the resumed session must not acquire the source again")
    }

    func testPauseDiagnosticsExposeNativeFailureButNotArbitraryErrorContent() {
        XCTAssertEqual(MeetingCaptureDiagnostics.interruptionReason(MeetingAudioFailure.invalidSelection), "invalidSelection")
        XCTAssertEqual(MeetingCaptureDiagnostics.interruptionReason(
            MeetingAudioFailure.deviceFailure(operation: "start-output-io", status: -77)),
            "deviceFailure(operation: \"start-output-io\", status: -77)")
        let error = NSError(domain: "private-instance", code: 42,
            userInfo: [NSLocalizedDescriptionKey: "private URL, credential or transcript"])
        XCTAssertEqual(MeetingCaptureDiagnostics.interruptionReason(error), "unexpectedError(code: 42)")
    }

    func testSourceValidationDiagnosticsDistinguishPermissionResolveAndMismatch() async throws {
        let reasons = ["microphone-permission-not-granted", "resolve-threw", "resolved-not-equal"]
        for reason in reasons {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            fixture.inventoryOverride = sourceDiagnosticSnapshot()
            let host = fixture.host { XCTFail("Granted permission must not be requested again"); return false }
            defer { host.shutdown(reason: "Synthetic source diagnostic test") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
                credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            switch reason {
            case "microphone-permission-not-granted":
                fixture.permission = .denied
                // Permission must remain the first failure even when resolution would fail too.
                fixture.inventoryOverride = sourceDiagnosticSnapshot(microphone: nil)
            case "resolve-threw": fixture.inventoryOverride = sourceDiagnosticSnapshot(microphone: nil)
            default: fixture.inventoryOverride = sourceDiagnosticSnapshot(microphone: 43)
            }
            fixture.monotonic += 250_000_000
            host.service()
            XCTAssertEqual(host.phase, .paused, "Source diagnostic branches must retain the existing pause")
            XCTAssertEqual(fixture.device.stops, 1, "Source diagnostic branches must close capture")
            XCTAssertTrue(host.diagnostics.contains { $0.contains(reason) }, "Source validation must name the failed branch")
            for other in reasons where other != reason {
                XCTAssertFalse(host.diagnostics.contains { $0.contains(other) }, "Only the failing source-validation branch is logged")
            }
        }
    }

    func testComputerSourceDiagnosticsKeepStableObjectsAndPauseChangedExclusions() async throws {
        for addOtherMoss in [false, true] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let baseline = sourceDiagnosticSnapshot()
            fixture.inventoryOverride = baseline
            fixture.server.setSelection(.init(mode: "computer-audio",
                microphone: .init(deviceId: "mic-uid", sourceId: "mic"), outputSourceId: "output",
                appProcessTreeId: nil, scope: .init(kind: "process-exclusion", endpointId: nil,
                    excludedProcessTreeIds: baseline.wire.computerAudio.excludedProcessTreeIds)))
            let output = Device()
            let host = fixture.host(factory: { _ in [.microphone: fixture.device, .output: output] }) { false }
            defer { host.shutdown(reason: "Synthetic computer source diagnostic test") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
                credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            // A translated object gaining a listed route retains exactly the same exclusion.
            var listed = baseline
            listed.audioRoutes = [17: [70]]
            fixture.inventoryOverride = listed
            fixture.monotonic += 250_000_000
            host.service()
            XCTAssertEqual(host.phase, .recording, "A stable excluded object becoming listed must not pause capture")
            XCTAssertEqual(output.stops, 0)
            XCTAssertFalse(host.diagnostics.contains { $0.contains("source-validation") })

            fixture.inventoryOverride = sourceDiagnosticSnapshot(audioObject: addOtherMoss ? 101 : 202,
                addOtherMoss: addOtherMoss)
            fixture.monotonic += 250_000_000
            host.service()
            XCTAssertEqual(host.phase, .paused, "Changed exclusion objects and new Moss processes must still pause")
            XCTAssertEqual(output.stops, 1, "Unsafe exclusion changes must still close the output tap")
            let expected = addOtherMoss ? "resolve-threw" : "resolved-not-equal"
            XCTAssertTrue(host.diagnostics.contains { $0.contains(expected) }, "Computer source changes must log their actual branch")
            if !addOtherMoss {
                let line = try XCTUnwrap(host.diagnostics.first { $0.contains("resolved-not-equal") })
                XCTAssertTrue(line.contains("101"), "Mismatch diagnostics must retain the original excluded audio object")
                XCTAssertTrue(line.contains("202"), "Mismatch diagnostics must show the current excluded audio object")
                XCTAssertTrue(line.contains("17"), "Mismatch diagnostics must identify the excluded PID")
                XCTAssertFalse(line.contains("PRIVATE_SENTINEL"))
            }
        }
    }

    func testSourceMismatchDiagnosticsAreNumericBoundedAndDoNotLeakInventoryText() {
        let before = MeetingCaptureSourceDiagnostics(snapshot: sourceDiagnosticSnapshot())
        let after = MeetingCaptureSourceDiagnostics(snapshot: sourceDiagnosticSnapshot(audioObject: nil))
        let mismatch = MeetingCaptureSourceDiagnostics.failure(.resolvedNotEqual, before: before, after: after)
        XCTAssertEqual(mismatch,
            "resolved-not-equal before(count=1,excluded=[pid=17/audio-object=101]) after(count=1,excluded=[pid=17/audio-object=0])",
            "Source mismatch diagnostics must report sorted numeric identities and zero for unavailable objects")
        XCTAssertFalse(mismatch.contains("PRIVATE_SENTINEL"), "Source diagnostics must never render inventory paths or labels")
        XCTAssertEqual(MeetingCaptureSourceDiagnostics.failure(.microphonePermissionNotGranted, before: before, after: after),
            "microphone-permission-not-granted", "Permission failures must contain only the fixed branch label")
        XCTAssertEqual(MeetingCaptureSourceDiagnostics.failure(.resolveThrew, before: before, after: after),
            "resolve-threw", "Resolution failures must contain only the fixed branch label")
        let baseline = sourceDiagnosticSnapshot()
        let processes = (1...129).reversed().map { pid in
            MeetingProcessIdentity(pid: Int32(pid), parentPID: 0, startedSeconds: 1, startedMicroseconds: 0,
                executable: "/PRIVATE_SENTINEL/Moss.app/PRIVATE_SENTINEL")
        }
        let oversized = MeetingInventorySnapshot(wire: baseline.wire, microphones: baseline.microphones,
            applications: [:], processes: processes, audioObjects: [:], excluded: processes)
        let bounded = MeetingCaptureSourceDiagnostics.failure(.resolvedNotEqual, before: nil,
            after: .init(snapshot: oversized))
        XCTAssertTrue(bounded.contains("before(unavailable)"))
        XCTAssertTrue(bounded.contains("after(count=129,excluded=[pid=1/audio-object=0"),
            "Diagnostics must sort identities and retain the full exclusion count")
        XCTAssertEqual(bounded.components(separatedBy: "pid=").count - 1, 128,
            "Public source diagnostics must cap numeric process pairs")
        XCTAssertFalse(bounded.contains("pid=129/"))
        XCTAssertFalse(bounded.contains("PRIVATE_SENTINEL"))
    }

    private func sourceDiagnosticSnapshot(microphone: UInt32? = 42, audioObject: UInt32? = 101,
                                          addOtherMoss: Bool = false) -> MeetingInventorySnapshot {
        let moss = MeetingProcessIdentity(pid: 17, parentPID: 1, startedSeconds: 2, startedMicroseconds: 3,
            executable: "/PRIVATE_SENTINEL/Moss.app/Contents/MacOS/PRIVATE_SENTINEL")
        let other = MeetingProcessIdentity(pid: 18, parentPID: 1, startedSeconds: 4, startedMicroseconds: 5,
            executable: "/PRIVATE_SENTINEL/Moss.app/Contents/MacOS/Other")
        let excluded = addOtherMoss ? [moss, other] : [moss]
        let wire = MeetingCaptureInventory(microphones: microphone == nil ? [] : [
            .init(deviceId: "mic-uid", sourceId: "mic", label: "PRIVATE_SENTINEL")],
            applications: [], computerAudio: .init(available: true, excludedProcessTreeIds: excluded.map(\.key)),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        var objects: [Int32: UInt32] = [:]
        if let audioObject { objects[17] = audioObject }
        if addOtherMoss { objects[18] = 303 }
        return .init(wire: wire, microphones: microphone.map { ["mic-uid": $0] } ?? [:],
            applications: [:], processes: excluded, audioObjects: objects, excluded: excluded)
    }

    func testAlreadyPausedCaptureAcknowledgesNewPauseGenerationWithoutTouchingDevices() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { XCTFail("Paused capture must not request permission again"); return false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.sourceChanged()
        XCTAssertTrue(host.diagnostics.contains("capture-paused: sourceChanged"))
        XCTAssertEqual(host.phase, .paused)
        let stops = fixture.device.stops
        try await waitUntil(timeout: 4) { fixture.server.lastObservation?.phase == "paused" }
        XCTAssertEqual(fixture.server.lastObservation?.generation, 1)
        XCTAssertEqual(fixture.server.lastObservation?.errorCode, "native_capture_interrupted")

        fixture.server.browserState("paused", generation: 2)
        try await waitUntil(timeout: 6) { fixture.server.lastObservation?.generation == 2 }
        XCTAssertEqual(fixture.server.lastObservation?.phase, "paused")
        XCTAssertEqual(fixture.server.lastObservation?.errorCode, "native_capture_interrupted")
        XCTAssertEqual(host.phase, .paused)
        XCTAssertFalse(host.cleanupBlocked)
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertEqual(fixture.device.stops, stops, "Acknowledging Pause must not close devices a second time")
        XCTAssertEqual(fixture.server.controlCount, 0, "No duplicate Pause command is needed to acknowledge the version")
    }

    func testRecoveredStoppedClaimNeverRequestsPermissionOrOpensHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.server.browserState("stopped", generation: 2)
        let host = fixture.host { XCTFail("Stopped authority cannot request microphone permission"); return true }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.device.starts, 0)
    }

    func testAcceptedStartShowsPillAndDotThroughPauseThenStopClearsBoth() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { XCTFail("No new Mac confirmation"); return false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let pill = MeetingRecordingPillController(host: host)
        let status = MeetingCaptureStatusItem(host: host, showControls: {})
        XCTAssertFalse(pill.panel.isVisible)
        XCTAssertFalse(host.recordingPresentation.showsPill, "Linking alone never presents recording")
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        XCTAssertTrue(host.recordingPresentation.showsPill)
        XCTAssertTrue(pill.panel.isVisible, "The actual panel follows accepted Start")
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        host.hideRecordingPill()
        XCTAssertFalse(pill.panel.isVisible, "Hide orders out only the panel")
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        XCTAssertEqual(host.phase, .paused)
        host.open(URL(string: "moss-meeting://invalid")!)
        XCTAssertEqual(host.phase, .paused, "An invalid activation must not hide the current session's Stop control")
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        try await waitUntil { status.item.button?.attributedTitle.string == "● Meeting" }
        XCTAssertEqual(status.item.button?.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, .systemRed)
        XCTAssertTrue(status.item.menu?.items.first(where: { $0.title == "Stop recording" })?.isEnabled == true)
        XCTAssertTrue(host.canStop)
        host.stopFromUserClick()
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        try await waitUntil { status.item.button?.attributedTitle.string == "Meeting" }
    }

    func testHideAndNativeCloseKeepCaptureRunningAndMenuRestoresPill() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { XCTFail("Visibility must not request permission"); return false }
        defer { host.shutdown(reason: "Synthetic visibility test finished") }
        let pill = MeetingRecordingPillController(host: host)
        let status = MeetingCaptureStatusItem(host: host, showControls: {})
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let poll = try XCTUnwrap(host.pollCompletion)
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        let closeActions: [() -> Void] = [host.hideRecordingPill, { pill.panel.performClose(nil) }, { pill.panel.close() }]
        for close in closeActions {
            let deviceStops = fixture.device.stops
            close()
            XCTAssertEqual(host.phase, .recording, "Close must not Pause or Stop")
            // A broken visibility action already failed above. Do not turn that semantic
            // failure into a throwing menu lookup for a state the mutation destroyed.
            guard host.phase == .recording else { return }
            XCTAssertFalse(pill.panel.isVisible)
            XCTAssertTrue(host.recordingPresentation.showsRedDot)
            XCTAssertFalse(poll.isCancelled, "Hiding must not cancel the host loop")
            fixture.monotonic += 100_000_000
            buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            XCTAssertEqual(buffer.capturedLevel(at: fixture.monotonic), 0.5, accuracy: 0.0001,
                "The same source must still accept new audio while hidden")
            try await waitUntil { status.item.menu?.item(withTitle: "Show recording pill") != nil }
            XCTAssertTrue(status.item.isVisible)
            XCTAssertEqual(status.item.button?.attributedTitle.string, "● Meeting")
            XCTAssertTrue(status.item.menu?.item(withTitle: "Pause recording")?.isEnabled == true)
            XCTAssertTrue(status.item.menu?.item(withTitle: "Stop recording")?.isEnabled == true)
            try invokeMenuItem("Show recording pill", in: status)
            XCTAssertTrue(pill.panel.isVisible)
            XCTAssertEqual(host.phase, .recording)
            try await waitUntil { status.item.menu?.item(withTitle: "Show recording pill") == nil }
            XCTAssertEqual(fixture.device.starts, 1, "Show cannot reopen hardware")
            XCTAssertEqual(fixture.device.stops, deviceStops, "Visibility cannot close hardware")
            XCTAssertEqual(fixture.server.controlCount, 0, "Hide and Show cannot send Pause, Stop or Resume")
            XCTAssertEqual(fixture.server.stopCount, 0)
        }

        host.hideRecordingPill()
        try await waitUntil { status.item.menu?.item(withTitle: "Show recording pill") != nil }
        try invokeMenuItem("Pause recording", in: status)
        XCTAssertEqual(host.phase, .paused, "The menu can Pause while the pill is hidden")
        XCTAssertFalse(pill.panel.isVisible)
        try await waitUntil { host.canResumeFromUserClick }
        XCTAssertEqual(fixture.server.controlCount, 1)
        let pausedDeviceStops = fixture.device.stops
        try invokeMenuItem("Show recording pill", in: status)
        XCTAssertTrue(pill.panel.isVisible)
        XCTAssertEqual(host.phase, .paused, "Show must not resume a paused recording")
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertEqual(fixture.device.stops, pausedDeviceStops)
        XCTAssertEqual(fixture.server.controlCount, 1)
        host.hideRecordingPill()
        try await waitUntil { status.item.menu?.item(withTitle: "Show recording pill") != nil }
        try invokeMenuItem("Stop recording", in: status)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        try await waitUntil(timeout: 6) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.server.stopCount, 1, "The hidden session still follows normal Stop finalization")
        host.showRecordingPill()
        XCTAssertFalse(pill.panel.isVisible, "Show cannot resurrect a stopped recording")
        try await waitUntil { status.item.menu?.item(withTitle: "Show recording pill") == nil }

        let next = FixtureServer()
        HostLifecycleProtocol.register(next)
        defer { HostLifecycleProtocol.remove(next.grantId) }
        let pending = MeetingPendingStart(command: next.command, connectionId: "connection", deviceId: next.deviceId, secret: String(repeating: "n", count: 43))
        let claim = try await fixture.client.claim(pending.body(verifier: String(repeating: "v", count: 43)),
            companionCredential: "tm1_synthetic", recordingProof: String(repeating: "p", count: 43))
        try host.acceptStart(next.command, claim: claim, credential: pending.credential, origin: fixture.monotonic)
        XCTAssertTrue(pill.panel.isVisible, "The next accepted recording automatically shows its pill")
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
    }

    func testNativeCloseDuringPermissionWaitOnlyHidesPill() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            let granted = await withCheckedContinuation { permission = $0 }
            fixture.permission = .granted
            return granted
        }
        defer { host.shutdown(reason: "Synthetic visibility test finished") }
        let pill = MeetingRecordingPillController(host: host)
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        pill.panel.performClose(nil)
        XCTAssertFalse(pill.panel.isVisible)
        XCTAssertTrue(host.canStop)
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertEqual(fixture.device.stops, 0)
        permission?.resume(returning: true)
        permission = nil
        try await waitUntil { host.phase == .recording }
        XCTAssertFalse(pill.panel.isVisible, "Completing the existing Start does not undo Hide")
        XCTAssertEqual(fixture.device.starts, 1, "Hide does not cancel the user's authorized Start")
        XCTAssertEqual(fixture.server.controlCount, 0)
    }

    private func invokeMenuItem(_ title: String, in status: MeetingCaptureStatusItem) throws {
        let menu = try XCTUnwrap(status.item.menu)
        let index = try XCTUnwrap(menu.items.firstIndex(where: { $0.title == title }))
        XCTAssertTrue(menu.items[index].isEnabled)
        menu.performActionForItem(at: index)
    }

    func testEveryIdentityStopPathClearsSurfacesAndDiscardsUnsentAudio() async throws {
        let another = LinkedIdentity(instance: try InstanceURL.parse("https://moss.example").get(),
            deviceId: "another-device", accountName: "Fixture", accountEmail: "another@example.invalid")
        let events: [ConnectionEvent] = [.userLogout, .userDisconnect, .userQuit,
            .heartbeatFailed(.credentialInvalid, generation: 0),
            .heartbeatFailed(.accountBlocked(code: "account_deactivated"), generation: 0),
            .linkCompleted(another, credential: "tm1_synthetic", generation: 0)]
        for event in events {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Synthetic test finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
            buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            XCTAssertNotNil(buffer.peek())
            XCTAssertTrue(host.beforeConnectionEvent(event))
            XCTAssertFalse(host.recordingPresentation.showsPill)
            XCTAssertFalse(host.recordingPresentation.showsRedDot)
            XCTAssertNil(buffer.peek(), "Terminal identity path must discard unsent audio")
        }
    }

    func testLeaseExpiryClearsPausedSessionAndDropsItsRetainedAudio() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        host.pauseFromUserClick()
        let queuedControl = try XCTUnwrap(host.controlCompletion)
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        fixture.monotonic += 30_000_000_000
        host.service()
        // Pause queued its Task on this actor, but expiry closed the client before that
        // Task could start. Await it here so no failed request can leak into another test.
        await queuedControl()
        XCTAssertEqual(fixture.server.controlCount, 0, "Expired queued controls must not reach transport")
        XCTAssertNil(host.controlCompletion)
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertNil(buffer.peek())
        XCTAssertEqual(host.phase, .stopped)
    }

    func testBrowserRevocationStopsPillDotAndActualCapture() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        fixture.server.browserState("revoked", generation: 2)
        try await waitUntil(timeout: 4) { host.phase == .stopped }
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertNil(buffer.peek())
    }

    func testLeaseExpiryDuringPermissionWaitCannotStartAfterLateGrant() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        let suspendedPoll = try XCTUnwrap(host.pollCompletion)
        let requestsBeforeExpiry = fixture.server.requestCount
        fixture.monotonic += 30_000_000_000
        host.service()
        permission?.resume(returning: true)
        permission = nil
        // Wait for the actual permission continuation and poll to exit, not one
        // scheduler yield that can leave old work running in the next XCTest.
        await suspendedPoll()
        XCTAssertEqual(fixture.server.requestCount, requestsBeforeExpiry, "Late permission must not revalidate or restart expired authority")
        XCTAssertNil(host.pollCompletion)
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertEqual(fixture.device.starts, 0, "A late OS permission cannot renew an expired lease")
    }

    func testHardExpiryAndCleanupFailureClearBothSurfacesAndDiscardAudio() async throws {
        for cleanupFailure in [false, true] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { fixture.device.failStop = false; host.shutdown(reason: "Synthetic test finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
            buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            if cleanupFailure {
                fixture.device.failStop = true
                XCTAssertTrue(host.beforeConnectionEvent(.userLogout), "A retained driver handle cannot prevent server Unlink")
                XCTAssertTrue(host.cleanupBlocked)
            } else {
                fixture.wall = fixture.wall.addingTimeInterval(7201)
                host.service()
                XCTAssertEqual(host.phase, .stopped)
            }
            XCTAssertEqual(host.recordingPresentation.showsPill, cleanupFailure,
                "A retained driver handle must surface a cleanup warning even after recording stops")
            XCTAssertEqual(host.recordingPresentation.interruptionWarning,
                cleanupFailure ? MeetingHostError.cleanupFailed.message : nil)
            XCTAssertFalse(host.recordingPresentation.showsRedDot)
            XCTAssertNil(buffer.peek())
            buffer.receive(hostTimeNanoseconds: fixture.monotonic + 100_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            XCTAssertNil(buffer.peek(), "Closed callbacks cannot refill after a terminal path")
        }
    }

    func testTerminalUploadFailureReportsOneGapWithExactWireIdentityAndBounds() async throws {
        let failures = [
            (code: "meeting_capture_processing_failed", reason: "invalid-response", gapReason: "processing-failed"),
            (code: "meeting_capture_interrupted", reason: "capture-interrupted", gapReason: "processing-failed"),
            (code: "meeting_capture_interrupted", reason: "audio-expired", gapReason: "interrupted")
        ]
        for failure in failures {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Synthetic gap regression finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
            // Fractional endpoints expose a second conversion that disagrees with the upload.
            for index in 0..<5 {
                buffer.receive(hostTimeNanoseconds: fixture.monotonic + 400_000 + UInt64(index) * 1_000_000_000,
                    sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.25 })
            }
            fixture.monotonic += 6_000_000_000
            fixture.server.failAudio(code: failure.code, reason: failure.reason, gapReason: failure.gapReason, elapsedMs: 8000)
            try await waitUntil(timeout: 6) { !fixture.server.reportedGaps.isEmpty }
            let reports = fixture.server.reportedGaps
            let retained = fixture.server.retainedGaps
            XCTAssertEqual(fixture.server.audioCount, 1, "A terminal receipt must release the clip")
            XCTAssertEqual(retained.count, 1, "Server and native reports must identify the same gap")
            XCTAssertEqual(reports.count, 1)
            XCTAssertEqual(reports.first, retained.first, "Keep the exact source, epoch, wire bounds and reason")
            XCTAssertEqual(retained.first?.reason, failure.gapReason)
            XCTAssertEqual(host.gapCount, 1, "The local failure diagnostic remains visible")
        }
    }

    func testNativeResumeWaitsForAuthoritativeStatusAndPreservesPausedObservation() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        XCTAssertFalse(host.canResumeFromUserClick, "Resume is disabled until server Pause acknowledgment")
        host.resumeFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        XCTAssertEqual(fixture.server.resumeKeys.count, 0, "An unconfirmed Pause cannot be overridden")
        fixture.server.configureResume(holdStatus: true)
        host.resumeFromUserClick()
        host.resumeFromUserClick()
        try await waitUntil { host.controlCompletion == nil }
        XCTAssertEqual(fixture.server.resumeKeys.count, 1, "Repeated click must stage only one Resume")
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(fixture.device.starts, 1, "Resume receipt alone must never open hardware")
        XCTAssertEqual(fixture.server.audioCount, 0)
        XCTAssertFalse(host.canResumeFromUserClick)
        fixture.server.configureResume(holdStatus: false)
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 2, "Authoritative status must open exactly one resumed epoch")
        XCTAssertEqual(fixture.server.lastObservation?.generation, 2, "Resume must preserve the previous-generation paused observation")
        XCTAssertEqual(fixture.server.lastObservation?.phase, "paused")
        XCTAssertEqual(fixture.server.captureGeneration, 3, "Old paused observation must not re-pause the accepted Resume")
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        for index in 0..<5 {
            buffer.receive(hostTimeNanoseconds: fixture.monotonic + UInt64(index) * 1_000_000_000,
                sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.25 })
        }
        fixture.server.advanceElapsed(to: 8000)
        host.service()
        XCTAssertEqual(fixture.server.audioCount, 0, "No resumed audio before recording observation is acknowledged")
        try await waitUntil(timeout: 5) { fixture.server.lastObservation?.generation == 3 && fixture.server.lastObservation?.phase == "recording" }
        fixture.monotonic += 6_000_000_000
        host.service()
        try await waitUntil { fixture.server.audioCount == 1 }
        XCTAssertEqual(fixture.server.resumeKeys.count, 1)
    }

    func testLostResumeReplyRecoversFromStatusWithoutExtraEpoch() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        fixture.server.configureResume(holdStatus: true, loseReply: true)
        host.resumeFromUserClick()
        try await waitUntil { host.controlCompletion == nil }
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(fixture.device.starts, 1, "Uncertain Resume cannot open hardware")
        fixture.server.configureResume(holdStatus: false)
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 2)
        XCTAssertEqual(fixture.server.captureGeneration, 3)
        XCTAssertEqual(fixture.server.resumeKeys.count, 1, "Authoritative status recovers the lost reply without another epoch")
    }

    func testNewerPauseCancelsFailedResumeUntilAnotherClick() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        fixture.server.configureResume(holdStatus: true, rejectRequest: true)
        host.resumeFromUserClick()
        try await waitUntil { host.controlCompletion == nil }
        fixture.server.browserState("paused", generation: 4)
        fixture.monotonic += 2_000_000_000
        fixture.server.configureResume(holdStatus: false)
        try await waitUntil(timeout: 5) { host.canResumeFromUserClick }
        XCTAssertEqual(fixture.server.resumeKeys.count, 1, "Newer Pause must cancel the failed Resume instead of rebasing")
        XCTAssertEqual(fixture.device.starts, 1)
        host.resumeFromUserClick()
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.server.resumeKeys.count, 2, "A new explicit click can resume the newer Pause")
        XCTAssertEqual(fixture.server.captureGeneration, 5)
    }

    func testStopCancelsQueuedResumeBeforeTransportAndKeepsHardwareClosed() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        host.resumeFromUserClick()
        host.stopFromUserClick()
        let queued = try XCTUnwrap(host.controlCompletion)
        await queued()
        XCTAssertEqual(fixture.server.resumeKeys.count, 0, "Stop must cancel queued Resume before transport")
        try await waitUntil(timeout: 5) { fixture.server.stopCount == 1 }
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertFalse(host.canResumeFromUserClick)
    }

    func testRejectedResumeRequiresAnotherExplicitClickInsteadOfRetryingLater() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        fixture.server.configureResume(holdStatus: false, denyRequest: true)
        host.resumeFromUserClick()
        try await waitUntil { host.controlCompletion == nil }
        XCTAssertTrue(host.canResumeFromUserClick, "Definitive rejection must clear Resume intent")
        XCTAssertTrue(host.message.contains("press Resume again"), "Definitive rejection needs actionable source guidance")
        fixture.server.configureResume(holdStatus: false)
        fixture.monotonic += 4_000_000_000
        try await Task.sleep(nanoseconds: 2_500_000_000)
        XCTAssertEqual(fixture.server.resumeKeys.count, 1, "A rejected Resume must never retry after the source recovers")
        XCTAssertEqual(fixture.device.starts, 1)
        host.resumeFromUserClick()
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.server.resumeKeys.count, 2)
        XCTAssertEqual(Set(fixture.server.resumeKeys).count, 2)
    }

    func testSourceChangeCancelsQueuedResumeAndRequiresNewClick() async throws {
        for stopFirst in [false, true] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Synthetic Resume finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            host.pauseFromUserClick()
            try await waitUntil { host.canResumeFromUserClick }
            host.resumeFromUserClick()
            if stopFirst { host.stopFromUserClick() }
            host.sourceChanged()
            let queued = try XCTUnwrap(host.controlCompletion)
            await queued()
            XCTAssertEqual(fixture.server.resumeKeys.count, 0, "Source change must cancel queued Resume before transport")
            if stopFirst {
                try await waitUntil(timeout: 5) { fixture.server.stopCount == 1 }
                XCTAssertFalse(host.canResumeFromUserClick, "Source change must preserve pending Stop")
            } else {
                try await waitUntil(timeout: 5) { host.canResumeFromUserClick }
            }
            XCTAssertEqual(fixture.device.starts, 1, "Source recovery requires another Resume click")
        }
    }

    func testSourceChangePausesAnAlreadyAcceptedResumeWithLostReply() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic Resume finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        fixture.server.configureResume(holdStatus: true, loseReply: true)
        host.resumeFromUserClick()
        try await waitUntil { host.controlCompletion == nil }
        XCTAssertEqual(fixture.server.captureGeneration, 3)
        host.sourceChanged()
        fixture.server.configureResume(holdStatus: false)
        try await waitUntil(timeout: 5) { host.canResumeFromUserClick }
        XCTAssertEqual(fixture.device.starts, 1, "Source change must keep hardware closed after an accepted Resume")
        XCTAssertEqual(fixture.server.captureGeneration, 4, "An accepted Resume must be followed by Pause after source change")
        XCTAssertEqual(fixture.server.resumeKeys.count, 1)
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition(), "Synthetic host did not reach the expected lifecycle state")
    }

    typealias Device = MeetingHostFixtureDevice

    @MainActor
    final class Fixture {
        let server = FixtureServer()
        let device = Device()
        private(set) var runtime: MeetingCaptureRuntime!
        let client: MeetingCaptureClient
        let pending: MeetingPendingStart
        let instance: InstanceURL
        let defaultsName = "com.moss.meeting-host-tests." + UUID().uuidString
        var wall = FixtureServer.baseTime
        let clock = MeetingHostFixtureClock()
        var monotonic: UInt64 {
            get { clock.now }
            set { clock.now = newValue }
        }
        var permission: MeetingCapturePermission = .unknown
        var permissionReads = 0
        var inventoryOverride: MeetingInventorySnapshot?

        init() throws {
            instance = try InstanceURL.parse("https://moss.example").get()
            client = Self.client(instance)
            pending = MeetingPendingStart(command: server.command, connectionId: "connection", deviceId: server.deviceId, secret: String(repeating: "s", count: 43))
            HostLifecycleProtocol.register(server)
        }
        nonisolated static func client(_ instance: InstanceURL) -> MeetingCaptureClient {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [HostLifecycleProtocol.self]
            return MeetingCaptureClient(instance: instance, configuration: configuration)
        }
        func claim() async throws -> MeetingRecordingClaimReply {
            try await client.claim(pending.body(verifier: String(repeating: "v", count: 43)),
                companionCredential: "tm1_synthetic", recordingProof: String(repeating: "p", count: 43))
        }
        func claimWithLostResponseRetry() async throws -> MeetingRecordingClaimReply {
            server.loseFirstClaim = true
            do { _ = try await claim(); XCTFail("Synthetic first reply must be lost") }
            catch { XCTAssertEqual(error as? MeetingHostError, .network) }
            return try await claim()
        }
        func host(snapshot customSnapshot: MeetingInventorySnapshot? = nil,
                  factory customFactory: MeetingCaptureRuntime.DeviceFactory? = nil,
                  readInventory customReadInventory: (() throws -> MeetingInventorySnapshot)? = nil,
                  microphonePermission customMicrophonePermission: (() -> MeetingCapturePermission)? = nil,
                  permissionRequest: @escaping () async -> Bool) -> MeetingCaptureHost {
            let identity = LinkedIdentity(instance: instance, deviceId: server.deviceId, accountName: "Fixture", accountEmail: "fixture@example.invalid")
            let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
                applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
                microphonePermission: .unknown, systemAudioPermission: .unknown)
            let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["mic-uid": 42], applications: [:],
                processes: [], audioObjects: [:], excluded: [])
            let ports = MeetingCaptureHostPorts(identity: { identity }, connectionAvailable: { true }, readInventory: { try customReadInventory?() ?? self.inventoryOverride ?? customSnapshot ?? snapshot },
                microphonePermission: { self.permissionReads += 1; return customMicrophonePermission?() ?? self.permission }, requestMicrophone: permissionRequest,
                makeClient: Self.client, now: { self.monotonic }, wallNow: { self.wall })
            let defaults = UserDefaults(suiteName: defaultsName)!
            let connection = ConnectionRuntime(keychain: KeychainStore(service: defaultsName), preferences: PreferencesStore(defaults: defaults))
            let clock = self.clock
            let device = self.device
            runtime = MeetingCaptureRuntime(factory: customFactory ?? { _ in [.microphone: device] }, monotonicNow: { clock.now })
            return MeetingCaptureHost(connection: connection, runtime: runtime, ports: ports)
        }
        func close() {
            client.close()
            HostLifecycleProtocol.remove(server.grantId)
            UserDefaults.standard.removePersistentDomain(forName: defaultsName)
        }
    }
}


/// Recovery acquisition and native callbacks run outside the test's MainActor. Keep their
/// injected clock and device observations independently synchronized, like the real ports.
final class MeetingHostFixtureClock {
    private let lock = NSLock()
    private var value: UInt64 = 10_000_000_000
    var now: UInt64 {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

final class MeetingHostFixtureDevice: MeetingAudioCapturing {
    private let lock = NSLock()
    private var startCount = 0
    private var stopCount = 0
    private var refusesStop = false
    private var target: MeetingAudioReceiving?
    var starts: Int { lock.lock(); defer { lock.unlock() }; return startCount }
    var stops: Int { lock.lock(); defer { lock.unlock() }; return stopCount }
    var receiver: MeetingAudioReceiving? { lock.lock(); defer { lock.unlock() }; return target }
    var failStop: Bool {
        get { lock.lock(); defer { lock.unlock() }; return refusesStop }
        set { lock.lock(); refusesStop = newValue; lock.unlock() }
    }
    func start(into receiver: MeetingAudioReceiving) throws {
        lock.lock(); startCount += 1; target = receiver; lock.unlock()
    }
    func stop() throws {
        lock.lock(); stopCount += 1; let failure = refusesStop; lock.unlock()
        if failure { throw MeetingAudioFailure.cleanupFailed }
    }
}
