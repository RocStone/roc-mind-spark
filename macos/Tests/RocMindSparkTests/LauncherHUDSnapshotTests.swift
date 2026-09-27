import XCTest
@testable import RocMindSpark

final class LauncherHUDSnapshotTests: XCTestCase {
    func testOnlyOneProbeCanBeInFlight() {
        var state = LauncherHUDWatchState()
        state.activateDisplay()

        let first = state.beginProbeIfIdle()
        XCTAssertNotNil(first)
        XCTAssertNil(state.beginProbeIfIdle())

        XCTAssertEqual(first?.generation, state.displayGeneration)
        XCTAssertTrue(state.finish(first!))
        XCTAssertNil(state.inFlight)
    }

    func testHiddenDisplayInvalidatesOldResultButReleasesItsSlot() {
        var state = LauncherHUDWatchState()
        state.activateDisplay()
        let oldProbe = try! XCTUnwrap(state.beginProbeIfIdle())

        state.invalidateDisplay()

        XCTAssertFalse(state.finish(oldProbe))
        XCTAssertNil(state.inFlight)
        let nextProbe = try! XCTUnwrap(state.beginProbeIfIdle())
        XCTAssertGreaterThan(nextProbe.generation, oldProbe.generation)
    }

    func testStaleProbeCannotReleaseAReplacementProbe() {
        var state = LauncherHUDWatchState()
        let oldProbe = try! XCTUnwrap(state.beginProbeIfIdle())
        XCTAssertTrue(state.finish(oldProbe))

        let currentProbe = try! XCTUnwrap(state.beginProbeIfIdle())
        let stale = LauncherHUDWatchState.Probe(
            generation: currentProbe.generation,
            token: currentProbe.token &- 1
        )
        XCTAssertFalse(state.finish(stale))
        XCTAssertEqual(state.inFlight, currentProbe)
        XCTAssertTrue(state.finish(currentProbe))
    }

    func testTopHudUsesHighestLayer() {
        let lower = LauncherHUDWindow(
            id: 10,
            isHud: true,
            owner: "Raycast",
            layer: 8,
            width: 800,
            height: 80,
            pid: 1
        )
        let higher = LauncherHUDWindow(
            id: 11,
            isHud: true,
            owner: "Raycast",
            layer: 12,
            width: 800,
            height: 80,
            pid: 1
        )
        let menuExtra = LauncherHUDWindow(
            id: 12,
            isHud: false,
            owner: "Raycast",
            layer: 24,
            width: 20,
            height: 20,
            pid: 1
        )

        let snapshot = LauncherHUDSnapshot(windows: [lower, higher, menuExtra])
        XCTAssertEqual(snapshot.topHud?.id, higher.id)
    }

    func testLauncherOwnerAndMetricsPredicatesRemainStable() {
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherHudOwner(name: "Raycast", bundleId: nil))
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherHudOwner(name: "Anything", bundleId: "com.raycast.macos"))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherHudOwner(name: "Dock", bundleId: "com.apple.dock"))

        XCTAssertTrue(LauncherHUDSnapshot.isLauncherHudMetrics(width: 280, height: 48, alpha: 1))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherHudMetrics(width: 279, height: 48, alpha: 1))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherHudMetrics(width: 800, height: 80, alpha: 0.01))
    }

    func testOwnerNamePrefilterAcceptsOnlyKnownLaunchers() {
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherOwnerName("Raycast"))
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherOwnerName("Alfred"))
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherOwnerName("Alfred Preferences"))
        XCTAssertTrue(LauncherHUDSnapshot.isLauncherOwnerName("Spotlight"))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherOwnerName("Spotlight Helper"))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherOwnerName("Finder"))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherOwnerName("Roc Mind Spark"))
        XCTAssertFalse(LauncherHUDSnapshot.isLauncherOwnerName(""))
    }

    func testPIDBundleCacheResolvesEachPidOnceAndDropsGonePids() {
        final class Counter: @unchecked Sendable { var calls: [Int32] = [] }
        let counter = Counter()
        let cache = PIDBundleCache { pid in
            counter.calls.append(pid)
            return pid == 7 ? nil : "bundle.\(pid)"
        }

        let first = cache.lookup(pids: [5, 5, 7, 0])
        XCTAssertEqual(first[5], .some("bundle.5"))
        XCTAssertEqual(first[7], .some(nil))
        XCTAssertNil(first[0])
        XCTAssertEqual(counter.calls, [5, 7])

        _ = cache.lookup(pids: [5, 7])
        XCTAssertEqual(counter.calls, [5, 7], "cached pids, including ones without a bundle id, are not resolved again")

        _ = cache.lookup(pids: [7])
        _ = cache.lookup(pids: [5])
        XCTAssertEqual(counter.calls, [5, 7, 5], "a pid that disappeared is resolved afresh")
    }
}
