import Foundation

/// Read-only view of who is listening on a TCP port. Never used to decide
/// that a PID is “ours” or to terminate anyone. Ownership is only the
/// `Process` object this app instance created.
enum LoopbackPort {
    static func listenPIDs(port: Int) -> [Int32] {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        proc.arguments = ["-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return []
        }
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return text.split(whereSeparator: \.isNewline).compactMap { Int32($0) }
    }

    static func commandPreview(pid: Int32) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", String(pid), "-www", "-o", "args="]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return ""
        }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

/// Port policy for the canvas server. A PID is never owned because its
/// command line looks like `server.js`. The only child we may stop is the
/// `Process` this instance holds. Every other listener is `portInUse`.
enum CanvasPortPolicy {
    static func foreignOccupants(listenPIDs: [Int32], ourChildPID: Int32?) -> [Int32] {
        guard let ours = ourChildPID else { return listenPIDs }
        return listenPIDs.filter { $0 != ours }
    }
}
