import AppKit
import CoreGraphics

/// Non-activating panel that can sit on top of another app's fullscreen Space
/// without creating or switching Spaces.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // A high polling-rate mouse can outpace WKWebView's cross-process input
    // delivery. Keep the newest position before entering WebKit, at 120 Hz.
    // Dispatch at the window boundary: WebKit's internal hit-test view receives
    // mouse events, so overriding WKWebView.mouseDragged is insufficient.
    private var pendingDrag: NSEvent?
    private var dragTimer: Timer?
    private var lastDragDispatch = -Double.infinity
    private let dragInterval = 1.0 / 120.0

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDragged {
            pendingDrag = event
            let remaining = dragInterval - (ProcessInfo.processInfo.systemUptime - lastDragDispatch)
            if remaining <= 0 {
                flushPendingDrag()
            } else if dragTimer == nil {
                let timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.flushPendingDrag() }
                }
                dragTimer = timer
                RunLoop.main.add(timer, forMode: .common)
            }
            return
        }
        // Preserve order across mouse-up, keyboard/modifier changes and other
        // input. In particular, deliver the final position before releasing.
        flushPendingDrag()
        if event.type == .leftMouseDown || event.type == .leftMouseUp {
            lastDragDispatch = -Double.infinity
        }
        super.sendEvent(event)
    }

    private func flushPendingDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        guard let event = pendingDrag else { return }
        pendingDrag = nil
        lastDragDispatch = ProcessInfo.processInfo.systemUptime
        super.sendEvent(event)
    }

    func cancelPendingDrag() {
        dragTimer?.invalidate()
        dragTimer = nil
        pendingDrag = nil
        lastDragDispatch = -Double.infinity
    }

    override func resignKey() {
        cancelPendingDrag()
        super.resignKey()
    }

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
        // Cover normal / floating windows. Raycast's search HUD is a
        // modal-panel (layer 8); sitting at mainMenu (24) painted over it.
        level = Self.coverLevel
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

    /// Just under `modalPanel` (8). High enough to cover other apps, low
    /// enough that Raycast / Alfred / Spotlight HUDs stack above us.
    static var coverLevel: NSWindow.Level {
        NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.modalPanelWindow)) - 1)
    }

    /// Drop under a HUD that is at or below `coverLevel` without going
    /// under normal app windows.
    static func level(belowHudLayer hudLayer: Int) -> NSWindow.Level {
        let floor = Int(CGWindowLevelForKey(.normalWindow))
        let raw = min(coverLevel.rawValue, max(floor, hudLayer - 1))
        return NSWindow.Level(rawValue: raw)
    }

    func applyCoverLevel() {
        level = Self.coverLevel
        collectionBehavior.insert(.fullScreenAuxiliary)
    }

    func duck(belowHudLayer hudLayer: Int, windowNumber: Int) {
        level = Self.level(belowHudLayer: hudLayer)
        // fullScreenAuxiliary can still cover a higher-level HUD on a
        // fullscreen Space; drop it only while the HUD is up.
        collectionBehavior.remove(.fullScreenAuxiliary)
        if windowNumber != 0 {
            order(.below, relativeTo: windowNumber)
        }
    }
}
