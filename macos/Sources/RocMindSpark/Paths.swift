import Foundation

enum AppConfig {
    static let port = 3034
    static let url = URL(string: "http://127.0.0.1:\(port)/")!
    static let bundleId = "com.roc.mindspark"
}

enum Paths {
    static var webRoot: URL {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.isReadableFile(atPath: bundled.appendingPathComponent("server.js").path) {
            return bundled
        }
        // #filePath = <repo>/macos/Sources/RocMindSpark/Paths.swift
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repo.appendingPathComponent("web", isDirectory: true)
    }

    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("RocMindSpark", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// SQLite file for maps. The packaged app writes to Application Support.
    /// Running from the source tree uses `web/data/` so local maps survive rebuilds.
    static var databaseFile: URL {
        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("web", isDirectory: true)
            .appendingPathComponent("server.js"),
           FileManager.default.isReadableFile(atPath: bundled.path) {
            return supportDirectory.appendingPathComponent("mindspark.db")
        }
        let dir = webRoot.appendingPathComponent("data", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("mindspark.db")
    }

    static var serverLogFile: URL {
        supportDirectory.appendingPathComponent("server.log")
    }

    static var opsLogFile: URL {
        supportDirectory.appendingPathComponent("ops.log")
    }

    static func log(_ message: String) {
        append(line: "\(ISO8601DateFormatter().string(from: Date()))  \(message)\n", to: supportDirectory.appendingPathComponent("overlay.log"))
    }

    static func opsLog(_ message: String) {
        append(line: "\(ISO8601DateFormatter().string(from: Date())) \(message)\n", to: opsLogFile)
    }

    private static func append(line: String, to url: URL) {
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: data)
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}
