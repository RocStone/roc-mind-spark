import Foundation

enum AppConfig {
    static let port = 3034
    static let url = URL(string: "http://127.0.0.1:\(port)/")!
    static let bundleId = "com.roc.mindspark"
    static let product = "roc-mind-spark"
    static let productEnv = "ROC_MINDSPARK_PRODUCT"
    static let tokenEnv = "ROC_MINDSPARK_TOKEN"
}

enum Paths {
    static var serverJSFile: URL {
        webRoot.appendingPathComponent("server.js")
    }

    static var webRoot: URL {
        if let bundled = bundleWebRoot() {
            return bundled
        }
        if let override = ProcessInfo.processInfo.environment["ROC_MINDSPARK_WEB_ROOT"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        #if DEBUG
        return sourceTreeWebRoot()
        #else
        return Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        #endif
    }

    private static func bundleWebRoot() -> URL? {
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
              FileManager.default.isReadableFile(atPath: bundled.appendingPathComponent("server.js").path) else {
            return nil
        }
        return bundled
    }

    #if DEBUG
    /// Source-tree fallback for `swift run` / Xcode debug. `#filePath` must
    /// not appear in a release binary.
    private static func sourceTreeWebRoot() -> URL {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repo.appendingPathComponent("web", isDirectory: true)
    }
    #endif

    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("RocMindSpark", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// SQLite file for maps. The packaged app writes to Application Support.
    /// Debug runs from the source tree keep `web/data/` so local maps survive rebuilds.
    static var databaseFile: URL {
        if bundleWebRoot() != nil {
            return supportDirectory.appendingPathComponent("mindspark.db")
        }
        #if DEBUG
        let dir = webRoot.appendingPathComponent("data", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("mindspark.db")
        #else
        return supportDirectory.appendingPathComponent("mindspark.db")
        #endif
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
        _ = try? handle.write(contentsOf: data)
    }
}
