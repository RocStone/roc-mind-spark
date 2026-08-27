import Foundation

/// Starts the bundled Node canvas server on 127.0.0.1. The only Node process
/// this type may terminate is the `Process` it created. A PID already bound
/// to the port — including another app instance or a hand-started `server.js`
/// with the same path — is `portInUse`. Never scanned, never killed.
@MainActor
final class ServerSupervisor {
    private var process: Process?
    /// PID recorded when our Process started. Force-kill uses this, never lsof.
    private var heldChildPID: Int32?
    private var didLaunch = false
    /// Confirms the child we just started is the one answering /healthz.
    /// Not an API credential.
    private var launchToken: String?

    func ensureRunning() async throws {
        if didLaunch, let process, process.isRunning, await healthMatchesOurChild() {
            return
        }
        if didLaunch {
            try await stopOurChildAndWaitForPort()
        }

        if let first = CanvasPortPolicy.foreignOccupants(
            listenPIDs: LoopbackPort.listenPIDs(port: AppConfig.port),
            ourChildPID: nil
        ).first {
            throw ServerError.portInUse(pid: first, command: LoopbackPort.commandPreview(pid: first))
        }

        try start()
        let waitUntil = Date().addingTimeInterval(8)
        while Date() < waitUntil {
            if let process, !process.isRunning {
                throw ServerError.didNotBecomeHealthy
            }
            if await healthMatchesOurChild() { return }
            try await Task.sleep(nanoseconds: 80_000_000)
        }
        throw ServerError.didNotBecomeHealthy
    }

    func stopIfLaunched() {
        stopHeldChild()
    }

    /// Block until the held child is gone, then drop the reference.
    private func stopHeldChild() {
        if let child = process {
            HeldProcessStop.stop(child, recordedPID: heldChildPID)
        }
        process = nil
        heldChildPID = nil
        didLaunch = false
        launchToken = nil
    }

    /// Stop the held Process (same path as `stopIfLaunched`), then wait until
    /// the port is free. A still-exiting child is not treated as foreign.
    /// Anyone else on the port is portInUse — we do not kill them.
    private func stopOurChildAndWaitForPort() async throws {
        guard let child = process else {
            didLaunch = false
            launchToken = nil
            return
        }
        let childPID = heldChildPID ?? child.processIdentifier
        stopHeldChild()

        let portDeadline = Date().addingTimeInterval(2)
        while Date() < portDeadline {
            let listening = LoopbackPort.listenPIDs(port: AppConfig.port)
            if listening.isEmpty { return }
            let foreign = CanvasPortPolicy.foreignOccupants(listenPIDs: listening, ourChildPID: childPID)
            if let first = foreign.first {
                throw ServerError.portInUse(pid: first, command: LoopbackPort.commandPreview(pid: first))
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let leftover = CanvasPortPolicy.foreignOccupants(
            listenPIDs: LoopbackPort.listenPIDs(port: AppConfig.port),
            ourChildPID: childPID
        )
        if let first = leftover.first {
            throw ServerError.portInUse(pid: first, command: LoopbackPort.commandPreview(pid: first))
        }
        throw ServerError.didNotBecomeHealthy
    }

    private func start() throws {
        let node = try Self.findNode()
        let web = Paths.webRoot
        let server = Paths.serverJSFile
        guard FileManager.default.isReadableFile(atPath: server.path) else {
            throw ServerError.missingServer(server.path)
        }

        let token = UUID().uuidString
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(AppConfig.port)
        env["DB_PATH"] = Paths.databaseFile.path
        env["PUBLIC"] = web.appendingPathComponent("public").path
        env["OPS_LOG_PATH"] = Paths.opsLogFile.path
        env[AppConfig.productEnv] = AppConfig.product
        env[AppConfig.tokenEnv] = token

        let proc = Process()
        proc.executableURL = node
        proc.arguments = ["--disable-warning=ExperimentalWarning", server.path]
        proc.currentDirectoryURL = web
        proc.environment = env
        let logURL = try touch(Paths.serverLogFile)
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()
        proc.standardOutput = log
        proc.standardError = log
        try proc.run()
        process = proc
        heldChildPID = proc.processIdentifier
        didLaunch = true
        launchToken = token
    }

    private func healthMatchesOurChild() async -> Bool {
        guard let token = launchToken, let process, process.isRunning else { return false }
        var req = URLRequest(url: AppConfig.url.appending(path: "healthz"))
        req.timeoutInterval = 0.2
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            guard body["ok"] as? Bool == true else { return false }
            guard body["product"] as? String == AppConfig.product else { return false }
            return body["token"] as? String == token
        } catch {
            return false
        }
    }

    private func touch(_ url: URL) throws -> URL {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        return url
    }

    private static func findNode() throws -> URL {
        if let fromEnv = ProcessInfo.processInfo.environment["ROC_MINDSPARK_NODE"] {
            let url = URL(fileURLWithPath: fromEnv)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        let extras = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(NSHomeDirectory())/.volta/bin/node",
            "\(NSHomeDirectory())/.fnm/current/bin/node",
            "\(NSHomeDirectory())/.proto/shims/node",
        ]
        for path in extras where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        let path = env["PATH"] ?? ""
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(path)"
        which.environment = env
        try which.run()
        which.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let found = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !found.isEmpty, FileManager.default.isExecutableFile(atPath: found) {
            return URL(fileURLWithPath: found)
        }
        throw ServerError.nodeNotFound
    }
}

enum ServerError: LocalizedError {
    case nodeNotFound
    case missingServer(String)
    case didNotBecomeHealthy
    case portInUse(pid: Int32, command: String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return L10n.t("error.node")
        case .missingServer(let path):
            return String(format: L10n.t("error.server"), path)
        case .didNotBecomeHealthy:
            return String(format: L10n.t("error.timeout"), Paths.serverLogFile.path)
        case .portInUse(let pid, let command):
            let clip = command.count > 120 ? String(command.prefix(120)) + "…" : command
            return String(format: L10n.t("error.port"), AppConfig.port, Int(pid), clip)
        }
    }
}
