import Combine
import Foundation
import Sparkle

/// Wraps Sparkle's standard updater controller. The feed URL and EdDSA public key live in
/// Info.plist (`SUFeedURL`, `SUPublicEDKey`) — this service never derives either from the
/// linked instance (§1.5: the feed is fixed and never instance-specific).
@MainActor
final class UpdaterService: NSObject, ObservableObject {
    /// A build without `TRAIL_MARKER_DISTRIBUTION=1` has no real public key to verify an
    /// appcast against, so it never checks and Check Now stays disabled (§1.5, §10).
    let isDistributionBuild: Bool

    private let controller: SPUStandardUpdaterController

    @Published private(set) var canCheckForUpdates = false

    init(
        isDistributionBuild: Bool = (Bundle.main.infoDictionary?["TrailMarkerDistribution"] as? String) == "1"
    ) {
        self.isDistributionBuild = isDistributionBuild
        controller = SPUStandardUpdaterController(
            startingUpdater: isDistributionBuild, updaterDelegate: nil, userDriverDelegate: nil
        )
        super.init()
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .assign(to: &$canCheckForUpdates)
    }

    /// Recomputed on every connection-state change: Disconnect suspends automatic checks, but
    /// a person can still press Check Now (§1.5, §4).
    func setAutomaticChecksEnabled(_ enabled: Bool) {
        guard isDistributionBuild else { return }
        controller.updater.automaticallyChecksForUpdates = enabled
    }

    func checkForUpdates() {
        guard isDistributionBuild else { return }
        controller.updater.checkForUpdates()
    }
}
