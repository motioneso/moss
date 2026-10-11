import Foundation
import XCTest
@testable import TrailMarker

final class LoginItemStateTests: XCTestCase {
    func testRefreshReadsActualStateWithoutChangingRegistration() {
        let service = FakeLoginItemService(status: .enabled)
        var state = LoginItemState()
        state.refresh(using: service)
        XCTAssertTrue(state.isEnabled)
        XCTAssertEqual(state.statusMessage, "Trail Marker will start at login.")
        service.currentStatus = .notRegistered
        state.refresh(using: service)
        XCTAssertFalse(state.isEnabled)
        XCTAssertEqual(state.statusMessage, "Trail Marker won’t start at login.")
        XCTAssertEqual(service.requests, [])
        XCTAssertEqual(service.statusReads, 2)
    }

    func testFailedEnableRollsBackToActualDisabledStateAndExposesError() {
        let service = FakeLoginItemService(status: .notRegistered)
        service.error = Failure()
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        XCTAssertFalse(state.isEnabled)
        XCTAssertEqual(state.status, .notRegistered)
        XCTAssertEqual(state.errorMessage, "Couldn’t turn on Start at login. Registration rejected.")
        XCTAssertTrue(state.showsSystemSettings)
        XCTAssertEqual(service.requests, [true])
        XCTAssertEqual(service.statusReads, 1)
    }

    func testFailedDisableKeepsActualEnabledStateAndExposesError() {
        let service = FakeLoginItemService(status: .enabled)
        service.error = Failure()
        var state = LoginItemState()
        state.refresh(using: service)
        state.setEnabled(false, using: service)
        XCTAssertTrue(state.isEnabled)
        XCTAssertEqual(state.errorMessage, "Couldn’t turn off Start at login. Registration rejected.")
        XCTAssertTrue(state.showsSystemSettings)
        XCTAssertEqual(service.requests, [false])
        XCTAssertEqual(service.statusReads, 2)
    }

    func testReadsActualStatusEvenWhenAThrowingOperationChangedIt() {
        let service = FakeLoginItemService(status: .notRegistered)
        service.nextStatus = .enabled
        service.error = Failure()
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        XCTAssertTrue(state.isEnabled)
        XCTAssertNotNil(state.errorMessage)
        XCTAssertEqual(service.statusReads, 1)
    }

    func testSuccessfulRegistrationNeedingApprovalDoesNotClaimEnabledStartup() {
        let service = FakeLoginItemService(status: .notRegistered)
        service.nextStatus = .requiresApproval
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        XCTAssertFalse(state.isEnabled)
        XCTAssertEqual(state.status, .requiresApproval)
        XCTAssertEqual(state.statusMessage, "Start at login needs approval in System Settings.")
        XCTAssertTrue(state.showsSystemSettings)
        XCTAssertNil(state.errorMessage)
    }

    func testSuccessfulCallsStillUseTheStatusReportedByMacOS() {
        let service = FakeLoginItemService(status: .notRegistered)
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        XCTAssertFalse(state.isEnabled)
        service.nextStatus = .enabled
        state.setEnabled(true, using: service)
        XCTAssertTrue(state.isEnabled)
        service.nextStatus = .notRegistered
        state.setEnabled(false, using: service)
        XCTAssertFalse(state.isEnabled)
        XCTAssertNil(state.errorMessage)
        XCTAssertEqual(service.requests, [true, true, false])
    }

    func testUnavailableStatusOffersRecoveryWithoutClaimingEnabledStartup() {
        let service = FakeLoginItemService(status: .unavailable)
        var state = LoginItemState()
        state.refresh(using: service)
        XCTAssertFalse(state.isEnabled)
        XCTAssertTrue(state.showsSystemSettings)
        XCTAssertEqual(state.statusMessage, "macOS couldn’t confirm Trail Marker’s login item.")
        XCTAssertEqual(service.requests, [])
    }

    func testRetryClearsFailureAndReadsTheSuccessfulState() {
        let service = FakeLoginItemService(status: .notRegistered)
        service.error = Failure()
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        XCTAssertNotNil(state.errorMessage)
        service.error = nil
        service.nextStatus = .enabled
        state.setEnabled(true, using: service)
        XCTAssertTrue(state.isEnabled)
        XCTAssertNil(state.errorMessage)
        XCTAssertFalse(state.showsSystemSettings)
        XCTAssertEqual(service.requests, [true, true])
    }

    func testUnchangedRefreshDoesNotHideFailureAndExternalRecoveryClearsIt() {
        let service = FakeLoginItemService(status: .notRegistered)
        service.error = Failure()
        var state = LoginItemState()
        state.setEnabled(true, using: service)
        state.refresh(using: service)
        XCTAssertNotNil(state.errorMessage)
        service.currentStatus = .enabled
        state.refresh(using: service)
        XCTAssertTrue(state.isEnabled)
        XCTAssertNil(state.errorMessage)
        XCTAssertEqual(service.requests, [true])
        XCTAssertEqual(service.statusReads, 3)
    }

    private struct Failure: LocalizedError {
        var errorDescription: String? { "Registration rejected." }
    }

    private final class FakeLoginItemService: LoginItemManaging {
        var currentStatus: LoginItemStatus
        var nextStatus: LoginItemStatus?
        var error: Error?
        private(set) var statusReads = 0
        private(set) var requests: [Bool] = []
        var status: LoginItemStatus {
            statusReads += 1
            return currentStatus
        }

        init(status: LoginItemStatus) { currentStatus = status }

        func openSystemSettings() {}

        func setEnabled(_ enabled: Bool) throws {
            requests.append(enabled)
            if let nextStatus { currentStatus = nextStatus }
            if let error { throw error }
        }
    }
}
