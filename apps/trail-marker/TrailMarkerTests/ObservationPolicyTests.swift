import XCTest
@testable import TrailMarker

final class ObservationPolicyTests: XCTestCase {
    private func observation(bundle: String = "com.apple.Safari", title: String = "Docs") -> Observation {
        Observation(appName: "App", bundleId: bundle, windowTitle: title)
    }

    func testAnEmptyAllowlistObservesNothing() {
        let policy = ObservationPolicy(allowedBundleIds: [])
        XCTAssertFalse(policy.allows(observation()))
    }

    func testAnAllowlistedAppIsObserved() {
        let policy = ObservationPolicy(allowedBundleIds: ["com.apple.Safari"])
        XCTAssertTrue(policy.allows(observation()))
    }

    func testAnAppNotOnTheAllowlistIsRefused() {
        let policy = ObservationPolicy(allowedBundleIds: ["com.apple.Safari"])
        XCTAssertFalse(policy.allows(observation(bundle: "com.apple.mail")))
    }

    func testTheDenylistWinsEvenWhenThePersonAllowedTheApp() throws {
        // If allow were checked first, adding a password manager to the allowlist would
        // start sending its window titles.
        let denied = try XCTUnwrap(ObservationPolicy.deniedBundleIds.first)
        let policy = ObservationPolicy(allowedBundleIds: [denied])
        XCTAssertFalse(policy.allows(observation(bundle: denied)))
    }

    func testPrivateBrowsingTitlesAreRefusedInAnAllowedApp() {
        let policy = ObservationPolicy(allowedBundleIds: ["com.apple.Safari"])
        for title in ["Private Browsing — Bank", "New Incognito Tab", "Something - InPrivate", "private browsing"] {
            XCTAssertFalse(policy.allows(observation(title: title)), title)
        }
    }

    func testTheDenylistIncludesKnownPasswordManagers() {
        XCTAssertTrue(ObservationPolicy.deniedBundleIds.contains("com.1password.1password"))
        XCTAssertTrue(ObservationPolicy.deniedBundleIds.contains("com.apple.keychainaccess"))
    }

    func testWatchingTheEntireDesktopObservesAnAppNeverAddedToTheAllowlist() {
        let policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        XCTAssertTrue(policy.allows(observation(bundle: "com.example.SomeApp")))
    }

    func testWatchingTheEntireDesktopStillRefusesTheDenylist() throws {
        // The whole point of a fixed denylist: turning on "everything" must not turn on this too.
        let denied = try XCTUnwrap(ObservationPolicy.deniedBundleIds.first)
        let policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        XCTAssertFalse(policy.allows(observation(bundle: denied)))
    }

    func testWatchingTheEntireDesktopStillRefusesPrivateBrowsingTitles() {
        let policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        XCTAssertFalse(policy.allows(observation(title: "New Incognito Tab")))
    }

    func testTurningOffEntireDesktopFallsBackToTheAllowlist() {
        var policy = ObservationPolicy(allowedBundleIds: ["com.apple.Safari"], watchEntireDesktop: true)
        XCTAssertTrue(policy.allows(observation(bundle: "com.apple.mail")))
        policy.watchEntireDesktop = false
        XCTAssertFalse(policy.allows(observation(bundle: "com.apple.mail")))
        XCTAssertTrue(policy.allows(observation(bundle: "com.apple.Safari")))
    }
}
