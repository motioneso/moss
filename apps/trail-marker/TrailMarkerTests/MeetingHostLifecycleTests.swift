import AppKit
import Foundation
import XCTest
@testable import TrailMarker

/// Runs the actual host task/control loop through a synthetic URLProtocol. No source reader,
/// microphone permission API, actual Keychain item, hardware or real network is used.
@MainActor
final class MeetingHostLifecycleTests: XCTestCase {
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
        let resumedPoll = try XCTUnwrap(host.pollTask)
        XCTAssertTrue(host.shutdown(reason: "Explicit Resume regression finished"))
        await resumedPoll.value
        XCTAssertNil(host.pollTask)
        XCTAssertEqual(fixture.device.starts, 1, "Closing the resumed session must not acquire the source again")
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
        let poll = try XCTUnwrap(host.pollTask)
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        let closeActions: [() -> Void] = [host.hideRecordingPill, { pill.panel.performClose(nil) }, { pill.panel.close() }]
        for close in closeActions {
            let deviceStops = fixture.device.stops
            close()
            XCTAssertEqual(host.phase, .recording, "Close must not Pause or Stop")
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
        let queuedControl = try XCTUnwrap(host.controlTask)
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        fixture.monotonic += 30_000_000_000
        host.service()
        // Pause queued its Task on this actor, but expiry closed the client before that
        // Task could start. Await it here so no failed request can leak into another test.
        await queuedControl.value
        XCTAssertEqual(fixture.server.controlCount, 0, "Expired queued controls must not reach transport")
        XCTAssertNil(host.controlTask)
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
        let suspendedPoll = try XCTUnwrap(host.pollTask)
        let requestsBeforeExpiry = fixture.server.requestCount
        fixture.monotonic += 30_000_000_000
        host.service()
        permission?.resume(returning: true)
        permission = nil
        // Wait for the actual permission continuation and poll to exit, not one
        // scheduler yield that can leave old work running in the next XCTest.
        await suspendedPoll.value
        XCTAssertEqual(fixture.server.requestCount, requestsBeforeExpiry, "Late permission must not revalidate or restart expired authority")
        XCTAssertNil(host.pollTask)
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
            XCTAssertFalse(host.recordingPresentation.showsPill)
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
        try await waitUntil { host.controlTask == nil }
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
        try await waitUntil { host.controlTask == nil }
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
        try await waitUntil { host.controlTask == nil }
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
        let queued = try XCTUnwrap(host.controlTask)
        await queued.value
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
        try await waitUntil { host.controlTask == nil }
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
            let queued = try XCTUnwrap(host.controlTask)
            await queued.value
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
        try await waitUntil { host.controlTask == nil }
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

    final class Device: MeetingAudioCapturing {
        var starts = 0
        var stops = 0
        var failStop = false
        var receiver: MeetingAudioReceiving?
        func start(into receiver: MeetingAudioReceiving) throws { starts += 1; self.receiver = receiver }
        func stop() throws { stops += 1; if failStop { throw MeetingAudioFailure.cleanupFailed } }
    }

    @MainActor
    final class Fixture {
        let server = FixtureServer()
        let device = Device()
        let client: MeetingCaptureClient
        let pending: MeetingPendingStart
        let instance: InstanceURL
        let defaultsName = "com.moss.meeting-host-tests." + UUID().uuidString
        var wall = FixtureServer.baseTime
        var monotonic: UInt64 = 10_000_000_000
        var permission: MeetingCapturePermission = .unknown
        var permissionReads = 0

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
                  permissionRequest: @escaping () async -> Bool) -> MeetingCaptureHost {
            let identity = LinkedIdentity(instance: instance, deviceId: server.deviceId, accountName: "Fixture", accountEmail: "fixture@example.invalid")
            let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
                applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
                microphonePermission: .unknown, systemAudioPermission: .unknown)
            let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["mic-uid": 42], applications: [:],
                processes: [], audioObjects: [:], excluded: [])
            let ports = MeetingCaptureHostPorts(identity: { identity }, connectionAvailable: { true }, readInventory: { customSnapshot ?? snapshot },
                microphonePermission: { self.permissionReads += 1; return self.permission }, requestMicrophone: permissionRequest,
                makeClient: Self.client, now: { self.monotonic }, wallNow: { self.wall })
            let defaults = UserDefaults(suiteName: defaultsName)!
            let connection = ConnectionRuntime(keychain: KeychainStore(service: defaultsName), preferences: PreferencesStore(defaults: defaults))
            return MeetingCaptureHost(connection: connection, ports: ports, factory: customFactory ?? { _ in [.microphone: self.device] })
        }
        func close() {
            client.close()
            HostLifecycleProtocol.remove(server.grantId)
            UserDefaults.standard.removePersistentDomain(forName: defaultsName)
        }
    }
}
