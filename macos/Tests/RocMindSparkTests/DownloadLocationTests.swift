import XCTest
@testable import RocMindSpark

final class DownloadLocationTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "RocMindSparkTests.DownloadLocation"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testDefaultsToDownloads() {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        XCTAssertEqual(DownloadLocation.initialDirectory(defaults: defaults), downloads)
    }

    func testRemembersChosenFolder() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rms-dl-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        DownloadLocation.remember(savedFile: dir.appendingPathComponent("map.png"), defaults: defaults)
        XCTAssertEqual(
            DownloadLocation.initialDirectory(defaults: defaults)?.standardizedFileURL.path,
            dir.standardizedFileURL.path
        )
    }

    func testMissingRememberedFolderFallsBackToDownloads() {
        defaults.set("/nonexistent/rms-\(UUID().uuidString)", forKey: DownloadLocation.defaultsKey)
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        XCTAssertEqual(DownloadLocation.initialDirectory(defaults: defaults), downloads)
    }
}
