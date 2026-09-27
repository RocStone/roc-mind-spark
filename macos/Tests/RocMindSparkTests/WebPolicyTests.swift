import XCTest
@testable import RocMindSpark

final class WebPolicyTests: XCTestCase {
    private func decide(_ s: String, download: Bool = false) -> WebPolicy.NavigationDecision {
        WebPolicy.navigation(url: URL(string: s), shouldPerformDownload: download, serverPort: 3034)
    }

    func testDownloadFlagWins() {
        XCTAssertEqual(decide("blob:http://127.0.0.1:3034/abc", download: true), .download)
        XCTAssertEqual(decide("http://127.0.0.1:3034/export.json", download: true), .download)
    }

    func testOwnBlobBecomesDownload() {
        XCTAssertEqual(decide("blob:http://127.0.0.1:3034/2f1c-uuid"), .download)
        XCTAssertEqual(decide("blob:http://127.0.0.1:9999/2f1c-uuid"), .cancel)
    }

    func testOnlyServerPortIsAllowed() {
        XCTAssertEqual(decide("http://127.0.0.1:3034/"), .allow)
        XCTAssertEqual(decide("http://localhost:3034/x"), .allow)
        XCTAssertEqual(decide("http://127.0.0.1:3000/"), .cancel)
        XCTAssertEqual(decide("http://localhost/"), .cancel)
    }

    func testExternalSchemes() {
        XCTAssertEqual(decide("https://example.com/a"), .openExternal)
        XCTAssertEqual(decide("http://example.com/a"), .openExternal)
        XCTAssertEqual(decide("mailto:a@b.c"), .openExternal)
        XCTAssertEqual(decide("file:///etc/passwd"), .cancel)
        XCTAssertEqual(decide("x-custom://run"), .cancel)
        XCTAssertEqual(decide("about:blank"), .allow)
    }

    func testCanOpenExternally() {
        XCTAssertTrue(WebPolicy.canOpenExternally(URL(string: "https://a.b")!))
        XCTAssertTrue(WebPolicy.canOpenExternally(URL(string: "MAILTO:a@b.c")!))
        XCTAssertFalse(WebPolicy.canOpenExternally(URL(string: "file:///tmp")!))
        XCTAssertFalse(WebPolicy.canOpenExternally(URL(string: "vscode://open")!))
    }

    func testServerOrigin() {
        XCTAssertTrue(WebPolicy.isServerOrigin(host: "127.0.0.1", port: 3034, serverPort: 3034))
        XCTAssertFalse(WebPolicy.isServerOrigin(host: "127.0.0.1", port: 3000, serverPort: 3034))
        XCTAssertFalse(WebPolicy.isServerOrigin(host: "evil.com", port: 3034, serverPort: 3034))
    }
}
