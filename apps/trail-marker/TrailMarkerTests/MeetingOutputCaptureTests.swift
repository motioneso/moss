import AudioToolbox
import CoreAudio
import XCTest
@testable import TrailMarker

@available(macOS 14.2, *)
final class MeetingOutputCaptureTests: XCTestCase {
    private final class Receiver: MeetingAudioReceiving {
        var received = 0
        var dropped = 0
        func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
            dropped += frameCount
        }
        var failures: [MeetingAudioFailure] = []
        func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
            received += frameCount
        }
        func fail(_ failure: MeetingAudioFailure) { failures.append(failure) }
    }
    private final class Hardware: MeetingOutputHardware {
        var events: [String] = []
        var failure: String?
        var scope: MeetingOutputScope?
        var defaultOutput: AudioObjectID = 11
        var systemOutput: AudioObjectID = 12
        var routeChecks = 0
        var onStart: (() -> Void)?
        func verifyOutputRoutes(defaultOutput: AudioObjectID?, systemOutput: AudioObjectID?) throws {
            guard defaultOutput != nil || systemOutput != nil else { return }
            routeChecks += 1
            guard defaultOutput == self.defaultOutput, systemOutput == self.systemOutput else {
                throw MeetingAudioFailure.invalidSelection
            }
        }
        var format = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        func step(_ name: String) throws {
            events.append(name)
            if failure == name { throw MeetingAudioFailure.deviceFailure(operation: name, status: -99) }
        }
        func createTap(scope: MeetingOutputScope) throws -> AudioObjectID { self.scope = scope; try step("tap"); return 1 }
        func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription { try step("format"); return format }
        func createAggregate(tap: AudioObjectID) throws -> AudioObjectID { try step("aggregate"); return 2 }
        func createIO(device: AudioObjectID, tap: AudioObjectID, scope: MeetingOutputScope, format: AudioStreamBasicDescription,
                      receiver: MeetingAudioReceiving) throws -> MeetingOutputIO {
            try step("io"); return IO(self)
        }
        func destroyAggregate(_ device: AudioObjectID) throws { try step("destroyAggregate") }
        func destroyTap(_ tap: AudioObjectID) throws { try step("destroyTap") }
    }
    private final class IO: MeetingOutputIO {
        let hardware: Hardware
        init(_ hardware: Hardware) { self.hardware = hardware }
        func start() throws { try hardware.step("start"); hardware.onStart?() }
        func stop() throws { try hardware.step("stop") }
        func destroy() throws { try hardware.step("destroyIO") }
    }
    func testConstructionIsInertAndSelectionIsNeverBroadened() throws {
        let hardware = Hardware()
        let capture = CoreAudioMeetingOutput(scope: .selectedProcesses([7, 8]), hardware: hardware)
        XCTAssertTrue(hardware.events.isEmpty)
        try capture.start(into: Receiver())
        XCTAssertEqual(hardware.scope, .selectedProcesses([7, 8]))
        XCTAssertEqual(hardware.events, ["tap", "format", "aggregate", "io", "start"])
        try capture.stop()
        XCTAssertEqual(Array(hardware.events.suffix(4)), ["stop", "destroyIO", "destroyAggregate", "destroyTap"])
        let count = hardware.events.count
        try capture.stop()
        XCTAssertEqual(hardware.events.count, count)
    }
    func testEveryAcquisitionFailureRollsBackOnlyOwnedResources() {
        let cleanup: [String: [String]] = [
            "tap": [], "format": ["destroyTap"], "aggregate": ["destroyTap"],
            "io": ["destroyAggregate", "destroyTap"],
            "start": ["stop", "destroyIO", "destroyAggregate", "destroyTap"]
        ]
        for step in ["tap", "format", "aggregate", "io", "start"] {
            let hardware = Hardware()
            hardware.failure = step
            let capture = CoreAudioMeetingOutput(scope: .excludingProcesses([4]), hardware: hardware)
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            let tail = cleanup[step] ?? []
            XCTAssertEqual(Array(hardware.events.suffix(tail.count)), tail, step)
        }
    }
    func testEveryReleaseFailureRetainsOwnershipForRetry() throws {
        for step in ["stop", "destroyIO", "destroyAggregate", "destroyTap"] {
            let hardware = Hardware()
            let capture = CoreAudioMeetingOutput(scope: .selectedProcesses([7]), hardware: hardware)
            try capture.start(into: Receiver())
            hardware.failure = step
            XCTAssertThrowsError(try capture.stop())
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            hardware.failure = nil
            try capture.stop()
            XCTAssertEqual(hardware.events.last, "destroyTap")
        }
    }
    func testUnknownDuplicateAndEmptyScopeFailBeforeHAL() {
        for scope in [MeetingOutputScope.selectedProcesses([]), .selectedProcesses([0]),
                      .excludingProcesses([]), .excludingProcesses([1, 1])] {
            let hardware = Hardware()
            let capture = CoreAudioMeetingOutput(scope: scope, hardware: hardware)
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            XCTAssertTrue(hardware.events.isEmpty)
        }
    }
    func testUnsupportedTapFormatDoesNotStartAggregate() {
        let hardware = Hardware()
        hardware.format.mChannelsPerFrame = 2
        let capture = CoreAudioMeetingOutput(scope: .selectedProcesses([7]), hardware: hardware)
        XCTAssertThrowsError(try capture.start(into: Receiver()))
        XCTAssertEqual(hardware.events, ["tap", "format", "destroyTap"])
    }
    func testReleaseWithoutStopRunsTeardown() throws {
        let hardware = Hardware()
        var capture: CoreAudioMeetingOutput? = CoreAudioMeetingOutput(scope: .selectedProcesses([7]), hardware: hardware)
        try capture?.start(into: Receiver())
        capture = nil
        XCTAssertEqual(Array(hardware.events.suffix(4)), ["stop", "destroyIO", "destroyAggregate", "destroyTap"])
    }
    func testFormatChangeBeforeOpeningGateRejectsStartup() {
        let receiver = Receiver()
        let gate = MeetingOutputReceiverGate(receiver)
        gate.fail(.invalidFormat)
        XCTAssertThrowsError(try gate.open())
        gate.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(receiver.received, 0)
    }
    func testClosedGateIgnoresLateCallbacksAndOpenGateReportsFault() throws {
        let receiver = Receiver()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(receiver.received, 1)
        gate.fail(.invalidTimestamp)
        XCTAssertEqual(receiver.failures, [.invalidTimestamp])
        XCTAssertThrowsError(try gate.open())
        gate.close()
        gate.receive(hostTimeNanoseconds: 1, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(receiver.received, 1)
    }

    /// This verifies our +1 ownership transfer with a synthetic CF object, not HAL behavior.
    func testTapUIDReadConsumesRetainedReferenceWithoutOpeningHardware() throws {
        weak var observed: AnyObject?
        let expected = "synthetic-meeting-tap-\(UUID().uuidString)"
        try autoreleasepool {
            let uid = try SystemMeetingOutputHardware.readTapUID { size, output in
                XCTAssertEqual(size.pointee, UInt32(MemoryLayout<Unmanaged<CFString>?>.size))
                let created = CFStringCreateWithCString(nil, expected, CFStringBuiltInEncodings.UTF8.rawValue)!
                observed = created
                output.assumingMemoryBound(to: Unmanaged<CFString>?.self).pointee = Unmanaged.passRetained(created)
                return noErr
            }
            XCTAssertEqual(uid as String, expected)
            withExtendedLifetime(uid) { XCTAssertNotNil(observed) }
        }
        XCTAssertNil(observed, "The +1 synthetic property reference must be consumed exactly once")
    }

    func testTapUIDReadRejectsMissingValueWithoutOpeningHardware() {
        XCTAssertThrowsError(try SystemMeetingOutputHardware.readTapUID { _, _ in noErr }) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .invalidFormat)
        }
    }

    func testTapUIDReadRejectsMalformedByteCountWithNonNullOutput() {
        for size in [UInt32(0), UInt32(MemoryLayout<Unmanaged<CFString>?>.size - 1), UInt32.max] {
            weak var observed: AnyObject?
            autoreleasepool {
                let expected = "synthetic-invalid-size-\(UUID().uuidString)"
                let created = CFStringCreateWithCString(nil, expected, CFStringBuiltInEncodings.UTF8.rawValue)!
                observed = created
                let retained = Unmanaged.passRetained(created)
                do {
                    let uid = try SystemMeetingOutputHardware.readTapUID { byteCount, output in
                        output.assumingMemoryBound(to: Unmanaged<CFString>?.self).pointee = retained
                        byteCount.pointee = size
                        return noErr
                    }
                    XCTFail("A non-null value must not bypass the byte-count check: \(size)")
                    // If the size guard regresses, the successful return consumes our +1.
                    // Leave it to ARC rather than releasing that reference a second time.
                    withExtendedLifetime(uid) {}
                } catch {
                    // Rejection does not consume an untrusted output slot. The fixture still
                    // owns this known-valid synthetic reference and must balance it itself.
                    retained.release()
                    XCTAssertEqual(error as? MeetingAudioFailure, .invalidFormat)
                }
            }
            XCTAssertNil(observed, "Synthetic output ownership must be balanced on either outcome")
        }
    }

    func testTapUIDReadReportsStatusFailure() {
        XCTAssertThrowsError(try SystemMeetingOutputHardware.readTapUID { _, _ in -77 }) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .deviceFailure(operation: "read-tap-uid", status: -77))
        }
    }
    func testProcessIdentityIgnoresUnrelatedLaunchesAndExitsWithoutBroadeningScope() throws {
        for scope in [MeetingOutputScope.selectedProcesses([7, 8]), .excludingProcesses([7, 8])] {
            var processes: [UInt32: Int32] = [7: 101, 8: 102, 9: 103]
            func snapshot() throws -> [UInt32: Int32] {
                try MeetingOutputProcessIdentity.snapshot(scope: scope) { object in
                    guard let pid = processes[object] else { throw MeetingAudioFailure.invalidSelection }
                    return pid
                }
            }
            let original = try snapshot()
            processes.removeValue(forKey: 9)
            processes[10] = 104
            XCTAssertEqual(try snapshot(), original)
            XCTAssertEqual(Set(original.keys), Set([UInt32(7), 8]))
            processes[8] = 999
            XCTAssertNotEqual(try snapshot(), original, "A reused object cannot retain its old process identity")
            processes.removeValue(forKey: 7)
            XCTAssertThrowsError(try snapshot())
        }
    }

    func testInvalidProcessIdentityFailsClosed() {
        for pid in [Int32(0), -1] {
            XCTAssertThrowsError(try MeetingOutputProcessIdentity.snapshot(scope: .selectedProcesses([7])) { _ in pid })
        }
    }

    func testClosedGateLateFailureCannotReachOldReceiver() throws {
        let receiver = Receiver()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.close()
        gate.fail(.invalidSelection)
        gate.fail(.invalidSelection)
        gate.fail(.invalidFormat)
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertThrowsError(try gate.open())
    }

    func testEverySuccessfulRollbackAllowsFreshExplicitStart() throws {
        for stage in ["tap", "format", "aggregate", "io", "start"] {
            let hardware = Hardware()
            hardware.failure = stage
            let capture = CoreAudioMeetingOutput(scope: .selectedProcesses([7]), hardware: hardware)
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            hardware.failure = nil
            try capture.start(into: Receiver())
            try capture.stop()
            XCTAssertEqual(Array(hardware.events.suffix(4)), ["stop", "destroyIO", "destroyAggregate", "destroyTap"])
        }
    }

    func testGlobalExclusionRequiresVerifiedCompleteScopeButIgnoresUnrelatedEvents() {
        let original: [UInt32: Int32] = [7: 101]
        XCTAssertTrue(MeetingOutputProcessIdentity.invalidates(scope: .excludingProcesses([7]),
            original: original, readCurrent: { original }), "Unknown exclusions must fail closed")
        XCTAssertFalse(MeetingOutputProcessIdentity.invalidates(scope: .excludingProcesses([7]),
            original: original, readCurrent: { original }, readExclusions: { original }))
        XCTAssertTrue(MeetingOutputProcessIdentity.invalidates(scope: .excludingProcesses([7]),
            original: original, readCurrent: { original }, readExclusions: { [7: 101, 8: 202] }), "New Moss helper")
        XCTAssertTrue(MeetingOutputProcessIdentity.invalidates(scope: .excludingProcesses([7]),
            original: original, readCurrent: { original }, readExclusions: { throw MeetingAudioFailure.invalidSelection }))
        XCTAssertFalse(MeetingOutputProcessIdentity.invalidates(scope: .selectedProcesses([7]),
            original: original, readCurrent: { original }))
        XCTAssertTrue(MeetingOutputProcessIdentity.invalidates(scope: .selectedProcesses([7]),
            original: original, readCurrent: { [7: 102] }))
        XCTAssertTrue(MeetingOutputProcessIdentity.invalidates(scope: .selectedProcesses([7]),
            original: original, readCurrent: { throw MeetingAudioFailure.invalidSelection }))
    }

    func testOutputRouteEventClosesGateEvenWhenSampleFormatIsUnchanged() throws {
        let receiver = Receiver()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.receive(hostTimeNanoseconds: 0, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 0 })
        // This is the same failure emitted by default-output/device/per-app route listeners.
        gate.fail(.invalidSelection)
        gate.receive(hostTimeNanoseconds: 20_834, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(receiver.received, 1)
        XCTAssertEqual(receiver.failures, [.invalidSelection])
        XCTAssertThrowsError(try gate.open())
    }

    func testScopeFaultStillReachesReceiverAfterAnEarlierFormatFault() throws {
        let receiver = Receiver()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.fail(.invalidFormat)
        gate.fail(.invalidSelection)
        gate.close()
        gate.fail(.invalidSelection)
        gate.fail(.invalidSelection)
        XCTAssertEqual(receiver.failures, [.invalidFormat, .invalidSelection])
    }

    func testUnchangedTapFormatNoticeDoesNotCloseAdmission() throws {
        let receiver = Receiver(), hardware = Hardware()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        var reads = 0
        gate.verifyFormat(expected: hardware.format) { reads += 1; return hardware.format }
        gate.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(receiver.received, 1)
        XCTAssertTrue(receiver.failures.isEmpty)
        gate.close()
        gate.verifyFormat(expected: hardware.format) { XCTFail("Closed gate must not read destroyed hardware"); return hardware.format }
    }

    func testRealTapFormatChangeOrUnreadableFormatClosesAdmission() throws {
        for unreadable in [true, false] {
            let receiver = Receiver(), hardware = Hardware()
            let gate = MeetingOutputReceiverGate(receiver)
            try gate.open()
            gate.verifyFormat(expected: hardware.format) {
                if unreadable { throw MeetingAudioFailure.invalidFormat }
                var changed = hardware.format
                changed.mSampleRate = 44_100
                return changed
            }
            gate.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 0 })
            XCTAssertEqual(receiver.received, 0)
            XCTAssertEqual(receiver.failures, [unreadable ? .invalidFormat : .sourceReconfigured])
        }
    }

    func testConcurrentOutputCallbackRecordsGapAndKeepsTheGateOpen() throws {
        let ring = try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0,
                                         sampleCapacity: 32, blockCapacity: 4)
        let gate = MeetingOutputReceiverGate(ring)
        try gate.open()
        gate.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
            gate.receive(sampleTime: 1, hostTimeNanoseconds: 125_000, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 99 })
            return 1
        }
        gate.receive(sampleTime: 2, hostTimeNanoseconds: 250_000, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 2 })
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.peek()?.samples, [1])
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertEqual(ring.peek()?.samples, [2])
        XCTAssertEqual(ring.peek()?.startNanoseconds, 250_000)
        XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .output, epoch: 1,
            startNanoseconds: 125_000, endNanoseconds: 250_000, reason: .callbackContention)])
        gate.close()
    }

    func testTapCallbacksDuringOffThreadFormatVerificationAreReportedAsMissing() throws {
        let receiver = Receiver(), hardware = Hardware()
        let gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.verifyFormat(expected: hardware.format) {
            gate.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 1 })
            return hardware.format
        }
        XCTAssertEqual(receiver.received, 0)
        XCTAssertEqual(receiver.dropped, 1)
        gate.receive(sampleTime: 1, hostTimeNanoseconds: 20_834, sampleRate: 48000, frameCount: 1, sampleAt: { _ in 2 })
        XCTAssertEqual(receiver.received, 1)
        XCTAssertTrue(receiver.failures.isEmpty)
        gate.close()
    }

    func testScopeVerificationQuarantinesCallbacksAndQueuedAudioUntilProvenUnchanged() throws {
        let ring = try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0,
            sampleCapacity: 32, blockCapacity: 4)
        let gate = MeetingOutputReceiverGate(ring)
        try gate.open()
        gate.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 1 })
        gate.verifyScope {
            XCTAssertTrue(ring.isScopeVerificationPending)
            gate.receive(sampleTime: 1, hostTimeNanoseconds: 125_000, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 2 })
            return true
        }
        XCTAssertFalse(ring.isScopeVerificationPending)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.peek()?.samples, [1])
        XCTAssertEqual(ring.drainCaptureGaps().first?.reason, .callbackContention)
        gate.verifyScope { false }
        XCTAssertEqual(ring.failure, .invalidSelection)
        gate.close()
    }

    func testMossBundleClassificationKeepsBoundaryAndNewHelperExclusions() {
        let bundles: Set<String> = ["/Applications/Trail Marker.app"]
        XCTAssertTrue(MeetingOutputProcessIdentity.isMossProcess(
            executable: "/Applications/Trail Marker.app/Contents/XPCServices/Helper", bundleIdentifier: nil, mossBundlePaths: bundles))
        XCTAssertFalse(MeetingOutputProcessIdentity.isMossProcess(
            executable: "/Applications/Trail Marker.app.fake/Helper", bundleIdentifier: "org.example.app", mossBundlePaths: bundles))
        XCTAssertTrue(MeetingOutputProcessIdentity.isMossProcess(
            executable: "/Applications/Moss Desktop.app/Contents/MacOS/Moss", bundleIdentifier: "com.moss.desktop", mossBundlePaths: bundles))
        XCTAssertEqual(MeetingOutputProcessIdentity.bundlePaths(executable: "/Applications/Other.app/Contents/Helpers/Moss.app/Contents/MacOS/Moss"),
            ["/Applications/Other.app", "/Applications/Other.app/Contents/Helpers/Moss.app"])
        XCTAssertTrue(MeetingOutputProcessIdentity.isMossProcess(
            executable: "/Applications/Other.app/Contents/Helpers/Moss.app/Contents/MacOS/Moss",
            bundleIdentifier: "com.moss.helper", mossBundlePaths: bundles))
    }

    func testExclusionScanAcceptsListedSystemProcessWithPathButNoBSDInfo() throws {
        // Other-user processes may deny BSD metadata while allowing proc_pidpath.
        // The C regression exercises that OS boundary; this exercises the same scan used
        // by startup and the live process-list listener, without opening audio hardware.
        let processes: [UInt32: (pid: Int32, bsdInfo: Int?, path: String)] = [
            7: (101, 1, "/Applications/Trail Marker.app/Contents/MacOS/Trail Marker"),
            8: (202, nil, "/usr/sbin/coreaudiod")
        ]
        XCTAssertNil(processes[8]?.bsdInfo)
        let original: [UInt32: Int32] = [7: 101]
        let scan = {
            try MeetingOutputProcessIdentity.mossAudioProcesses(original: original,
                readList: { Set(processes.keys) },
                readPID: { try XCTUnwrap(processes[$0]?.pid) },
                readPath: { pid in try XCTUnwrap(processes.values.first { $0.pid == pid }?.path) },
                readBundleIdentifier: { _ in nil })
        }
        XCTAssertEqual(try scan(), original)
        XCTAssertFalse(MeetingOutputProcessIdentity.invalidates(scope: .excludingProcesses([7]),
            original: original, readCurrent: { original }, readExclusions: scan))
        let receiver = Receiver(), gate = MeetingOutputReceiverGate(receiver)
        try gate.open()
        gate.verifyScope { (try? scan()) == original }
        gate.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(receiver.received, 1)
        XCTAssertTrue(receiver.failures.isEmpty)
        gate.close()
    }

    func testExclusionScanRejectsUnreadableLivePathAndOnlyAllowsProvenUnrelatedExit() throws {
        let original: [UInt32: Int32] = [7: 101]
        for remainsListed in [true, false] {
            var lists = 0
            func scan() throws -> [UInt32: Int32] {
                try MeetingOutputProcessIdentity.mossAudioProcesses(original: original,
                    readList: { lists += 1; return lists == 1 || remainsListed ? [7, 8] : [7] },
                    readPID: { $0 == 7 ? 101 : 202 },
                    readPath: { pid in
                        if pid == 202 { throw MeetingAudioFailure.invalidSelection }
                        return "/Applications/Trail Marker.app/Contents/MacOS/Trail Marker"
                    }, readBundleIdentifier: { _ in nil })
            }
            if remainsListed { XCTAssertThrowsError(try scan()) }
            else { XCTAssertEqual(try scan(), original) }
            XCTAssertEqual(lists, 2, "An unreadable unrelated process needs a fresh list")
        }
        XCTAssertThrowsError(try MeetingOutputProcessIdentity.mossAudioProcesses(original: original,
            readList: { [] }, readPID: { _ in 101 },
            readPath: { _ in throw MeetingAudioFailure.invalidSelection }))
    }


    func testPinnedOutputRoutesRejectChangesBeforeAndDuringAcquisition() throws {
        for stage in ["before", "start", "unchanged"] {
            let hardware = Hardware(), receiver = Receiver()
            if stage == "before" { hardware.defaultOutput = 99 }
            if stage == "start" { hardware.onStart = { hardware.systemOutput = 99 } }
            let capture = CoreAudioMeetingOutput(scope: .excludingProcesses([7]),
                expectedDefaultOutputDeviceID: 11, expectedSystemOutputDeviceID: 12, hardware: hardware)
            if stage == "unchanged" { try capture.start(into: receiver) }
            else {
                XCTAssertThrowsError(try capture.start(into: receiver)) {
                    XCTAssertEqual($0 as? MeetingAudioFailure, .invalidSelection)
                }
            }
            XCTAssertEqual(hardware.routeChecks, stage == "before" ? 1 : 2,
                "Both physical output routes must be verified after acquisition")
            if stage == "before" { XCTAssertTrue(hardware.events.isEmpty) }
            if stage == "start" {
                XCTAssertEqual(Array(hardware.events.suffix(4)), ["stop", "destroyIO", "destroyAggregate", "destroyTap"])
            }
            try capture.stop()
        }
    }

    func testUnsupportedTapFormatRemainsHardEvenAfterRecoverableNotice() throws {
        let ring = try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0)
        let gate = MeetingOutputReceiverGate(ring), hardware = Hardware()
        try gate.open()
        gate.verifyFormat(expected: hardware.format) {
            var changed = hardware.format
            changed.mSampleRate = 44_100
            return changed
        }
        XCTAssertEqual(ring.failure, .sourceReconfigured)
        gate.close(preservingFailures: true)
        gate.verifyFormat(expected: hardware.format) {
            var malformed = hardware.format
            malformed.mSampleRate = .nan
            return malformed
        }
        XCTAssertEqual(ring.failure, .invalidFormat)
        gate.finishFaultMonitoring()
    }
}
