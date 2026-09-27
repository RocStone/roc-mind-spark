import AppKit
import Foundation
import WebKit

final class Probe: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let webView: WKWebView
    let url: URL
    var tries = 0

    init(url: URL) {
        self.url = url
        let rect = NSRect(x: 0, y: 0, width: 900, height: 700)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: rect, configuration: config)
        super.init()
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    func start() {
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    func poll() {
        tries += 1
        webView.evaluateJavaScript("window.__PROBE__?JSON.stringify(window.__PROBE__):null") { result, error in
            if let error {
                FileHandle.standardError.write(Data("js error: \(error)\n".utf8))
                exit(2)
            }
            if let text = result as? String, text != "null" {
                print(text)
                exit(0)
            }
            if self.tries > 80 {
                FileHandle.standardError.write(Data("no probe result\n".utf8))
                exit(3)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.poll() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.poll() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write(Data("nav fail: \(error)\n".utf8))
        exit(2)
    }
}

let path = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : FileManager.default.currentDirectoryPath + "/web/public/__wk-select.html"
let url = URL(fileURLWithPath: path)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe(url: url)
probe.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    FileHandle.standardError.write(Data("timeout\n".utf8))
    exit(3)
}
app.run()
