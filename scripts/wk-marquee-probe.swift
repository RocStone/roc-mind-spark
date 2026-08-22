import AppKit
import Foundation
import WebKit

final class Probe: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let webView: WKWebView
    let url: URL
    var done = false

    init(url: URL) {
        self.url = url
        let rect = NSRect(x: 0, y: 0, width: 800, height: 500)
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
    }

    func start() {
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            webView.evaluateJavaScript("JSON.stringify(window.__PROBE__||null)") { result, error in
                if let error {
                    FileHandle.standardError.write(Data("js error: \(error)\n".utf8))
                    exit(2)
                }
                let text = result as? String ?? "null"
                print(text)
                if let data = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let match = obj["match"] as? Bool, match {
                    exit(0)
                }
                exit(1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write(Data("nav fail: \(error)\n".utf8))
        exit(2)
    }
}

let port = ProcessInfo.processInfo.environment["PORT"] ?? "3034"
guard let url = URL(string: "http://127.0.0.1:\(port)/__wk-marquee.html") else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe(url: url)
probe.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
    FileHandle.standardError.write(Data("timeout\n".utf8))
    exit(3)
}
app.run()
