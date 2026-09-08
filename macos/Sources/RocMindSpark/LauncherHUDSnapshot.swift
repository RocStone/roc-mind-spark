import AppKit
import CoreGraphics

/// The small, value-typed result returned by the launcher HUD probe.
///
/// Window-list dictionaries and `NSRunningApplication` objects stay inside
/// `capture()`. Only these immutable values cross back to the main actor.
struct LauncherHUDWindow: Equatable, Sendable {
    let id: UInt32
    let isHud: Bool
    let owner: String
    let layer: Int32
    let width: Double
    let height: Double
    let pid: Int32

    var description: String {
        "\(owner)#\(id) \(Int(width))x\(Int(height)) layer=\(layer) hud=\(isHud)"
    }
}

struct LauncherHUDSnapshot: Equatable, Sendable {
    let windows: [LauncherHUDWindow]

    var huds: [LauncherHUDWindow] {
        windows.filter(\.isHud)
    }

    var topHud: LauncherHUDWindow? {
        huds.max(by: { $0.layer < $1.layer })
    }

    /// Runs the expensive window and process queries synchronously on the
    /// caller's executor. The caller owns moving this operation off the main
    /// actor and receives only the Sendable value above.
    static func capture(overlayBundleId: String) -> LauncherHUDSnapshot {
        let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
        let infos = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
        let statusLevel = Int32(CGWindowLevelForKey(.statusWindow))

        let windows = infos.compactMap { info -> LauncherHUDWindow? in
            let name = (info[kCGWindowOwnerName as String] as? String) ?? ""
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let bundle = pid > 0
                ? NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier
                : nil
            guard bundle != overlayBundleId,
                  isLauncherHudOwner(name: name, bundleId: bundle),
                  let number = info[kCGWindowNumber as String] as? NSNumber
            else { return nil }

            let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            let width = (bounds?["Width"] as? NSNumber)?.doubleValue ?? 0
            let height = (bounds?["Height"] as? NSNumber)?.doubleValue ?? 0
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.int32Value ?? 0
            var isHud = isLauncherHudMetrics(width: width, height: height, alpha: alpha)

            // When Screen Recording is disabled macOS can redact the bounds.
            // Menu extras remain at status-window level; the search HUD is
            // lower (floating / overlay), so retain the existing fallback.
            if !isHud, alpha >= 0.05, width <= 0 || height <= 0, layer < statusLevel {
                isHud = true
            }

            return LauncherHUDWindow(
                id: number.uint32Value,
                isHud: isHud,
                owner: name,
                layer: layer,
                width: width,
                height: height,
                pid: pid
            )
        }
        return LauncherHUDSnapshot(windows: windows)
    }

    static func isLauncherHudOwner(name: String, bundleId: String?) -> Bool {
        if let bundleId {
            let id = bundleId.lowercased()
            if id == "com.raycast.macos" { return true }
            if id.contains("alfred") { return true }
            if id == "com.apple.spotlight" { return true }
        }
        let owner = name.lowercased()
        if owner.contains("raycast") { return true }
        if owner.contains("alfred") { return true }
        if owner == "spotlight" { return true }
        return false
    }

    /// Menu extras are tiny. The search HUD is a wide bar / results list.
    static func isLauncherHudMetrics(width: Double, height: Double, alpha: Double) -> Bool {
        if alpha < 0.05 { return false }
        if width <= 0 || height <= 0 { return false }
        return width >= 280 && height >= 48
    }
}

/// Main-actor state for one periodic HUD watcher.
///
/// A finished probe keeps its slot until its result callback returns to the
/// main actor. That makes the one-in-flight guarantee hold across hide/show:
/// canceling a task cannot start a second native query while the first native
/// call is still unwinding.
struct LauncherHUDWatchState: Equatable, Sendable {
    struct Probe: Equatable, Sendable {
        let generation: UInt64
        let token: UInt64
    }

    private(set) var displayGeneration: UInt64 = 0
    private(set) var inFlight: Probe?
    private var nextToken: UInt64 = 0

    mutating func activateDisplay() {
        displayGeneration &+= 1
    }

    mutating func invalidateDisplay() {
        displayGeneration &+= 1
    }

    mutating func beginProbeIfIdle() -> Probe? {
        guard inFlight == nil else { return nil }
        nextToken &+= 1
        let probe = Probe(generation: displayGeneration, token: nextToken)
        inFlight = probe
        return probe
    }

    /// Returns whether the probe belongs to the currently displayed overlay.
    /// The in-flight slot is released only for the matching probe token.
    mutating func finish(_ probe: Probe) -> Bool {
        guard inFlight == probe else { return false }
        inFlight = nil
        return probe.generation == displayGeneration
    }
}
