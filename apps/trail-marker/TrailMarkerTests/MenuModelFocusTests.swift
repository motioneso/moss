import XCTest
@testable import TrailMarker

/// The focus rows in the menu (plan Task 11). The lists without focus are unchanged and stay in
/// `MenuModelTests`.
final class MenuModelFocusTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let endsAt = Date(timeIntervalSince1970: 1_700_003_600)

    private var identity: LinkedIdentity {
        guard case .success(let instance) = InstanceURL.parse("https://moss.example.com") else {
            fatalError("expected a valid instance URL")
        }
        return LinkedIdentity(
            instance: instance, deviceId: "device-1", accountName: "Ben", accountEmail: "ben@example.com"
        )
    }

    private func watching(hasLast: Bool = false) -> FocusMenuInfo {
        FocusMenuInfo(
            state: .watching(blockId: "b", title: "Study AI", endsAt: endsAt),
            goalLine: "Study AI, ends 11:00 AM", hasLastJudgment: hasLast
        )
    }

    private func titles(_ connection: ConnectionState, _ focus: FocusMenuInfo?) -> [String] {
        MenuModel.items(state: connection, identity: identity, focus: focus)
            .filter { $0.kind == .text }.map(\.title)
    }

    func testConnectedAndWatching() {
        XCTAssertEqual(
            titles(.connected(lastContact: now), watching()),
            [
                "Connected", "Watching · Study AI, ends 11:00 AM", "moss.example.com", "ben@example.com",
                "Disconnect", "Pause Focus", "Open Moss", "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testLastJudgmentAppearsOnlyOnceOneExists() {
        XCTAssertEqual(
            titles(.connected(lastContact: now), watching(hasLast: true)),
            [
                "Connected", "Watching · Study AI, ends 11:00 AM", "moss.example.com", "ben@example.com",
                "Disconnect", "Pause Focus", "Last Judgment…", "Open Moss", "Settings…",
                "Log Out…", "Quit Trail Marker"
            ]
        )
        XCTAssertFalse(titles(.connected(lastContact: now), watching()).contains("Last Judgment…"))
    }

    func testNoBlockRightNow() {
        let focus = FocusMenuInfo(state: .noBlock, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            titles(.connected(lastContact: now), focus),
            [
                "Connected", "No block right now", "moss.example.com", "ben@example.com", "Disconnect",
                "Pause Focus", "Open Moss", "Settings…", "Log Out…",
                "Quit Trail Marker"
            ]
        )
    }

    func testPausedOffersResume() {
        let focus = FocusMenuInfo(state: .paused, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            titles(.connected(lastContact: now), focus),
            [
                "Connected", "Paused", "moss.example.com", "ben@example.com", "Disconnect", "Resume Focus",
                "Open Moss", "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testJudgmentNotSetUp() {
        let focus = FocusMenuInfo(state: .notReady, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            titles(.connected(lastContact: now), focus),
            [
                "Connected", "Judgment isn't set up on your Moss (ask the admin)", "moss.example.com",
                "ben@example.com", "Disconnect", "Pause Focus", "Open Moss", "Settings…",
                "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testCannotReachMossWhileReconnecting() {
        let focus = FocusMenuInfo(state: .unreachable, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            titles(.reconnecting(attempt: 1, lastContact: nil), focus),
            [
                "Reconnecting", "Can't reach Moss", "moss.example.com", "ben@example.com", "Retry Now",
                "Pause Focus", "Open Moss", "Settings…", "Log Out…",
                "Quit Trail Marker"
            ]
        )
    }

    func testFocusOffAddsNoRowsAtAll() {
        let off = FocusMenuInfo(state: .off, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            titles(.connected(lastContact: now), off),
            titles(.connected(lastContact: now), nil)
        )
        XCTAssertEqual(
            titles(.connected(lastContact: now), nil),
            [
                "Connected", "moss.example.com", "ben@example.com", "Disconnect", "Open Moss", "Settings…",
                "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testNotLinkedHasNoFocusRowsEvenIfFocusIsOn() {
        let items = MenuModel.items(state: .notLinked, identity: nil, focus: watching())
            .filter { $0.kind == .text }.map(\.title)
        XCTAssertEqual(
            items,
            ["Not linked", "Set Up Trail Marker", "Open Moss", "Settings…", "Quit Trail Marker"]
        )
    }

    func testPauseAndResumeAreNeverDestructive() {
        for state in [FocusWatchState.noBlock, .paused] {
            let focus = FocusMenuInfo(state: state, goalLine: nil, hasLastJudgment: false)
            let row = MenuModel.items(state: .connected(lastContact: now), identity: identity, focus: focus)
                .first { $0.role == .pauseResume }
            XCTAssertEqual(row?.isDestructive, false)
        }
    }


    func testTheGoalLineIsAbsentWithNoBlock() {
        let focus = FocusMenuInfo(state: .noBlock, goalLine: nil, hasLastJudgment: false)
        let texts = titles(.connected(lastContact: now), focus)
        XCTAssertFalse(texts.contains { $0.hasPrefix("Watching") })
    }

    func testTheIconHoverTextIsTheGoalOrJustTheName() {
        XCTAssertEqual(watching().hoverText, "Trail Marker: Study AI, ends 11:00 AM")
        XCTAssertEqual(FocusMenuInfo(state: .paused, goalLine: nil, hasLastJudgment: false).hoverText, "Trail Marker")
    }

    func testLabelsAreShownInPlainWords() {
        XCTAssertEqual(FocusLabel.focused.displayName, "On track")
        XCTAssertEqual(FocusLabel.necessaryDetour.displayName, "Necessary detour")
        XCTAssertEqual(FocusLabel.distracted.displayName, "Off track")
        XCTAssertEqual(FocusLabel.insufficientEvidence.displayName, "Not enough to tell")
    }
}

/// The card's layout: state, goal, the one primary button, then rows. Written out literally.
final class StatusCardLayoutTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let endsAt = Date(timeIntervalSince1970: 1_700_003_600)

    private var identity: LinkedIdentity {
        guard case .success(let instance) = InstanceURL.parse("https://moss.example.com") else {
            fatalError("expected a valid instance URL")
        }
        return LinkedIdentity(instance: instance, deviceId: "d", accountName: "Ben", accountEmail: "ben@example.com")
    }

    func testCardWhileWatching() {
        let focus = FocusMenuInfo(
            state: .watching(blockId: "b", title: "Study AI", endsAt: endsAt),
            goalLine: "Study AI, ends 11:00 AM", hasLastJudgment: true
        )
        XCTAssertEqual(
            MenuModel.card(state: .connected(lastContact: now), identity: identity, focus: focus),
            MenuModel.Card(
                statusTitle: "Connected", focusLine: "Watching · Study AI, ends 11:00 AM",
                primaryTitle: "Disconnect",
                rows: [
                    "Pause Focus", "Last Judgment…", "Open Moss", "Settings…",
                    "Log Out…", "Quit Trail Marker"
                ]
            )
        )
    }

    func testCardWithNoBlockAndPaused() {
        let noBlock = FocusMenuInfo(state: .noBlock, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            MenuModel.card(state: .connected(lastContact: now), identity: identity, focus: noBlock).focusLine,
            "No block right now"
        )
        let paused = FocusMenuInfo(state: .paused, goalLine: nil, hasLastJudgment: false)
        let card = MenuModel.card(state: .connected(lastContact: now), identity: identity, focus: paused)
        XCTAssertEqual(card.focusLine, "Paused")
        XCTAssertEqual(card.rows.first, "Resume Focus")
    }

    func testCardWithFocusOffIsTheOriginalCard() {
        XCTAssertEqual(
            MenuModel.card(state: .connected(lastContact: now), identity: identity, focus: nil),
            MenuModel.Card(
                statusTitle: "Connected", focusLine: nil, primaryTitle: "Disconnect",
                rows: ["Open Moss", "Settings…", "Log Out…", "Quit Trail Marker"]
            )
        )
    }

    func testNotLinkedCardHasNoFocusAtAll() {
        let focus = FocusMenuInfo(state: .noBlock, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(
            MenuModel.card(state: .notLinked, identity: nil, focus: focus),
            MenuModel.Card(
                statusTitle: "Not linked", focusLine: nil, primaryTitle: "Set Up Trail Marker",
                rows: ["Open Moss", "Settings…", "Quit Trail Marker"]
            )
        )
    }
}
