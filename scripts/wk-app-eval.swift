import AppKit
import WebKit
import Carbon

// Run an async acceptance script against the real canvas in WKWebView. The
// caller supplies an isolated server/database; this never opens the user DB.
@MainActor
final class AppEval: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let url: URL
    let script: String
    var window: NSWindow!
    var webView: WKWebView!
    let originalInputSource = TISCopyCurrentKeyboardInputSource().takeRetainedValue()

    init(url: URL, script: String) { self.url = url; self.script = script }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let rect = NSRect(x: 50, y: 80, width: 1100, height: 720)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        if CommandLine.arguments.contains("--native-input") {
            config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "rmsEval")
        }
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        window.contentView = webView
        window.title = "Roc Mind Spark acceptance (isolated data)"
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: url))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any] else { replyHandler(nil, "Invalid command"); return }
        if body["currentInputSource"] as? Bool == true {
            let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
            let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)!
            replyHandler(Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String, nil)
            return
        }
        if let sourceID = body["inputSource"] as? String {
            let sources = TISCreateInputSourceList(nil, false).takeRetainedValue() as! [TISInputSource]
            for source in sources {
                guard let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { continue }
                let id = Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
                if (sourceID == "latin" && id.hasPrefix("com.apple.keylayout.")) || (sourceID == "pinyin" && id.lowercased().contains("pinyin")) {
                    replyHandler(TISSelectInputSource(source) == noErr, nil)
                    return
                }
            }
            replyHandler(false, nil)
            return
        }
        if body["key"] is String, let code = body["code"] as? UInt16 {
            for down in [true, false] {
                CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.postToPid(getpid())
            }
            replyHandler(true, nil)
            return
        }
        replyHandler(nil, "Unknown command")
    }

    func restoreInputSource() {
        if CommandLine.arguments.contains("--native-input") { TISSelectInputSource(originalInputSource) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                let value = try await webView.callAsyncJavaScript(script, arguments: ["nativeInputAcceptance": CommandLine.arguments.contains("--native-input")], in: nil, contentWorld: .page)
                if let text = value as? String { print(text) }
                else { print(String(describing: value)) }
                restoreInputSource()
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("WK acceptance failed: \(error)\n".utf8))
                restoreInputSource()
                exit(1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write(Data("WK navigation failed: \(error)\n".utf8))
        restoreInputSource()
        exit(1)
    }
}

guard (3...4).contains(CommandLine.arguments.count),
      let url = URL(string: CommandLine.arguments[1]),
      let script = try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8) else {
    fatalError("Usage: swift scripts/wk-app-eval.swift URL ASYNC_SCRIPT.js [--native-input]")
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = AppEval(url: url, script: script)
    app.delegate = delegate
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
        delegate.restoreInputSource()
        FileHandle.standardError.write(Data("WK acceptance timeout\n".utf8))
        exit(1)
    }
    withExtendedLifetime(delegate) { app.run() }
}
