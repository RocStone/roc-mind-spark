import AppKit

/// Non-activating panel that can sit on top of another app's fullscreen Space
/// without creating or switching Spaces.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = false
        hidesOnDeactivate = false
        level = .statusBar
        // Do not use .transient: macOS hides those panels when they lose key
        // (screenshot UI, ⌘,). We hide from the hotkey, outside clicks, Space
        // changes, and the menu bar.
        collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .ignoresCycle,
        ]
        isOpaque = true
        backgroundColor = NSColor.white
        hasShadow = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        animationBehavior = .none
        isReleasedWhenClosed = false
        isMovable = false
        hidesOnDeactivate = false
        collectionBehavior.insert(.fullScreenDisallowsTiling)
    }
}
