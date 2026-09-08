import AppKit
import WebKit

// Run an async acceptance script against the real canvas in WKWebView. The
// caller supplies an isolated server/database; this never opens the user DB.
@MainActor
final class AppEval: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let url: URL
    let script: String
    var window: NSWindow!
    var webView: WKWebView!

    init(url: URL, script: String) { self.url = url; self.script = script }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rect = NSRect(x: 50, y: 80, width: 1100, height: 720)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        window.contentView = webView
        window.title = "Roc Mind Spark acceptance (isolated data)"
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                let value = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
                if let text = value as? String { print(text) }
                else { print(String(describing: value)) }
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("WK acceptance failed: \(error)\n".utf8))
                exit(1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write(Data("WK navigation failed: \(error)\n".utf8))
        exit(1)
    }
}

guard CommandLine.arguments.count == 3,
      let url = URL(string: CommandLine.arguments[1]),
      let script = try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) else {
    fatalError("Usage: swift scripts/wk-app-eval.swift URL ASYNC_SCRIPT.js")
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = AppEval(url: url, script: script)
    app.delegate = delegate
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
        FileHandle.standardError.write(Data("WK acceptance timeout\n".utf8))
        exit(1)
    }
    withExtendedLifetime(delegate) { app.run() }
}
