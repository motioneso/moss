import AudioToolbox
import CoreAudio
import XCTest
@testable import TrailMarker

@available(macOS 14.2, *)
final class MeetingOutputCaptureTests: XCTestCase {
    private final class Receiver: MeetingAudioReceiving {
        var received = 0
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
        func createIO(device: AudioObjectID, tap: AudioObjectID, format: AudioStreamBasicDescription,
                      receiver: MeetingAudioReceiving) throws -> MeetingOutputIO {
            try step("io"); return IO(self)
        }
        func destroyAggregate(_ device: AudioObjectID) throws { try step("destroyAggregate") }
        func destroyTap(_ tap: AudioObjectID) throws { try step("destroyTap") }
    }
    private final class IO: MeetingOutputIO {
        let hardware: Hardware
        init(_ hardware: Hardware) { self.hardware = hardware }
        func start() throws { try hardware.step("start") }
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
}
