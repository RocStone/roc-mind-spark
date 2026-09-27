import XCTest
@testable import RocMindSpark

final class NodeVersionTests: XCTestCase {
    func testParse() {
        XCTAssertEqual(NodeVersion("22.13.0")?.description, "22.13.0")
        XCTAssertEqual(NodeVersion("v24.1.2\n")?.description, "24.1.2")
        XCTAssertEqual(NodeVersion("20.9")?.description, "20.9.0")
        XCTAssertNil(NodeVersion("system"))
        XCTAssertNil(NodeVersion(""))
    }

    func testMinimum() {
        XCTAssertTrue(NodeVersion("22.13.0")! >= .minimum)
        XCTAssertTrue(NodeVersion("23.0.0")! >= .minimum)
        XCTAssertFalse(NodeVersion("22.12.9")! >= .minimum)
        XCTAssertFalse(NodeVersion("20.18.1")! >= .minimum)
    }

    func testNewestNvmDirectoryIsNumericNotLexical() {
        XCTAssertEqual(NodeLocator.newestVersionName(["v9.11.2", "v22.13.1", "v22.2.0", ".DS_Store"]), "v22.13.1")
        XCTAssertNil(NodeLocator.newestVersionName([".DS_Store"]))
    }
}
