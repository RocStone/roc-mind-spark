import XCTest
@testable import RocMindSpark

final class ShortcutRejectionTests: XCTestCase {
    func testReservedToggleChords() {
        XCTAssertEqual(ShortcutStore.rejection(for: .optionShiftCommandQ, id: .toggleOverlay), .reserved)
        XCTAssertEqual(ShortcutStore.rejection(for: .commandComma, id: .toggleOverlay), .reserved)
    }

    func testDefaultToggleIsAccepted() {
        XCTAssertNil(ShortcutStore.rejection(for: .hyperQ, id: .toggleOverlay))
        XCTAssertNil(ShortcutStore.rejection(for: ShortcutID.toggleOverlay.defaultChord, id: .toggleOverlay))
    }

    func testGlobalNeedsModifier() {
        XCTAssertEqual(ShortcutStore.rejection(for: .letterL, id: .toggleOverlay), .needsModifier)
    }

    func testCanvasShortcutsAreNotRestricted() {
        XCTAssertNil(ShortcutStore.rejection(for: .letterL, id: .link))
        XCTAssertNil(ShortcutStore.rejection(for: .commandComma, id: .openSettings))
    }
}
