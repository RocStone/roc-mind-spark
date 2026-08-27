import Foundation

/// What to do with the one Process this instance started. Never derived from
/// lsof, a port, or a server.js path. A PID we did not record is never killed.
enum HeldChildPolicy {
    enum Action: Equatable {
        case none
        case terminate(Int32)
        case forceKill(Int32)
    }

    static func begin(pid: Int32?, isRunning: Bool) -> Action {
        guard let pid, isRunning else { return .none }
        return .terminate(pid)
    }

    /// After a graceful wait. Force-kill only if the Process is still the
    /// child PID recorded at launch.
    static func escalate(recordedPID: Int32?, stillRunning: Bool, currentPID: Int32?) -> Action {
        guard let recordedPID, stillRunning, currentPID == recordedPID else { return .none }
        return .forceKill(recordedPID)
    }
}
