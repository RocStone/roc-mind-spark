import Foundation

/// Runs the pre-quit save with a hard deadline. `callAsyncJavaScript` does not
/// observe task cancellation, so a structured task group would still wait for
/// a hung page. This races an unstructured operation against a timer instead;
/// whichever finishes first resumes the caller exactly once.
enum QuitFlush {
    struct TimedOut: LocalizedError {
        var errorDescription: String? { L10n.t("error.saveTimeout") }
    }

    @MainActor
    static func run(
        timeout: Duration,
        _ operation: @escaping @MainActor () async throws -> Void
    ) async throws {
        let gate = Gate()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            gate.continuation = continuation
            let work = Task { @MainActor in
                do {
                    try await operation()
                    gate.finish(.success(()))
                } catch {
                    gate.finish(.failure(error))
                }
            }
            gate.timer = Task { @MainActor in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                work.cancel()
                gate.finish(.failure(TimedOut()))
            }
        }
    }

    @MainActor
    private final class Gate {
        var continuation: CheckedContinuation<Void, Error>?
        var timer: Task<Void, Never>?

        func finish(_ result: Result<Void, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            timer?.cancel()
            timer = nil
            continuation.resume(with: result)
        }
    }
}
