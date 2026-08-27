import XCTest
@testable import RocMindSpark

final class CanvasBootCoordinatorTests: XCTestCase {
    func testIdleStartFailedRetryReady() {
        var boot = CanvasBootCoordinator()
        XCTAssertEqual(boot.phase, .idle)
        XCTAssertFalse(boot.shouldLoadCanvas)
        XCTAssertFalse(boot.showsStatus)

        XCTAssertTrue(boot.requestStart())
        XCTAssertEqual(boot.phase, .starting)
        XCTAssertTrue(boot.showsStatus)
        XCTAssertFalse(boot.showsRetry)
        XCTAssertFalse(boot.shouldLoadCanvas)

        boot.markFailed()
        XCTAssertEqual(boot.phase, .failed)
        XCTAssertTrue(boot.showsRetry)
        XCTAssertFalse(boot.shouldLoadCanvas)

        XCTAssertTrue(boot.requestRetry())
        XCTAssertEqual(boot.phase, .retrying)
        XCTAssertTrue(boot.showsStatus)
        XCTAssertFalse(boot.showsRetry)

        boot.markSucceeded()
        XCTAssertEqual(boot.phase, .ready)
        XCTAssertTrue(boot.shouldLoadCanvas)
        XCTAssertFalse(boot.showsStatus)
    }

    func testIdleStartReadyWithoutFailure() {
        var boot = CanvasBootCoordinator()
        XCTAssertTrue(boot.requestStart())
        boot.markSucceeded()
        XCTAssertEqual(boot.phase, .ready)
        XCTAssertTrue(boot.shouldLoadCanvas)
    }

    func testDuplicateStartIsIgnored() {
        var boot = CanvasBootCoordinator()
        XCTAssertTrue(boot.requestStart())
        XCTAssertFalse(boot.requestStart())
        XCTAssertFalse(boot.requestStart())
        XCTAssertEqual(boot.phase, .starting)
    }

    func testDuplicateRetryIsIgnored() {
        var boot = CanvasBootCoordinator()
        XCTAssertTrue(boot.requestStart())
        boot.markFailed()
        XCTAssertTrue(boot.requestRetry())
        XCTAssertFalse(boot.requestRetry())
        XCTAssertFalse(boot.requestStart())
        XCTAssertEqual(boot.phase, .retrying)
    }

    func testShowDoesNotAutoRetryAfterFailure() {
        var boot = CanvasBootCoordinator()
        XCTAssertTrue(boot.requestStart())
        boot.markFailed()
        XCTAssertFalse(boot.requestStart())
        XCTAssertEqual(boot.phase, .failed)
    }

    func testRetryIgnoredUntilFailed() {
        var boot = CanvasBootCoordinator()
        XCTAssertFalse(boot.requestRetry())
        XCTAssertTrue(boot.requestStart())
        XCTAssertFalse(boot.requestRetry())
        boot.markSucceeded()
        XCTAssertFalse(boot.requestRetry())
        XCTAssertFalse(boot.requestStart())
        XCTAssertEqual(boot.phase, .ready)
    }

    func testMarkFailedIgnoredWhenIdleOrReady() {
        var boot = CanvasBootCoordinator()
        boot.markFailed()
        XCTAssertEqual(boot.phase, .idle)
        XCTAssertTrue(boot.requestStart())
        boot.markSucceeded()
        boot.markFailed()
        XCTAssertEqual(boot.phase, .ready)
    }
}
