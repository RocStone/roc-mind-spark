import Foundation

/// Pure boot state for the overlay canvas. OverlayController maps this onto
/// UI and `ServerSupervisor.ensureRunning()`. Duplicate start/retry requests
/// are ignored while a boot is already in flight or the canvas is ready.
struct CanvasBootCoordinator: Equatable {
    enum Phase: Equatable {
        case idle
        case starting
        case failed
        case retrying
        case ready
    }

    private(set) var phase: Phase = .idle

    /// First boot (preload / first Show). True only from `idle`.
    mutating func requestStart() -> Bool {
        guard phase == .idle else { return false }
        phase = .starting
        return true
    }

    /// User tapped Retry after a visible failure. True only from `failed`.
    mutating func requestRetry() -> Bool {
        guard phase == .failed else { return false }
        phase = .retrying
        return true
    }

    mutating func markSucceeded() {
        phase = .ready
    }

    mutating func markFailed() {
        switch phase {
        case .starting, .retrying:
            phase = .failed
        default:
            break
        }
    }

    var showsStatus: Bool {
        switch phase {
        case .starting, .failed, .retrying: return true
        case .idle, .ready: return false
        }
    }

    var showsRetry: Bool { phase == .failed }

    var shouldLoadCanvas: Bool { phase == .ready }
}
