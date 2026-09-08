import AppKit
import WebKit

/// Opt-in tracing of the installed application's own input pipeline. It neither
/// opens another canvas nor replaces map data. Normal launches install no hooks.
@MainActor
final class SelectionDiagnostics {
    static var directory: URL? {
        guard let arg = CommandLine.arguments.first(where: { $0.hasPrefix("--selection-trace=") }) else { return nil }
        let path = String(arg.dropFirst("--selection-trace=".count))
        guard path.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    static var keepVisible: Bool {
        directory != nil && CommandLine.arguments.contains("--selection-trace-keep-visible")
    }

    private let directory: URL
    private let writes = DispatchQueue(label: "com.roc.mindspark.selection-trace", qos: .utility)
    private var monitor: Any?
    private var events: [[String: Any]] = []
    private var dragging = false

    init(window: NSWindow, directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self, weak window] event in
            guard let self, let window, event.window === window else { return event }
            if event.type == .leftMouseDown { self.events = []; self.dragging = true }
            guard self.dragging else { return event }
            if self.events.count < 20_000 {
                self.events.append([
                    "type": event.type.rawValue, "eventUptime": event.timestamp,
                    "receivedUptime": ProcessInfo.processInfo.systemUptime,
                    "receivedEpochMs": Date().timeIntervalSince1970 * 1000,
                    "x": event.locationInWindow.x, "y": event.locationInWindow.y,
                    "windowHeight": window.frame.height,
                    "key": window.isKeyWindow, "appActive": NSApp.isActive
                ])
            }
            if event.type == .leftMouseUp {
                self.dragging = false
                self.write(["kind": "native-gesture", "events": self.events])
                self.events = []
            }
            return event
        }
        write(["kind": "trace-start", "pid": ProcessInfo.processInfo.processIdentifier,
               "epochMs": Date().timeIntervalSince1970 * 1000,
               "uptime": ProcessInfo.processInfo.systemUptime,
               "keepVisible": Self.keepVisible])
    }

    static func userScript() -> WKUserScript? {
        let path = Paths.webRoot.appendingPathComponent("public/selection-diagnostics.js")
        guard let script = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        return WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func recordPage(_ payload: Any) { write(payload) }

    private func write(_ object: Any) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        data.append(0x0A)
        let file = directory.appendingPathComponent("input.jsonl")
        let bytes = data
        writes.async {
            if !FileManager.default.fileExists(atPath: file.path) {
                _ = FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            guard let handle = try? FileHandle(forWritingTo: file) else { return }
            defer { try? handle.close() }
            do { try handle.seekToEnd(); try handle.write(contentsOf: bytes) } catch { }
        }
    }
}
