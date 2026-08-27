import Darwin
import Foundation

/// Synchronous stop of the Process we hold. Used by `stopIfLaunched` so
/// `applicationWillTerminate` does not return while the canvas Node is still
/// alive. SIGKILL is only the recorded child PID.
///
/// Worst-case block is `gracefulSeconds + killSeconds` (5 + 1 = 6s).
/// `scripts/installed-app-process.sh` must wait strictly longer than that
/// before SIGKILL of the App, or the shell can kill the App mid-cleanup
/// and orphan the Node child.
enum HeldProcessStop {
    static let gracefulSeconds: TimeInterval = 5
    static let killSeconds: TimeInterval = 1

    static func stop(_ process: Process, recordedPID: Int32?, gracefulSeconds: TimeInterval = gracefulSeconds) {
        switch HeldChildPolicy.begin(pid: recordedPID, isRunning: process.isRunning) {
        case .none:
            return
        case .terminate:
            process.terminate()
        case .forceKill(let pid):
            kill(pid, SIGKILL)
        }
        wait(process, seconds: gracefulSeconds)
        switch HeldChildPolicy.escalate(
            recordedPID: recordedPID,
            stillRunning: process.isRunning,
            currentPID: process.processIdentifier
        ) {
        case .forceKill(let pid):
            kill(pid, SIGKILL)
            wait(process, seconds: killSeconds)
        case .none, .terminate:
            break
        }
    }

    private static func wait(_ process: Process, seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, process.isRunning {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }
}
