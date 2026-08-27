import XCTest
@testable import RocMindSpark

final class CanvasPortPolicyTests: XCTestCase {
    func testNoChildMeansEveryListenerIsForeign() {
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [42, 99], ourChildPID: nil), [42, 99])
    }

    func testEmptyListenListIsEmpty() {
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [], ourChildPID: nil), [])
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [], ourChildPID: 7), [])
    }

    func testOurExitingChildIsNotForeign() {
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [7], ourChildPID: 7), [])
    }

    func testAnotherPIDBesideOurChildIsForeign() {
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [7, 8], ourChildPID: 7), [8])
    }

    func testSamePathNodeWouldStillBeForeignWithoutOurProcess() {
        // Policy does not inspect command lines. A hand-started server.js is
        // just another occupant if we do not hold its Process.
        XCTAssertEqual(CanvasPortPolicy.foreignOccupants(listenPIDs: [1234], ourChildPID: nil), [1234])
    }

    func testListenPIDsIsReadOnly() {
        let before = LoopbackPort.listenPIDs(port: 1)
        XCTAssertEqual(before, LoopbackPort.listenPIDs(port: 1))
    }
}
