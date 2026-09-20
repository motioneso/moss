import XCTest
@testable import TrailMarker

final class PermissionsServiceTests: XCTestCase {
    private final class FakeAdaptor: PermissionsOSAdaptor {
        private(set) var accessibilityCalls: [Bool] = []
        private(set) var screenRecordingCalls: [Bool] = []
        var accessibilityResult = false
        var screenRecordingResult = false

        func accessibilityTrusted(prompting: Bool) -> Bool {
            accessibilityCalls.append(prompting)
            return accessibilityResult
        }

        func screenRecordingGranted(prompting: Bool) -> Bool {
            screenRecordingCalls.append(prompting)
            return screenRecordingResult
        }
    }

    @MainActor
    func testRefreshNeverPrompts() {
        let adaptor = FakeAdaptor()
        let service = PermissionsService(adaptor: adaptor)

        service.refresh()

        XCTAssertEqual(adaptor.accessibilityCalls, [false])
        XCTAssertEqual(adaptor.screenRecordingCalls, [false])
    }

    @MainActor
    func testRequestAccessibilityPromptsExactlyOnce() {
        let adaptor = FakeAdaptor()
        adaptor.accessibilityResult = true
        let service = PermissionsService(adaptor: adaptor)

        service.requestAccessibility()

        XCTAssertEqual(adaptor.accessibilityCalls, [true])
        XCTAssertEqual(service.accessibility, .granted)
    }

    @MainActor
    func testRequestScreenRecordingPromptsExactlyOnce() {
        let adaptor = FakeAdaptor()
        adaptor.screenRecordingResult = false
        let service = PermissionsService(adaptor: adaptor)

        service.requestScreenRecording()

        XCTAssertEqual(adaptor.screenRecordingCalls, [true])
        XCTAssertEqual(service.screenRecording, .notGranted)
    }
}
