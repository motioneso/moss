import Foundation
import XCTest
@testable import TrailMarker

final class MeetingHostBoundaryTests: XCTestCase {
    func testActivationAcceptsOnlyOriginAndMeetingUUID() throws {
        let id = "3ab582f1-3396-4795-8d46-c4e8ca7051cc"
        let valid = try XCTUnwrap(URL(string: "moss-meeting://capture?instance=https%3A%2F%2Fmoss.example&meetingId=\(id)"))
        XCTAssertEqual(try MeetingActivation.parse(valid).meetingId, id)
        for suffix in ["&credential=mm1_fake", "&meetingId=\(id)", "#token"] {
            XCTAssertThrowsError(try MeetingActivation.parse(URL(string: valid.absoluteString + suffix)!))
        }
        XCTAssertThrowsError(try MeetingActivation.parse(URL(string: "moss-meeting://capture?instance=http%3A%2F%2Fmoss.example&meetingId=\(id)")!))
        XCTAssertThrowsError(try MeetingActivation.parse(URL(string: "moss-meeting://capture?instance=https%3A%2F%2Fmoss.example%2Fother&meetingId=\(id)")!))
    }

    func testBrowserActivationUsesExistingMeetingsRouteAndIdQuery() throws {
        let id = "3ab582f1-3396-4795-8d46-c4e8ca7051cc"
        let activation = MeetingActivation(instance: try InstanceURL.parse("https://moss.example").get(), meetingId: id)
        let url = try XCTUnwrap(activation.browserURL)
        XCTAssertEqual(url.absoluteString, "https://moss.example/meetings?id=\(id)")
        XCTAssertEqual(url.path, "/meetings")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            [URLQueryItem(name: "id", value: id)])
        XCTAssertNil(url.fragment)
    }

    func testLaunchAndReconnectNeverExecuteExistingRecordingGeneration() {
        var fence = MeetingCommandFence()
        XCTAssertFalse(fence.shouldStart(generation: 3, desired: "recording"))
        XCTAssertFalse(fence.shouldStart(generation: 3, desired: "recording"))
        XCTAssertTrue(fence.shouldStart(generation: 4, desired: "recording"))
        XCTAssertFalse(fence.shouldStart(generation: 4, desired: "recording"))
        fence.interrupt()
        XCTAssertFalse(fence.shouldStart(generation: 5, desired: "recording"))
        XCTAssertFalse(fence.shouldStart(generation: 4, desired: "recording"))
        XCTAssertTrue(fence.shouldStart(generation: 6, desired: "recording"))
        XCTAssertFalse(fence.shouldStart(generation: 7, desired: "paused"))
        XCTAssertFalse(fence.shouldStart(generation: 7, desired: "recording"))
    }

    func testSelectedTreeRequiresAncestryBundleBoundaryAndExactRootLifetime() {
        let root = process(10, parent: 1, executable: "/Applications/Meet.app/Contents/MacOS/Meet")
        let helper = process(11, parent: 10, executable: "/Applications/Meet.app/Contents/Frameworks/Helper")
        let unrelated = process(12, parent: 10, executable: "/Applications/Other.app/Contents/MacOS/Other")
        let lookalike = process(13, parent: 1, executable: "/Applications/Meet.app/Contents/MacOS/Meet")
        let selection = MeetingProcessRoot(process: root, bundlePath: "/Applications/Meet.app", label: "Meeting")
        XCTAssertEqual(MeetingProcessScope.members(of: selection, processes: [root, helper, unrelated, lookalike]), [root, helper])
        var reused = [root, helper]
        reused[0] = MeetingProcessIdentity(pid: 10, parentPID: 1, startedSeconds: 2, startedMicroseconds: 0, executable: root.executable)
        XCTAssertTrue(MeetingProcessScope.members(of: selection, processes: reused).isEmpty)
    }

    func testMossExclusionIncludesReparentedHelpersAndDoesNotMatchPathPrefixLookalike() {
        let moss = process(1, parent: 0, executable: "/Applications/Trail Marker.app/Contents/MacOS/Trail Marker")
        let helper = process(2, parent: 99, executable: "/Applications/Trail Marker.app/Contents/XPCServices/Helper")
        let other = process(3, parent: 1, executable: "/Applications/Trail Marker.app.fake/Contents/MacOS/Fake")
        XCTAssertEqual(MeetingProcessScope.exclusions(bundlePaths: ["/Applications/Trail Marker.app"], processes: [moss, helper, other]), [moss, helper])
    }

    func testMicOnlyDoesNotRequireOrResolveOutputResources() throws {
        let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "mic", sourceId: "mic-source", label: "Microphone")],
            applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["mic": 12], applications: [:],
            processes: [], audioObjects: [:], excluded: [])
        let choice = MeetingCaptureChoice(mode: "microphone-only", microphone: .init(deviceId: "mic", sourceId: "mic-source"),
            outputSourceId: nil, appProcessTreeId: nil, scope: nil)
        XCTAssertNil(try snapshot.resolve(choice).selection.output)
        let widened = MeetingCaptureChoice(mode: "computer-audio", microphone: choice.microphone,
            outputSourceId: "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: []))
        XCTAssertThrowsError(try snapshot.resolve(widened))
    }

    func testWireSequenceIsContiguousAndUUIDStableAcrossUncertainRetry() {
        var sequence = MeetingUploadSequencer()
        let first = sequence.identity(epoch: 1, source: "mic", callbackSequence: 0)
        XCTAssertNotNil(UUID(uuidString: first.requestKey))
        XCTAssertEqual(first.sequence, 0)
        XCTAssertEqual(sequence.identity(epoch: 1, source: "mic", callbackSequence: 0), first)
        sequence.acknowledge(epoch: 1, source: "mic", callbackSequence: 0)
        let second = sequence.identity(epoch: 1, source: "mic", callbackSequence: 469)
        XCTAssertEqual(second.sequence, 1)
        XCTAssertNotEqual(first.requestKey, second.requestKey)
        sequence.acknowledge(epoch: 1, source: "mic", callbackSequence: 469)
        XCTAssertEqual(sequence.identity(epoch: 1, source: "mic", callbackSequence: 939).sequence, 2)
        XCTAssertEqual(sequence.identity(epoch: 1, source: "output", callbackSequence: 0).sequence, 0)
        XCTAssertEqual(sequence.identity(epoch: 2, source: "mic", callbackSequence: 0).sequence, 0)
    }

    func testPCMEncodingIsLittleEndianAndBoundsInvalidData() throws {
        XCTAssertEqual(Data(base64Encoded: try MeetingPCMEncoder.encode([-1, 0, 1])), Data([0, 128, 0, 0, 255, 127]))
        XCTAssertThrowsError(try MeetingPCMEncoder.encode([.nan]))
        XCTAssertThrowsError(try MeetingPCMEncoder.encode([]))
        XCTAssertEqual(MeetingCaptureClient.verifierHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @MainActor
    func testLifecycleBarrierRunsBeforeConnectionMutations() {
        let connection = ConnectionRuntime()
        var seen: [ConnectionEvent] = []
        connection.beforeLifecycleChange = { event in seen.append(event); return false }
        connection.send(.userLogout)
        connection.send(.userDisconnect)
        XCTAssertEqual(seen, [.userLogout, .userDisconnect])
        XCTAssertEqual(connection.state, .notLinked)
        XCTAssertNil(connection.identity)
    }

    func testStopFlushWaitsForExactStoppedAcknowledgment() {
        let recording = MeetingCaptureObserved(generation: 2, phase: "recording", errorCode: nil)
        let stopped = MeetingCaptureObserved(generation: 3, phase: "stopped", errorCode: nil)
        XCTAssertFalse(MeetingSendAdmission.permits(phase: .stopping, desired: "stopped", submitted: recording, current: stopped))
        XCTAssertFalse(MeetingSendAdmission.permits(phase: .stopping, desired: "stopped",
            submitted: .init(generation: 2, phase: "stopped", errorCode: nil), current: stopped))
        XCTAssertTrue(MeetingSendAdmission.permits(phase: .stopping, desired: "stopped", submitted: stopped, current: stopped))
    }

    func testConservativeClockNeverMapsServerStopLaterThanActualStop() throws {
        // Native request at 10 s; server samples elapsed 2 s at 10.1 s; response at 10.2 s.
        // True origin is 8.1 s. Earliest possible origin is 8 s, so cutoff is 100 ms early.
        let clock = try MeetingCaptureClock(requestSent: 10_000_000_000, responseReceived: 10_200_000_000,
            elapsedMilliseconds: 2000)
        XCTAssertEqual(clock.originNanoseconds, 7_999_000_000)
        XCTAssertLessThanOrEqual(try clock.nativeTime(5000), 13_100_000_000)
        XCTAssertEqual(try clock.nativeTime(5000), 12_999_000_000)
        XCTAssertThrowsError(try MeetingCaptureClock(requestSent: 10_000_000_000, responseReceived: 23_000_000_000,
            elapsedMilliseconds: 2000))
        XCTAssertNoThrow(try MeetingCaptureClock(requestSent: 10_000_000_000, responseReceived: 16_000_000_000,
            elapsedMilliseconds: 2000))
    }

    @MainActor
    func testSourceChangeCleanupFailureKeepsIndicatorAndStopRetriesExactHandle() throws {
        final class Device: MeetingAudioCapturing {
            var stopCalls = 0
            var mustFail = true
            func start(into receiver: MeetingAudioReceiving) throws {}
            func stop() throws {
                stopCalls += 1
                if mustFail { throw MeetingAudioFailure.cleanupFailed }
            }
        }
        let device = Device()
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: device] })
        let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
            meetingDeviceAuthorized: true)
        try runtime.prepare(selection: .init(microphoneDeviceID: 1, output: nil), readiness: ready, at: 1)
        try runtime.start(readiness: ready, at: 2)
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), runtime: runtime)
        host.sourceChanged()
        XCTAssertTrue(host.cleanupBlocked)
        XCTAssertTrue(host.isRecording)
        XCTAssertTrue(host.canStop)
        XCTAssertEqual(device.stopCalls, 1)
        device.mustFail = false
        host.stopFromUserClick()
        XCTAssertEqual(device.stopCalls, 2)
        XCTAssertFalse(host.cleanupBlocked)
        XCTAssertFalse(host.isRecording)
    }

    func testExplicitGapCapTerminatesImpossibleAcknowledgmentWaitAtFinalClose() {
        var pending: [MeetingCaptureGap] = []
        for index in 0..<32 {
            let start: UInt64 = UInt64(index) * 1000
            let end: UInt64 = start + 1000
            let gap = MeetingCaptureGap(id: "unsaved-\(index)", sourceId: "microphone", epoch: 1,
                startMs: start, endMs: end, reason: "interrupted")
            pending.append(gap)
        }
        XCTAssertEqual(MeetingGapDelivery.remaining(pending, acknowledgedIDs: [], limitReached: false).count, 32)
        let afterCap = MeetingGapDelivery.remaining(pending, acknowledgedIDs: [], limitReached: true)
        XCTAssertTrue(afterCap.isEmpty, "Explicitly unsavable gap IDs must not block the stopped final-close condition")
        XCTAssertTrue(MeetingGapDelivery.remaining(afterCap, acknowledgedIDs: [], limitReached: true).isEmpty)
    }

    @MainActor
    func testFillingPendingGapMetadataKeepsStopEnabledWithoutOpeningDevices() {
        var openedDevices = 0
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), factory: { _ in
            openedDevices += 1
            return [:]
        })
        for index in 0...256 {
            host.queueGap(.init(id: "generated-\(index)", sourceId: "microphone", epoch: 1,
                startMs: UInt64(index * 1000), endMs: UInt64((index + 1) * 1000), reason: "interrupted"))
        }
        XCTAssertEqual(openedDevices, 0)
        XCTAssertEqual(host.phase, .paused)
        XCTAssertTrue(host.canStop)
        XCTAssertTrue(host.gapCoverageIncomplete)
        XCTAssertEqual(host.gapCount, 257)
        XCTAssertFalse(host.isRecording)
    }

    func testTerminalFailedReceiptReleasesAudioAndCannotReplayDuringStop() throws {
        final class Device: MeetingAudioCapturing {
            var receiver: MeetingAudioReceiving?
            func start(into receiver: MeetingAudioReceiving) throws { self.receiver = receiver }
            func stop() throws {}
        }
        let device = Device()
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: device] })
        let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
            meetingDeviceAuthorized: true)
        try runtime.prepare(selection: .init(microphoneDeviceID: 1, output: nil), readiness: ready, at: 0)
        try runtime.start(readiness: ready, at: 0)
        device.receiver?.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.25 })
        var offered: MeetingAudioPacket?
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 1_000_000_000, targetDurationNanoseconds: 1_000_000_000) { offered = $0 })
        let packet = try XCTUnwrap(offered)
        var sequencer = MeetingUploadSequencer()
        let identity = sequencer.identity(epoch: packet.epoch, source: "microphone", callbackSequence: packet.sequence)
        XCTAssertFalse(MeetingCaptureReceipt(requestKey: identity.requestKey, status: "pending", code: nil)
            .releasesAudio(matching: identity.requestKey))
        XCTAssertFalse(MeetingCaptureReceipt(requestKey: "another-request", status: "failed", code: nil)
            .releasesAudio(matching: identity.requestKey))
        let receipt = MeetingCaptureReceipt(requestKey: identity.requestKey, status: "failed", code: "processing_failed")
        let terminal = receipt.releasesAudio(matching: identity.requestKey)
        XCTAssertTrue(terminal)
        var gaps: [MeetingCaptureGap] = []
        if terminal {
            gaps.append(.init(id: UUID().uuidString, sourceId: "microphone", epoch: packet.epoch,
                startMs: 0, endMs: 1000, reason: "processing-failed"))
            sequencer.acknowledge(epoch: packet.epoch, source: "microphone", callbackSequence: packet.sequence)
        }
        runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: terminal)
        try runtime.pause(at: 1_000_000_001)
        try runtime.stop(at: 1_000_000_002)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 1_000_000_003) { _ in XCTFail("Failed packet must not replay during Stop") })
        try runtime.finish(at: 1_000_000_003)
        XCTAssertEqual(runtime.snapshot.state, .finished)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(sequencer.identity(epoch: packet.epoch, source: "microphone", callbackSequence: packet.sequence + 1).sequence, 1)
    }

    func testFractionalMillisecondWireChunksShareExactCumulativeBoundary() throws {
        let origin: UInt64 = 4_000_000_000
        let phase: UInt64 = 400_000
        let rate = 48000.0
        let frames = 240128
        var priorEnd: UInt64?
        let samples = [Float](repeating: 0, count: frames)
        for index in 0..<5000 {
            let offset = UInt64(index * frames)
            let packet = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: UInt64(index),
                startNanoseconds: origin + phase + (MeetingAudioSampleClock.nanoseconds(frames: offset, sampleRate: rate) ?? 0),
                sampleRate: rate, samples: samples,
                timelineOriginNanoseconds: origin + phase, sampleOffset: offset)
            let boundary = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
            if let priorEnd { XCTAssertEqual(boundary.startMs, priorEnd, "No overlap or invented gap after thousands of chunks") }
            priorEnd = boundary.endMs
        }
    }

    func testRecordingDurationExcludesPreparationPausesAndStoppedTime() {
        var duration = MeetingRecordingDuration()
        XCTAssertEqual(duration.milliseconds(at: 30_000_000_000), 0)
        duration.start(at: 30_000_000_000)
        XCTAssertEqual(duration.milliseconds(at: 32_000_000_000), 2000)
        duration.pause(at: 32_000_000_000)
        XCTAssertEqual(duration.milliseconds(at: 90_000_000_000), 2000)
        duration.start(at: 90_000_000_000)
        duration.pause(at: 91_500_000_000)
        XCTAssertEqual(duration.milliseconds(at: 999_000_000_000), 3500)
    }

    func testRetryableProcessingFailureRetainsExactAudioButTerminalFailureReleasesIt() {
        let retryable = MeetingCaptureReceipt(requestKey: "chunk", status: "failed", code: "processing_failed",
            retryable: true, retryAfterMs: 2000)
        XCTAssertFalse(retryable.releasesAudio(matching: "chunk"))
        let terminal = MeetingCaptureReceipt(requestKey: "chunk", status: "failed", code: "processing_failed", retryable: false)
        XCTAssertTrue(terminal.releasesAudio(matching: "chunk"))
        XCTAssertFalse(terminal.releasesAudio(matching: "different"))
    }

    func testFreshConnectionStartIsOneUseAndInterruptionNeedsAnotherExplicitGeneration() {
        var fence = MeetingCommandFence()
        fence.acceptFreshStart(generation: 1)
        XCTAssertTrue(fence.shouldStart(generation: 1, desired: "recording"))
        XCTAssertFalse(fence.shouldStart(generation: 1, desired: "recording"))
        fence.interrupt()
        XCTAssertFalse(fence.shouldStart(generation: 1, desired: "recording"))
        XCTAssertTrue(fence.shouldStart(generation: 2, desired: "recording"))
    }

    func testPermissionContinuationRejectsStopExpiryReconnectionAndAnotherGrant() throws {
        let now = try XCTUnwrap(ServerTime.parse("2026-10-06T04:00:00Z"))
        let fence = MeetingStartPermissionFence(sessionGeneration: 8, captureGeneration: 1,
            grantId: "grant", deviceId: "device", expiresAt: now.addingTimeInterval(60))
        let valid = try permissionCapture(generation: 1, desired: "recording")
        XCTAssertTrue(fence.permits(session: 8, capture: valid, now: now, cancelled: false, stopped: false))
        XCTAssertFalse(fence.permits(session: 9, capture: valid, now: now, cancelled: false, stopped: false))
        XCTAssertFalse(fence.permits(session: 8, capture: valid, now: now, cancelled: true, stopped: false))
        XCTAssertFalse(fence.permits(session: 8, capture: valid, now: now, cancelled: false, stopped: true))
        XCTAssertFalse(fence.permits(session: 8, capture: valid, now: now.addingTimeInterval(61), cancelled: false, stopped: false))
        for desired in ["paused", "stopped", "revoked"] {
            XCTAssertFalse(fence.permits(session: 8, capture: try permissionCapture(generation: 2, desired: desired),
                now: now, cancelled: false, stopped: false))
        }
        let another = MeetingStartPermissionFence(sessionGeneration: 8, captureGeneration: 1,
            grantId: "another", deviceId: "device", expiresAt: now.addingTimeInterval(60))
        XCTAssertFalse(another.permits(session: 8, capture: valid, now: now, cancelled: false, stopped: false))
    }

    func testLostClaimResponseRetainsSameBearerAndHash() throws {
        let command = MeetingRecordingCommand(meetingId: "meeting", grantId: "grant", ownerUserId: "owner",
            expiresAt: "2026-10-06T04:01:00Z", selection: .init(mode: "microphone-only",
                microphone: .init(deviceId: "uid", sourceId: "mic"), outputSourceId: nil, appProcessTreeId: nil, scope: nil),
            capabilityRevision: 1)
        let pending = MeetingPendingStart(command: command, connectionId: "connection", deviceId: "device", secret: String(repeating: "s", count: 43))
        let first = pending.body(verifier: "verifier")
        let retry = pending.body(verifier: "verifier")
        XCTAssertEqual(first.credentialHash, retry.credentialHash)
        XCTAssertEqual(first.credentialHash, MeetingCaptureClient.verifierHash(pending.credential))
        XCTAssertNotEqual(first.credentialHash,
            MeetingPendingStart(command: command, connectionId: "connection", deviceId: "device", secret: String(repeating: "t", count: 43))
                .body(verifier: "verifier").credentialHash)
    }

    private func permissionCapture(generation: Int, desired: String) throws -> MeetingRemoteCapture {
        let object: [String: Any] = ["grantId": "grant", "deviceId": "device", "deviceName": "Mac",
            "generation": generation, "epoch": 1, "desired": desired, "epochStartMs": 0,
            "expiresAt": "2026-10-06T06:00:00Z", "serverTime": "2026-10-06T04:00:00Z", "elapsedMs": 0]
        return try JSONDecoder().decode(MeetingRemoteCapture.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testQuantizedServerClockNeverAdmitsFractionalPostStopAudio() throws {
        let clock = try MeetingCaptureClock(requestSent: 10_000_900_000, responseReceived: 10_001_000_000,
            elapsedMilliseconds: 2000)
        let actualStop: UInt64 = 13_000_100_000
        XCTAssertLessThanOrEqual(try clock.nativeTime(5000), actualStop)
    }

    func testComputerCaptureIgnoresUnrelatedRouteMapsButNeverChangesMossExclusion() throws {
        let moss = process(1, parent: 0, executable: "/Applications/Moss.app/Contents/MacOS/Moss")
        let other = process(2, parent: 0, executable: "/Applications/Other.app/Contents/MacOS/Other")
        let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "uid", sourceId: "mic", label: "Mic")],
            applications: [], computerAudio: .init(available: true, excludedProcessTreeIds: [moss.key]),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        let choice = MeetingCaptureChoice(mode: "computer-audio", microphone: .init(deviceId: "uid", sourceId: "mic"),
            outputSourceId: "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: [moss.key]))
        let before = MeetingInventorySnapshot(wire: inventory, microphones: ["uid": 42], applications: [:],
            processes: [moss], audioObjects: [1: 101], excluded: [moss], audioRoutes: [1: [70]])
        let after = MeetingInventorySnapshot(wire: inventory, microphones: ["uid": 42], applications: [:],
            processes: [moss, other], audioObjects: [1: 101, 2: 102], excluded: [moss], audioRoutes: [1: [70], 2: [88]])
        XCTAssertEqual(try before.resolve(choice), try after.resolve(choice))
        let widened = MeetingCaptureChoice(mode: "computer-audio", microphone: choice.microphone,
            outputSourceId: "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: []))
        XCTAssertThrowsError(try after.resolve(widened))
    }

    func testStableApplicationIdentityStillRequiresExactCurrentProcessScope() throws {
        let app = process(11, parent: 1, executable: "/Applications/Meet.app/Contents/MacOS/Meet")
        let root = MeetingProcessRoot(process: app, bundlePath: "/Applications/Meet.app", label: "Meet", applicationId: "org.example.meet")
        let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "uid", sourceId: "mic", label: "Mic")],
            applications: [.init(appProcessTreeId: app.key, label: "Meet", applicationId: "org.example.meet")],
            computerAudio: .init(available: false, excludedProcessTreeIds: []), microphonePermission: .granted, systemAudioPermission: .unknown)
        let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["uid": 42], applications: [app.key: root],
            processes: [app], audioObjects: [11: 101], excluded: [])
        var choice = MeetingCaptureChoice(mode: "selected-app", microphone: .init(deviceId: "uid", sourceId: "mic"),
            outputSourceId: "output", appProcessTreeId: app.key, scope: nil, applicationId: "org.example.meet")
        XCTAssertEqual(try snapshot.resolve(choice).selection.output, .selectedProcesses([101]))
        choice.applicationId = "org.example.other"
        XCTAssertThrowsError(try snapshot.resolve(choice))
    }

    func testPreclaimResumeRefreshesExpiredCommandWithoutChangingBearerOrBindings() throws {
        let old = MeetingRecordingCommand(meetingId: "meeting", grantId: "grant", ownerUserId: "owner",
            expiresAt: "2026-10-06T04:01:00Z", selection: .init(mode: "microphone-only",
                microphone: .init(deviceId: "uid", sourceId: "mic"), outputSourceId: nil, appProcessTreeId: nil, scope: nil),
            capabilityRevision: 1, generation: 1)
        var pending = MeetingPendingStart(command: old, connectionId: "connection", deviceId: "device", secret: String(repeating: "s", count: 43))
        let originalBearer = pending.credential
        let originalHash = pending.body(verifier: "verifier").credentialHash
        let resumed = MeetingRecordingCommand(meetingId: old.meetingId, grantId: old.grantId, ownerUserId: old.ownerUserId,
            expiresAt: "2026-10-06T04:03:00Z", selection: .init(mode: "microphone-only",
                microphone: .init(deviceId: "new-uid", sourceId: "new-mic"), outputSourceId: nil, appProcessTreeId: nil, scope: nil),
            capabilityRevision: 1, generation: 3)
        let resumeTime = try XCTUnwrap(ServerTime.parse("2026-10-06T04:02:00Z"))
        XCTAssertLessThan(try XCTUnwrap(ServerTime.parse(old.expiresAt)), resumeTime)
        XCTAssertGreaterThan(try XCTUnwrap(ServerTime.parse(resumed.expiresAt)), resumeTime)
        XCTAssertTrue(try pending.refresh(resumed, connectionId: "connection", deviceId: "device"))
        XCTAssertEqual(pending.command.expiresAt, resumed.expiresAt)
        XCTAssertEqual(pending.command.selection, resumed.selection)
        XCTAssertEqual(pending.credential, originalBearer)
        XCTAssertEqual(pending.body(verifier: "verifier").credentialHash, originalHash)
        XCTAssertFalse(try pending.refresh(old, connectionId: "connection", deviceId: "device"), "Stale response cannot roll back fresh Resume")
        XCTAssertEqual(pending.command.generation, 3)
        XCTAssertThrowsError(try pending.refresh(resumed, connectionId: "another-connection", deviceId: "device"))
        XCTAssertThrowsError(try pending.refresh(resumed, connectionId: "connection", deviceId: "another-device"))
        for (grant, owner) in [("another-grant", "owner"), ("grant", "another-owner")] {
            let changed = MeetingRecordingCommand(meetingId: old.meetingId, grantId: grant, ownerUserId: owner,
                expiresAt: resumed.expiresAt, selection: resumed.selection, capabilityRevision: 1, generation: 4)
            XCTAssertThrowsError(try pending.refresh(changed, connectionId: "connection", deviceId: "device"))
        }
    }

    private func process(_ pid: Int32, parent: Int32, executable: String) -> MeetingProcessIdentity {
        MeetingProcessIdentity(pid: pid, parentPID: parent, startedSeconds: 1, startedMicroseconds: 0, executable: executable)
    }
}
