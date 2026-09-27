import XCTest
@testable import RocMindSpark

@MainActor
final class QuitFlushTests: XCTestCase {
    func testFastOperationSucceeds() async throws {
        var ran = false
        try await QuitFlush.run(timeout: .seconds(2)) { ran = true }
        XCTAssertTrue(ran)
    }

    func testOperationErrorPropagates() async {
        struct Boom: Error {}
        do {
            try await QuitFlush.run(timeout: .seconds(2)) { throw Boom() }
            XCTFail("expected error")
        } catch {
            XCTAssertTrue(error is Boom)
        }
    }

    func testHungOperationTimesOut() async {
        let started = Date()
        do {
            try await QuitFlush.run(timeout: .milliseconds(100)) {
                // Ignores cancellation, like callAsyncJavaScript on a hung page.
                await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
            }
            XCTFail("expected timeout")
        } catch {
            XCTAssertTrue(error is QuitFlush.TimedOut)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }
}
