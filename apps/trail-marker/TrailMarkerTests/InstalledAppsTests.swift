import XCTest
@testable import TrailMarker

final class InstalledAppsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("apps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeApp(_ name: String, bundleId: String) throws {
        let contents = directory.appendingPathComponent("\(name).app/Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleIdentifier": bundleId, "CFBundleName": name]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
    }

    func testListsAppsSortedByName() throws {
        try makeApp("Zed", bundleId: "com.example.zed")
        try makeApp("Alpha", bundleId: "com.example.alpha")
        XCTAssertEqual(InstalledApps.list(directories: [directory]).map(\.name), ["Alpha", "Zed"])
    }

    func testAppsOnTheDenylistCannotBePicked() throws {
        try makeApp("Vault", bundleId: "com.1password.1password")
        try makeApp("Notes", bundleId: "com.example.notes")
        XCTAssertEqual(InstalledApps.list(directories: [directory]).map(\.bundleId), ["com.example.notes"])
    }
}
