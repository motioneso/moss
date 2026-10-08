import XCTest
@testable import TrailMarker

final class MeetingStartupSourceRecoveryTests: XCTestCase {
    private let origin: UInt64 = 10_000_000_000
    private let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
                                              meetingDeviceAuthorized: true)

    private final class Device: MeetingAudioCapturing {
        var receiver: MeetingAudioReceiving?
        var starts = 0
        var stops = 0
        func start(into receiver: MeetingAudioReceiving) throws { self.receiver = receiver; starts += 1 }
        func stop() throws { stops += 1 }
    }

    private func start(output: Bool = false) throws -> (MeetingCaptureRuntime, [Device]) {
        let microphone = Device(), computer = Device()
        let runtime = MeetingCaptureRuntime { _ in
            output ? [.microphone: microphone, .output: computer] : [.microphone: microphone]
        }
        try runtime.prepare(selection: .init(microphoneDeviceID: 42,
            output: output ? .excludingProcesses([101]) : nil), readiness: ready, at: origin)
        try runtime.start(readiness: ready, at: origin)
        return (runtime, output ? [microphone, computer] : [microphone])
    }

    private func put(_ ring: MeetingAudioBuffer, sample: Double, offset: UInt64, value: Float = 0.25) {
        ring.receive(sampleTime: sample, hostTimeNanoseconds: origin + offset,
            sampleRate: 8000, frameCount: 8, sampleAt: { _ in value })
    }

    func testQuarantineErasesBothSourcesAndReportsEveryDroppedIntervalWithoutReadingSamples() throws {
        let (runtime, devices) = try start(output: true)
        let rings = try devices.map { try XCTUnwrap($0.receiver as? MeetingAudioBuffer) }
        for ring in rings { put(ring, sample: 0, offset: 0) }
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin + 1_000_000))
        for ring in rings {
            XCTAssertTrue(ring.isScopeVerificationPending)
            ring.setScopeVerificationPending(true)
            ring.setScopeVerificationPending(false)
            XCTAssertTrue(ring.isScopeVerificationPending, "Low-level verification must not clear the host quarantine")
            XCTAssertNil(ring.peek(), "PCM captured before the missing-source notice must be erased")
            XCTAssertEqual(ring.diagnostics.bufferedSamples, 0)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1, "Erasure must preserve packet sequence history")
            for sample in [8, 16] {
                ring.receive(sampleTime: Double(sample), hostTimeNanoseconds: origin + UInt64(sample) * 125_000,
                    sampleRate: 8000, frameCount: 8, sampleAt: { _ in XCTFail("Quarantined PCM must not be read"); return 1 })
            }
            XCTAssertFalse(ring.withSendAdmission { XCTFail("Quarantined PCM must not be sent") })
        }
        XCTAssertEqual(runtime.capturedLevel(at: origin + 3_000_000), 0)
        XCTAssertFalse(try runtime.dispatchNext(at: origin + 3_000_000) { _ in XCTFail("Quarantine blocks both sources") })
        let gaps = try runtime.service(at: origin + 3_000_000)
        XCTAssertEqual(gaps.count, 4)
        for source in MeetingAudioSource.allCases {
            XCTAssertTrue(gaps.contains(.init(source: source, epoch: 1, startNanoseconds: origin,
                endNanoseconds: origin + 1_000_000, reason: .sourceVerification)))
            XCTAssertTrue(gaps.contains(.init(source: source, epoch: 1, startNanoseconds: origin + 1_000_000,
                endNanoseconds: origin + 3_000_000, reason: .sourceVerification)))
        }
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: origin + 3_000_000, unchanged: true))
        for ring in rings { put(ring, sample: 24, offset: 3_000_000, value: 0.75) }
        var packets: [MeetingAudioPacket] = []
        for _ in rings { XCTAssertTrue(try runtime.dispatchNext(at: origin + 4_000_000) { packets.append($0) }) }
        XCTAssertEqual(Set(packets.map(\.source)), Set(MeetingAudioSource.allCases))
        for packet in packets {
            XCTAssertEqual(packet.sequence, 1)
            XCTAssertEqual(packet.timelineOriginNanoseconds, origin)
            XCTAssertEqual(packet.sampleOffset, 24)
            XCTAssertEqual(packet.startNanoseconds, origin + 3_000_000)
            XCTAssertEqual(packet.samples, Array(repeating: 0.75, count: 8))
        }
        XCTAssertTrue(try runtime.service(at: origin + 4_000_000).isEmpty, "Gap delivery must not repeat")
        XCTAssertTrue(devices.allSatisfy { $0.starts == 1 && $0.stops == 0 }, "Recovery must not reopen hardware")
    }

    func testSlowSourceRecheckCoalescesMoreThanTwoHundredQuarantinedCallbacksPerTrack() throws {
        let (runtime, devices) = try start(output: true)
        let rings = try devices.map { try XCTUnwrap($0.receiver as? MeetingAudioBuffer) }
        let rate: Double = 48_000
        let frames = 64
        let callbacks = 250
        func offset(_ index: Int) -> UInt64 {
            MeetingAudioSampleClock.nanoseconds(frames: UInt64(index * frames), sampleRate: rate)!
        }
        for ring in rings {
            ring.receive(sampleTime: 0, hostTimeNanoseconds: origin, sampleRate: rate,
                frameCount: frames, sampleAt: { _ in 0.25 })
        }
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin + offset(1)))
        for ring in rings {
            for index in 1...callbacks {
                ring.receive(sampleTime: Double(index * frames), hostTimeNanoseconds: origin + offset(index),
                    sampleRate: rate, frameCount: frames,
                    sampleAt: { _ in XCTFail("Source verification must never read quarantined PCM"); return 99 })
            }
            XCTAssertNil(ring.failure)
            XCTAssertEqual(ring.diagnostics.droppedCallbacks, UInt32(callbacks))
            XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 0)
            XCTAssertEqual(ring.diagnostics.bufferedSamples, 0)
        }
        let confirmedAt = origin + offset(callbacks + 1)
        XCTAssertLessThan(confirmedAt - origin, 500_000_000)
        let gaps = try runtime.service(at: confirmedAt)
        XCTAssertEqual(runtime.snapshot.state, .recording)
        for source in MeetingAudioSource.allCases {
            let losses = gaps.filter { $0.source == source }
            XCTAssertEqual(losses.count, 2, "Erased PCM and coalesced dropped PCM each retain their complete interval")
            XCTAssertTrue(losses.allSatisfy { $0.reason == .sourceVerification })
            XCTAssertEqual(losses.first?.startNanoseconds, origin)
            XCTAssertEqual(losses.first?.endNanoseconds, losses.last?.startNanoseconds)
            XCTAssertEqual(losses.last?.endNanoseconds, confirmedAt)
        }
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: confirmedAt, unchanged: true))
        for ring in rings {
            ring.receive(sampleTime: Double((callbacks + 1) * frames), hostTimeNanoseconds: confirmedAt,
                sampleRate: rate, frameCount: frames, sampleAt: { _ in 0.75 })
            XCTAssertNil(ring.failure)
        }
        var packets: [MeetingAudioPacket] = []
        for _ in rings {
            XCTAssertTrue(try runtime.dispatchNext(at: origin + offset(callbacks + 2)) { packets.append($0) })
        }
        XCTAssertEqual(Set(packets.map(\.source)), Set(MeetingAudioSource.allCases))
        XCTAssertTrue(packets.allSatisfy { $0.startNanoseconds == confirmedAt && $0.samples == [Float](repeating: 0.75, count: frames) })
        XCTAssertTrue(devices.allSatisfy { $0.starts == 1 && $0.stops == 0 })
    }

    func testClockRecoveryHoldsBothTracksSoSourceRecheckCanStillEraseEveryUnofferedPacket() throws {
        let (runtime, devices) = try start(output: true)
        let microphone = try XCTUnwrap(devices[0].receiver as? MeetingAudioBuffer)
        let output = try XCTUnwrap(devices[1].receiver as? MeetingAudioBuffer)
        put(microphone, sample: 0, offset: 0)
        put(microphone, sample: 0, offset: 1_000_000, value: 99)
        put(microphone, sample: 8, offset: 2_000_000)
        for index in 0..<3 { put(output, sample: Double(index * 8), offset: UInt64(index) * 1_000_000) }
        XCTAssertNil(microphone.failure)
        XCTAssertFalse(try runtime.dispatchNext(at: origin + 3_000_000) { _ in
            XCTFail("A recovered microphone must hold both tracks throughout the source-recheck window")
        })
        XCTAssertFalse(try runtime.dispatchNextChunk(at: origin + 3_000_000) { _ in
            XCTFail("A short completed clock segment must not escape through chunk dispatch")
        })
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin + 3_000_000),
            "Clock recovery cannot consume never-offered eligibility for source recovery")
        XCTAssertNil(microphone.peek())
        XCTAssertNil(output.peek())
        for index in 0..<2 {
            put(microphone, sample: Double(16 + index * 8), offset: UInt64(3 + index) * 1_000_000, value: 99)
            put(output, sample: Double(24 + index * 8), offset: UInt64(3 + index) * 1_000_000, value: 99)
        }
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: origin + 5_000_000, unchanged: true))
        put(microphone, sample: 32, offset: 5_000_000, value: 0.75)
        put(output, sample: 40, offset: 5_000_000, value: 0.75)
        for offset in [UInt64(6_000_000), 499_999_999] {
            XCTAssertFalse(try runtime.dispatchNext(at: origin + offset) { _ in
                XCTFail("Both current-epoch tracks remain unoffered until the startup window closes")
            })
        }
        var packets: [MeetingAudioPacket] = []
        for _ in devices {
            XCTAssertTrue(try runtime.dispatchNext(at: origin + 500_000_000) { packets.append($0) })
        }
        XCTAssertEqual(Set(packets.map(\.source)), Set(MeetingAudioSource.allCases))
        for packet in packets {
            XCTAssertEqual(packet.startNanoseconds, origin + 5_000_000)
            XCTAssertEqual(packet.samples, [Float](repeating: 0.75, count: 8))
            XCTAssertEqual(packet.sequence, packet.source == .microphone ? 2 : 3)
        }
        let gaps = try runtime.service(at: origin + 500_000_000)
        XCTAssertTrue(gaps.contains { $0.source == .microphone && $0.reason == .startupTimestamp })
        XCTAssertTrue(gaps.contains { $0.source == .microphone && $0.reason == .sourceVerification })
        XCTAssertTrue(gaps.contains { $0.source == .output && $0.reason == .sourceVerification })
        XCTAssertFalse(gaps.contains { $0.reason == .callbackContention })
        XCTAssertEqual(runtime.snapshot.state, .recording)
        XCTAssertTrue(devices.allSatisfy { $0.starts == 1 && $0.stops == 0 }, "Both recoveries must stay in one hardware epoch")
    }

    func testAcknowledgedAndUnacknowledgedOffersBothPermanentlyBlockStartupRetry() throws {
        for received in [true, false] {
            let (runtime, devices) = try start()
            let ring = try XCTUnwrap(devices[0].receiver as? MeetingAudioBuffer)
            put(ring, sample: 0, offset: 0)
            var offered: MeetingAudioPacket?
            XCTAssertTrue(try runtime.dispatchNext(at: origin + 1_000_000) { offered = $0 })
            let packet = try XCTUnwrap(offered)
            runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: received)
            if received { XCTAssertNil(ring.peek()) }
            XCTAssertFalse(runtime.beginStartupSourceRecheck(at: origin + 2_000_000),
                "Retry requires that this epoch never offered PCM, even after receipt emptied the ring")
            XCTAssertFalse(ring.isScopeVerificationPending)
        }
    }

    func testOnlyOneStartupRetryIsAllowedEvenAfterSuccessfulProof() throws {
        let (runtime, _) = try start()
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin))
        XCTAssertFalse(runtime.beginStartupSourceRecheck(at: origin + 1))
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: origin + 2, unchanged: true))
        XCTAssertFalse(runtime.beginStartupSourceRecheck(at: origin + 3))
    }

    func testStartupRetryUsesInclusiveHalfSecondEpochBoundary() throws {
        let (runtime, _) = try start()
        XCTAssertFalse(runtime.beginStartupSourceRecheck(at: origin - 1))
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin + 500_000_000))
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: origin + 500_000_000, unchanged: true))
        let (late, devices) = try start()
        XCTAssertFalse(late.beginStartupSourceRecheck(at: origin + 500_000_001))
        XCTAssertFalse(try XCTUnwrap(devices[0].receiver as? MeetingAudioBuffer).isScopeVerificationPending)
    }

    func testUnchangedProofOutsideStartupWindowCannotReopenCallbacks() throws {
        for completion in [origin - 1, origin + 500_000_001] {
            let (runtime, devices) = try start()
            let ring = try XCTUnwrap(devices[0].receiver as? MeetingAudioBuffer)
            XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin + 1))
            XCTAssertFalse(runtime.finishStartupSourceRecheck(at: completion, unchanged: true))
            XCTAssertTrue(ring.isScopeVerificationPending)
            ring.receive(sampleTime: 0, hostTimeNanoseconds: origin + 1_000_000,
                sampleRate: 8000, frameCount: 8, sampleAt: { _ in XCTFail("Expired proof must leave callbacks gated"); return 1 })
            XCTAssertNil(ring.peek())
        }
    }

    func testChangedProofLeavesQuarantineClosed() throws {
        let (runtime, devices) = try start()
        let ring = try XCTUnwrap(devices[0].receiver as? MeetingAudioBuffer)
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin))
        XCTAssertFalse(runtime.finishStartupSourceRecheck(at: origin + 1, unchanged: false))
        XCTAssertFalse(runtime.beginStartupSourceRecheck(at: origin + 2), "Failed proof also consumes the single retry")
        XCTAssertTrue(ring.isScopeVerificationPending)
        XCTAssertFalse(ring.withSendAdmission { XCTFail("A different source is never startup recovery") })
    }

    func testHostProofNeverClearsIndependentLowLevelScopeGate() throws {
        let (runtime, devices) = try start(output: true)
        let output = try XCTUnwrap(devices[1].receiver as? MeetingAudioBuffer)
        output.setScopeVerificationPending(true)
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin))
        XCTAssertTrue(runtime.finishStartupSourceRecheck(at: origin + 1, unchanged: true))
        XCTAssertTrue(output.isScopeVerificationPending)
        put(output, sample: 0, offset: 0)
        XCTAssertNil(output.peek(), "A callback predating host confirmation must still be dropped")
        put(output, sample: 8, offset: 1_000_000)
        XCTAssertNotNil(output.peek(), "Wholly post-confirmation PCM may wait behind the independent scope gate")
        XCTAssertFalse(try runtime.dispatchNext(at: origin + 2_000_000) { _ in XCTFail("Low-level scope proof is still pending") })
        XCTAssertFalse(output.withSendAdmission { XCTFail("Host proof cannot authorize the tap scope") })
        output.setScopeVerificationPending(false)
        XCTAssertTrue(try runtime.dispatchNext(at: origin + 2_000_000) { XCTAssertEqual($0.source, .output) })
    }

    func testInvalidSelectionDuringRetryIsNeverClearedByUnchangedHostProof() throws {
        let (runtime, devices) = try start(output: true)
        let output = try XCTUnwrap(devices[1].receiver as? MeetingAudioBuffer)
        XCTAssertTrue(runtime.beginStartupSourceRecheck(at: origin))
        output.fail(.invalidSelection)
        XCTAssertFalse(runtime.finishStartupSourceRecheck(at: origin + 1_000_000, unchanged: true))
        XCTAssertEqual(output.failure, .invalidSelection)
        XCTAssertTrue(output.isScopeVerificationPending)
        let gaps = try runtime.service(at: origin + 1_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertTrue(gaps.contains { $0.source == .output && $0.reason == .captureFailure(.invalidSelection) })
        XCTAssertTrue(devices.allSatisfy { $0.stops == 1 })
        XCTAssertFalse(try runtime.dispatchNext(at: origin + 2_000_000) { _ in XCTFail("Scope fault must remain terminal for this epoch") })
    }

    func testCallbackSpanningAnEntireHostGateCycleCannotPublish() throws {
        let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: origin,
            sampleCapacity: 8, blockCapacity: 1)
        ring.receive(sampleTime: 0, hostTimeNanoseconds: origin, sampleRate: 8000, frameCount: 8) { index in
            if index == 0 {
                ring.setHostSourceVerificationPending(true)
                ring.setHostSourceVerificationPending(false)
            }
            return 0.75
        }
        XCTAssertNil(ring.peek(), "A completed quarantine cycle must still fence the older callback generation")
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 0)
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: origin, endNanoseconds: origin + 1_000_000, reason: .sourceVerification)])
    }

    func testStartupErasureRequiresHostQuarantine() throws {
        let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: origin,
            sampleCapacity: 8, blockCapacity: 1)
        put(ring, sample: 0, offset: 0)
        let before = try XCTUnwrap(ring.peek())
        XCTAssertNil(ring.discardUnsentStartupAudio())
        XCTAssertEqual(ring.peek(), before)
        ring.setScopeVerificationPending(true)
        XCTAssertNil(ring.discardUnsentStartupAudio(), "A tap scope gate alone must not authorize startup erasure")
        XCTAssertEqual(ring.peek(), before)
    }

    private var moss: MeetingProcessIdentity {
        .init(pid: 1, parentPID: 0, startedSeconds: 1, startedMicroseconds: 0,
            executable: "/Applications/Moss.app/Contents/MacOS/Moss")
    }
    private var computerChoice: MeetingCaptureChoice {
        .init(mode: "computer-audio", microphone: .init(deviceId: "mic-uid", sourceId: "mic"),
            outputSourceId: "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: [moss.key]))
    }
    private func inventory(excluded: [MeetingProcessIdentity]? = nil, processes: [MeetingProcessIdentity]? = nil,
                           objects: [Int32: UInt32] = [1: 101], microphone: UInt32? = 42) -> MeetingInventorySnapshot {
        let excluded = excluded ?? [moss]
        let wire = MeetingCaptureInventory(microphones: microphone == nil ? [] : [
            .init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic microphone")
        ], applications: [], computerAudio: .init(available: excluded.contains { objects[$0.pid] != nil },
            excludedProcessTreeIds: excluded.map(\.key)), microphonePermission: .granted, systemAudioPermission: .granted)
        return .init(wire: wire, microphones: microphone.map { ["mic-uid": $0] } ?? [:],
            applications: [:], processes: processes ?? [moss], audioObjects: objects, excluded: excluded)
    }

    func testOnlyMissingStartupMetadataQualifiesForFreshInventoryProof() throws {
        let original = inventory()
        for missing in [inventory(objects: [:]), inventory(microphone: nil),
                        inventory(excluded: [], processes: [], objects: [:])] {
            XCTAssertTrue(missing.onlyOmitsStartupSources(from: original, choice: computerChoice))
            XCTAssertThrowsError(try missing.resolve(computerChoice))
        }
        XCTAssertEqual(try inventory().resolve(computerChoice), try original.resolve(computerChoice))
    }

    func testObservedAdditionalMossCannotQualifyEvenIfItVanishesFromTheNextSnapshot() throws {
        let original = inventory()
        let otherMoss = MeetingProcessIdentity(pid: 2, parentPID: 0, startedSeconds: 2, startedMicroseconds: 0,
            executable: "/Applications/OtherMoss.app/Contents/MacOS/Moss")
        let observed = inventory(excluded: [moss, otherMoss], processes: [moss, otherMoss], objects: [1: 101, 2: 102])
        XCTAssertFalse(observed.onlyOmitsStartupSources(from: original, choice: computerChoice),
            "A newly observed Moss process must never qualify for startup reconfirmation")
        XCTAssertEqual(try inventory().resolve(computerChoice), try original.resolve(computerChoice),
            "A later matching snapshot cannot erase the positive observation that disallowed a retry")
    }

    func testRecycledPIDOrChangedAudioObjectNeverQualifiesAsAnOmission() throws {
        let original = inventory()
        let replacement = MeetingProcessIdentity(pid: moss.pid, parentPID: moss.parentPID,
            startedSeconds: moss.startedSeconds, startedMicroseconds: 1, executable: moss.executable)
        let changed = [
            inventory(excluded: [replacement], processes: [replacement]),
            inventory(excluded: [], processes: [replacement]),
            inventory(objects: [1: 102]),
            inventory(microphone: 43)
        ]
        for observed in changed {
            XCTAssertFalse(observed.onlyOmitsStartupSources(from: original, choice: computerChoice))
            XCTAssertEqual(try inventory().resolve(computerChoice), try original.resolve(computerChoice),
                "A later restoration must not turn a positively changed identity or object into a retry")
        }
    }

    func testSelectedApplicationNeverReceivesMissingInventoryStartupRetry() {
        let choice = MeetingCaptureChoice(mode: "selected-app", microphone: computerChoice.microphone,
            outputSourceId: "output", appProcessTreeId: "selected-app", scope: nil)
        XCTAssertFalse(inventory().onlyOmitsStartupSources(from: inventory(), choice: choice))
        XCTAssertFalse(inventory(objects: [:]).onlyOmitsStartupSources(from: inventory(), choice: choice))
    }

    func testGapDiagnosticsHasExactNumericBoundsAndFixedCauseLabel() {
        let gap = MeetingCaptureGap(id: "private-gap-id", sourceId: "private-device-id", epoch: 7,
            startMs: 1234, endMs: 5678, reason: "interrupted")
        XCTAssertEqual(MeetingCaptureGapDiagnostics.line(gap, source: .output, cause: .sourceVerification),
            "capture-gap source=output epoch=7 startMs=1234 endMs=5678 reason=interrupted cause=startup-source-verification")
        XCTAssertEqual(MeetingCaptureGapDiagnostics.line(gap, source: nil),
            "capture-gap source=unknown epoch=7 startMs=1234 endMs=5678 reason=interrupted cause=control-or-server")
    }

    func testGapDiagnosticsNeverInterpolatesIdentifiersReasonsOrFailureDetails() {
        let secret = "private-account-device-transcript"
        let gap = MeetingCaptureGap(id: secret, sourceId: secret, epoch: 1, startMs: 0, endMs: 1, reason: secret)
        let line = MeetingCaptureGapDiagnostics.line(gap, source: .microphone,
            cause: .captureFailure(.deviceFailure(operation: secret, status: -3105)))
        XCTAssertEqual(line,
            "capture-gap source=microphone epoch=1 startMs=0 endMs=1 reason=unknown cause=capture-failure")
        XCTAssertFalse(line.contains(secret))
        XCTAssertFalse(line.contains("-3105"))
    }
}
