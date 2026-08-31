import AppKit
import Foundation
import WebKit

/// Posts real NSEvents into a visible WKWebView and reads JS selection lag.
/// WKWebView must be created AFTER applicationDidFinishLaunching or WebContent XPC deadlocks.
final class Eval: NSObject, WKNavigationDelegate {
    let url: URL
    let overlay: Bool
    var window: NSWindow!
    var webView: WKWebView!
    var loaded = false
    var loadError: String?

    init(url: URL, overlay: Bool) {
        self.url = url
        self.overlay = overlay
        super.init()
    }

    func attach() {
        let rect = NSRect(x: 80, y: 80, width: 900, height: 560)
        if overlay {
            let panel = NSPanel(
                contentRect: rect,
                styleMask: [.nonactivatingPanel, .titled, .closable],
                backing: .buffered,
                defer: false
            )
            panel.isFloatingPanel = true
            panel.becomesKeyOnlyIfNeeded = false
            panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.modalPanelWindow)) - 1)
            window = panel
        } else {
            window = NSWindow(
                contentRect: rect,
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
        }
        window.title = overlay ? "md-select-eval overlay" : "md-select-eval"
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(origin: .zero, size: rect.size), configuration: config)
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        window.makeKey()
        window.makeFirstResponder(webView)
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadError = "nav fail: \(error)"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadError = "prov fail: \(error)"
    }

    func spin(_ seconds: Double) {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(seconds))
    }

    func js(_ script: String, done: @escaping (Any?) -> Void) {
        webView.evaluateJavaScript(script) { result, error in
            if let error {
                FileHandle.standardError.write(Data("js error: \(error)\n".utf8))
                done(nil)
                return
            }
            done(result)
        }
    }

    func waitLoaded(done: @escaping () -> Void) {
        var tries = 0
        func tick() {
            if self.loaded {
                done()
                return
            }
            if let loadError {
                FileHandle.standardError.write(Data("\(loadError)\n".utf8))
                exit(2)
            }
            tries += 1
            if tries > 100 {
                FileHandle.standardError.write(Data("load timeout\n".utf8))
                exit(3)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { tick() }
        }
        tick()
    }

    func waitReady(done: @escaping () -> Void) {
        var tries = 0
        func tick() {
            tries += 1
            js("window.__EVAL_READY===true") { result in
                if (result as? Bool) == true {
                    done()
                    return
                }
                if tries > 40 {
                    FileHandle.standardError.write(Data("eval js not ready\n".utf8))
                    exit(3)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { tick() }
            }
        }
        tick()
    }

    func windowPoint(clientX: Double, clientY: Double) -> NSPoint {
        let h = webView.bounds.height
        let viewPt = NSPoint(x: clientX, y: h - clientY)
        return webView.convert(viewPt, to: nil)
    }

    func post(_ type: NSEvent.EventType, at p: NSPoint) {
        guard let e = NSEvent.mouseEvent(
            with: type,
            location: p,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: Int.random(in: 1...10_000_000),
            clickCount: 1,
            pressure: 1
        ) else { return }
        window.postEvent(e, atStart: false)
    }

    func drag(left: Double, top: Double, width: Double, height: Double, done: @escaping () -> Void) {
        let x0 = left + 24
        let y0 = top + 28
        let x1 = left + min(width - 24, 360)
        let y1 = top + min(height - 24, 280)
        let steps = 40
        post(.leftMouseDown, at: windowPoint(clientX: x0, clientY: y0))
        var i = 0
        func step() {
            i += 1
            if i > steps {
                self.post(.leftMouseUp, at: self.windowPoint(clientX: x1, clientY: y1))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { done() }
                return
            }
            let t = Double(i) / Double(steps)
            self.post(.leftMouseDragged, at: self.windowPoint(clientX: x0 + (x1 - x0) * t, clientY: y0 + (y1 - y0) * t))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.004) { step() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { step() }
    }

    func jsonString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s])
        let wrapped = String(data: data, encoding: .utf8)!
        return String(wrapped.dropFirst().dropLast())
    }

    func dict(_ raw: Any?) -> [String: Any]? {
        if let s = raw as? String, let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return obj
        }
        return raw as? [String: Any]
    }

    func runCase(_ name: String, done: @escaping ([String: Any]) -> Void) {
        js("JSON.stringify(window.__EVAL.setup(\(jsonString(name))))") { raw in
            guard let info = self.dict(raw),
                  let left = info["left"] as? Double,
                  let top = info["top"] as? Double,
                  let width = info["width"] as? Double,
                  let height = info["height"] as? Double else {
                done(["name": name, "error": "no box", "raw": String(describing: raw)])
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                self.drag(left: left, top: top, width: width, height: height) {
                    self.js("JSON.stringify(Object.assign({name:\(self.jsonString(name))}, window.__EVAL.summarize()))") { sum in
                        done(self.dict(sum) ?? ["name": name, "error": "no summary", "raw": String(describing: sum)])
                    }
                }
            }
        }
    }

    func run(names: [String], acc: [[String: Any]], done: @escaping ([[String: Any]]) -> Void) {
        if names.isEmpty {
            done(acc)
            return
        }
        var rest = names
        let name = rest.removeFirst()
        runCase(name) { row in
            var next = acc
            next.append(row)
            self.run(names: rest, acc: next, done: done)
        }
    }

    func go() {
        waitLoaded {
            self.waitReady {
                self.js("JSON.stringify(window.__EVAL.names)") { raw in
                    var names: [String] = []
                    if let s = raw as? String, let data = s.data(using: .utf8),
                       let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
                        names = arr
                    }
                    self.run(names: names, acc: []) { rows in
                        let payload: [String: Any] = [
                            "env": self.overlay ? "overlay-panel" : "regular-window",
                            "metric": "rAF selection-end rect vs last mouse, plus selectionchange count",
                            "cases": rows
                        ]
                        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
                           let text = String(data: data, encoding: .utf8) {
                            print(text)
                        }
                        exit(0)
                    }
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let eval: Eval
    init(eval: Eval) { self.eval = eval }
    func applicationDidFinishLaunching(_ notification: Notification) {
        eval.attach()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.eval.go()
        }
    }
}

var overlay = false
var path = FileManager.default.currentDirectoryPath + "/scripts/md-select-eval.html"
for arg in CommandLine.arguments.dropFirst() {
    if arg == "--overlay" { overlay = true }
    else { path = arg }
}
let url = URL(fileURLWithPath: path)
let app = NSApplication.shared
app.setActivationPolicy(overlay ? .accessory : .regular)
let eval = Eval(url: url, overlay: overlay)
let delegate = AppDelegate(eval: eval)
app.delegate = delegate
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    FileHandle.standardError.write(Data("timeout\n".utf8))
    exit(3)
}
withExtendedLifetime(delegate) {
    app.run()
}
