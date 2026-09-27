import Foundation

struct NodeVersion: Comparable, Sendable, CustomStringConvertible {
    let major: Int
    let minor: Int
    let patch: Int

    static let minimum = NodeVersion(major: 22, minor: 13, patch: 0)

    /// Accepts `22.13.1`, `v22.13.1`, and trailing whitespace from `node -p`.
    init?(_ raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("v") || text.hasPrefix("V") { text.removeFirst() }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2, parts.count <= 3 else { return nil }
        let numbers = parts.map { part in Int(part.prefix { $0.isNumber }) }
        guard let major = numbers[0], let minor = numbers[1] else { return nil }
        let patch = parts.count == 3 ? numbers[2] : 0
        guard let patch else { return nil }
        self.init(major: major, minor: minor, patch: patch)
    }

    init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    static func < (a: NodeVersion, b: NodeVersion) -> Bool {
        (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }

    var description: String { "\(major).\(minor).\(patch)" }
}

/// Finds a Node.js binary new enough for `server.js`. Blocking: call it off
/// the main actor.
enum NodeLocator {
    struct TooOld: Error {
        let version: String
        let path: String
    }

    static func find() throws -> URL {
        var tooOld: TooOld?
        var seen = Set<String>()
        for path in candidatePaths() {
            let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            guard FileManager.default.isExecutableFile(atPath: path), seen.insert(resolved).inserted else { continue }
            guard let raw = probeVersion(path) else {
                Paths.log("node candidate \(path): version probe failed")
                continue
            }
            if let version = NodeVersion(raw), version >= .minimum {
                Paths.log("node \(path) v\(version)")
                return URL(fileURLWithPath: path)
            }
            Paths.log("node candidate \(path) too old: \(raw)")
            if tooOld == nil { tooOld = TooOld(version: raw, path: path) }
        }
        if let tooOld { throw ServerError.nodeTooOld(version: tooOld.version, path: tooOld.path) }
        throw ServerError.nodeNotFound
    }

    static func candidatePaths() -> [String] {
        let home = NSHomeDirectory()
        var paths: [String] = []
        if let fromEnv = ProcessInfo.processInfo.environment["ROC_MINDSPARK_NODE"], !fromEnv.isEmpty {
            paths.append(fromEnv)
        }
        if let nvm = newestVersionDirectory(in: "\(home)/.nvm/versions/node") {
            paths.append("\(nvm)/bin/node")
        }
        paths += [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "/usr/local/bin/node",
            "/usr/local/opt/node@22/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.fnm/current/bin/node",
            "\(home)/.proto/shims/node",
        ]
        if let which = whichNode() { paths.append(which) }
        return paths
    }

    /// `~/.nvm/versions/node/v22.13.1` style directories; highest version wins.
    static func newestVersionDirectory(in directory: String) -> String? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return nil }
        return newestVersionName(names).map { "\(directory)/\($0)" }
    }

    static func newestVersionName(_ names: [String]) -> String? {
        names.compactMap { name in NodeVersion(name).map { (name, $0) } }
            .max { $0.1 < $1.1 }?.0
    }

    /// `node -p process.versions.node`, killed after `timeout` seconds.
    static func probeVersion(_ path: String, timeout: TimeInterval = 3) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = ["-p", "process.versions.node"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in done.signal() }
        do { try proc.run() } catch { return nil }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            return nil
        }
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private static func whichNode() -> String? {
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(env["PATH"] ?? "")"
        which.environment = env
        do { try which.run() } catch { return nil }
        which.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let found = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return found.isEmpty ? nil : found
    }
}
