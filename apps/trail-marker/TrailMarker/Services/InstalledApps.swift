import Foundation

struct InstalledApp: Identifiable, Equatable {
    let bundleId: String
    let name: String
    var id: String { bundleId }
}

/// The apps the person can choose from in the Focus settings. Read from the usual application
/// folders one level deep; apps that are always refused (password managers) and Trail Marker
/// itself are left out, so they cannot be picked by mistake.
enum InstalledApps {
    static var defaultDirectories: [URL] {
        [
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "/Applications/Utilities"),
            URL(fileURLWithPath: "/System/Applications"),
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        ]
    }

    static func list(directories: [URL] = defaultDirectories) -> [InstalledApp] {
        var found: [String: InstalledApp] = [:]
        let ownBundleId = Bundle.main.bundleIdentifier

        for directory in directories {
            let entries = (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
            )) ?? []
            for url in entries where url.pathExtension == "app" {
                guard
                    let bundle = Bundle(url: url),
                    let bundleId = bundle.bundleIdentifier,
                    bundleId != ownBundleId,
                    !ObservationPolicy.deniedBundleIds.contains(bundleId)
                else { continue }

                let name =
                    (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? url.deletingPathExtension().lastPathComponent
                found[bundleId] = InstalledApp(bundleId: bundleId, name: name)
            }
        }
        return found.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}
