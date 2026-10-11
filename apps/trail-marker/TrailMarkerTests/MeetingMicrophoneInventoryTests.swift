import CoreAudio
import XCTest
@testable import TrailMarker

final class MeetingMicrophoneInventoryTests: XCTestCase {
    private let microphones: [MeetingCaptureInventory.Microphone] = [
        .init(deviceId: "usb-uid", sourceId: "usb-source", label: "A USB microphone"),
        .init(deviceId: "built-in-uid", sourceId: "built-in-source", label: "Mac microphone")
    ]
    private let devices: [String: AudioObjectID] = ["usb-uid": 11, "built-in-uid": 22]

    func testLookupReadsTheSystemDefaultInputPropertyExactlyOnce() {
        var calls = 0
        let result = MeetingMicrophoneInventory.defaultInputDevice { object, selector in
            calls += 1
            XCTAssertEqual(object, AudioObjectID(kAudioObjectSystemObject))
            XCTAssertEqual(selector, kAudioHardwarePropertyDefaultInputDevice)
            return 22
        }
        XCTAssertEqual(result, 22)
        XCTAssertEqual(calls, 1)
    }

    func testUnknownOrFailedDefaultLookupDoesNotInventADevice() {
        XCTAssertNil(MeetingMicrophoneInventory.defaultInputDevice { _, _ in kAudioObjectUnknown })
        XCTAssertNil(MeetingMicrophoneInventory.defaultInputDevice { _, _ in throw MeetingHostError.unavailable })
    }

    func testOSDefaultWinsOverLabelAndEnumerationOrder() {
        for inventory in [microphones, Array(microphones.reversed())] {
            XCTAssertEqual(MeetingMicrophoneInventory.defaultMicrophoneId(device: 22,
                devices: devices, microphones: inventory), "built-in-uid")
            XCTAssertEqual(MeetingMicrophoneInventory.defaultMicrophoneId(device: 11,
                devices: devices, microphones: inventory), "usb-uid")
        }
    }

    func testMissingExcludedOrAmbiguousDefaultsAreOmitted() {
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: nil, devices: devices, microphones: microphones))
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: kAudioObjectUnknown, devices: devices, microphones: microphones))
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: 33, devices: devices, microphones: microphones))
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: 22, devices: devices, microphones: [microphones[0]]))
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: 22,
            devices: ["built-in-uid": 22, "alias-uid": 22], microphones: microphones))
        XCTAssertNil(MeetingMicrophoneInventory.defaultMicrophoneId(device: 22,
            devices: devices, microphones: microphones + [microphones[1]]))
    }

    func testDuplicateLabelsHaveStableUIDOrdering() {
        let namedAlike: [MeetingCaptureInventory.Microphone] = [
            .init(deviceId: "z", sourceId: "source-z", label: "Microphone"),
            .init(deviceId: "a", sourceId: "source-a", label: "Microphone")
        ]
        XCTAssertEqual(MeetingMicrophoneInventory.ordered(namedAlike).map(\.deviceId), ["a", "z"])
        XCTAssertEqual(MeetingMicrophoneInventory.ordered(Array(namedAlike.reversed())).map(\.deviceId), ["a", "z"])
        XCTAssertEqual(MeetingMicrophoneInventory.defaultMicrophoneId(device: 1,
            devices: ["a": 2, "z": 1], microphones: namedAlike), "z")
    }

    func testNewDefaultDoesNotRetargetAnExactSavedSelection() throws {
        let wire = inventory(defaultMicrophoneId: "usb-uid")
        let snapshot = MeetingInventorySnapshot(wire: wire, microphones: devices, applications: [:],
            processes: [], audioObjects: [:], excluded: [])
        let saved = MeetingCaptureChoice(mode: "microphone-only",
            microphone: .init(deviceId: "built-in-uid", sourceId: "built-in-source"),
            outputSourceId: nil, appProcessTreeId: nil, scope: nil)
        XCTAssertEqual(try snapshot.resolve(saved).selection.microphoneDeviceID, 22)
    }

    func testKnownDefaultIsEncodedAsItsExactUIDAndRoundTrips() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let current = inventory(defaultMicrophoneId: "built-in-uid")
        let data = try encoder.encode(current)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["defaultMicrophoneId"] as? String, "built-in-uid")
        XCTAssertEqual(Set(object.keys), Set(["microphones", "applications", "computerAudio",
            "microphonePermission", "systemAudioPermission", "defaultMicrophoneId"]))
        XCTAssertEqual(try decoder.decode(MeetingCaptureInventory.self, from: data), current)
    }

    func testUnresolvedDefaultIsExplicitNullEvenWithOneDifferentMicrophone() throws {
        let soleMicrophone = [microphones[0]]
        let unresolvedDevices: [AudioObjectID?] = [nil, kAudioObjectUnknown, 22, 33]
        for device in unresolvedDevices {
            let defaultID = MeetingMicrophoneInventory.defaultMicrophoneId(device: device,
                devices: devices, microphones: soleMicrophone)
            XCTAssertNil(defaultID)
            let current = inventory(defaultMicrophoneId: defaultID, microphones: soleMicrophone)
            let data = try JSONEncoder().encode(current)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertTrue(object["defaultMicrophoneId"] is NSNull,
                "An unresolved default must not look like an older client that omitted the field")
            XCTAssertEqual(try JSONDecoder().decode(MeetingCaptureInventory.self, from: data), current)
        }
    }

    func testOlderInventoryWithoutDefaultStillDecodesAndReencodesAsExplicitUnknown() throws {
        let current = inventory(defaultMicrophoneId: nil)
        let data = try JSONEncoder().encode(current)
        var oldObject = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        oldObject.removeValue(forKey: "defaultMicrophoneId")
        let oldData = try JSONSerialization.data(withJSONObject: oldObject)
        let decoded = try JSONDecoder().decode(MeetingCaptureInventory.self, from: oldData)
        XCTAssertEqual(decoded, current)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any])
        XCTAssertTrue(encoded["defaultMicrophoneId"] is NSNull)
    }

    private func inventory(defaultMicrophoneId: String?,
                           microphones: [MeetingCaptureInventory.Microphone]? = nil) -> MeetingCaptureInventory {
        .init(microphones: microphones ?? self.microphones, applications: [],
            computerAudio: .init(available: false, excludedProcessTreeIds: []),
            microphonePermission: .unknown, systemAudioPermission: .unknown,
            defaultMicrophoneId: defaultMicrophoneId)
    }
}
