import Darwin
import Foundation

/// Starts the existing Node server (same `server.js` + `public/`) if nothing
/// is already answering on the port. Reuses a live instance so the old Chrome
/// App and this overlay can share one process during the transition.
@MainActor
final class ServerSupervisor {
    private var process: Process?
    private var didLaunch = false

    func ensureRunning() async throws {
        if await healthOK(), didLaunch { return }
        if await healthOK() {
            // A leftover process on this port may still be bound to the empty
            // Application Support db from the first install. Replace it.
            Self.stopListener()
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        try start()
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if await healthOK() { return }
            try await Task.sleep(nanoseconds: 80_000_000)
        }
        throw ServerError.didNotBecomeHealthy
    }

    func stopIfLaunched() {
        if let process, process.isRunning { process.terminate() }
        self.process = nil
        didLaunch = false
    }

    private static func stopListener() {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-tiTCP:\(AppConfig.port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for pid in text.split(whereSeparator: \.isNewline) {
            if let value = Int32(pid) {
                kill(value, SIGTERM)
            }
        }
    }

    private func start() throws {
        let node = try Self.findNode()
        let web = Paths.webRoot
        let server = web.appendingPathComponent("server.js")
        guard FileManager.default.isReadableFile(atPath: server.path) else {
            throw ServerError.missingServer(server.path)
        }

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(AppConfig.port)
        env["DB_PATH"] = Paths.databaseFile.path
        env["PUBLIC"] = web.appendingPathComponent("public").path
        env["OPS_LOG_PATH"] = Paths.opsLogFile.path

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
        didLaunch = true
    }

    private func healthOK() async -> Bool {
        var req = URLRequest(url: AppConfig.url.appending(path: "healthz"))
        req.timeoutInterval = 0.12
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            return (response as? HTTPURLResponse)?.statusCode == 200
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

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return L10n.t("error.node")
        case .missingServer(let path):
            return String(format: L10n.t("error.server"), path)
        case .didNotBecomeHealthy:
            return String(format: L10n.t("error.timeout"), Paths.serverLogFile.path)
        }
    }
}
