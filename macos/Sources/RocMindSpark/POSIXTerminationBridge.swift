import Darwin
import Foundation

/// Coalesces a termination request so SIGTERM and Quit both become one
/// `NSApp.terminate(nil)`. POSIX SIGTERM on an AppKit accessory does not
/// reliably run `applicationWillTerminate` by itself.
struct TerminationOnce: Equatable {
    private(set) var requested = false

    mutating func request() -> Bool {
        guard !requested else { return false }
        requested = true
        return true
    }
}

/// Ignore default SIGTERM, then deliver it on the main queue as a normal
/// AppKit terminate. The DispatchSource must be retained for the process
/// lifetime. Do not call AppKit from a C `signal` handler.
final class POSIXTerminationBridge: @unchecked Sendable {
    private var source: DispatchSourceSignal?
    private var once = TerminationOnce()
    private let onTerminate: @Sendable () -> Void

    init(onTerminate: @escaping @Sendable () -> Void) {
        self.onTerminate = onTerminate
    }

    func install(signal value: Int32 = SIGTERM, queue: DispatchQueue = .main) {
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: queue)
        source.setEventHandler { [weak self] in
            self?.handleSignal()
        }
        source.resume()
        self.source = source
    }

    /// Same path the DispatchSource handler uses. Safe to call from tests.
    func handleSignal() {
        if once.request() {
            onTerminate()
        }
    }
}
