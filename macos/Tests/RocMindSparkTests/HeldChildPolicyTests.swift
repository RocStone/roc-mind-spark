import XCTest
@testable import RocMindSpark

final class HeldChildPolicyTests: XCTestCase {
    func testNoChildDoesNothing() {
        XCTAssertEqual(HeldChildPolicy.begin(pid: nil, isRunning: false), .none)
        XCTAssertEqual(HeldChildPolicy.begin(pid: nil, isRunning: true), .none)
        XCTAssertEqual(HeldChildPolicy.begin(pid: 9, isRunning: false), .none)
    }

    func testRunningHeldChildGetsTerminate() {
        XCTAssertEqual(HeldChildPolicy.begin(pid: 42216, isRunning: true), .terminate(42216))
    }

    func testEscalateOnlyForceKillsRecordedPIDStillRunning() {
        XCTAssertEqual(
            HeldChildPolicy.escalate(recordedPID: 42216, stillRunning: true, currentPID: 42216),
            .forceKill(42216)
        )
    }

    func testNoForceKillAfterGracefulExit() {
        XCTAssertEqual(
            HeldChildPolicy.escalate(recordedPID: 42216, stillRunning: false, currentPID: 42216),
            .none
        )
    }

    func testNoForceKillIfPIDNoLongerMatchesHeldChild() {
        XCTAssertEqual(
            HeldChildPolicy.escalate(recordedPID: 42216, stillRunning: true, currentPID: 42489),
            .none
        )
        XCTAssertEqual(
            HeldChildPolicy.escalate(recordedPID: 42216, stillRunning: true, currentPID: nil),
            .none
        )
        XCTAssertEqual(
            HeldChildPolicy.escalate(recordedPID: nil, stillRunning: true, currentPID: 42216),
            .none
        )
    }
}

final class TerminationOnceTests: XCTestCase {
    func testTerminateRequestFiresOnce() {
        var once = TerminationOnce()
        XCTAssertTrue(once.request())
        XCTAssertFalse(once.request())
        XCTAssertFalse(once.request())
        XCTAssertTrue(once.requested)
    }

    func testBridgeDeliversOnTerminateOnce() {
        final class Box: @unchecked Sendable { var n = 0 }
        let box = Box()
        let bridge = POSIXTerminationBridge { box.n += 1 }
        bridge.handleSignal()
        bridge.handleSignal()
        bridge.handleSignal()
        XCTAssertEqual(box.n, 1)
    }
}
