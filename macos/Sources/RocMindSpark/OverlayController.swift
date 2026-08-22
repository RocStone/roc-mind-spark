import AppKit
import WebKit

@MainActor
final class OverlayController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let panel = OverlayPanel()
    private var webView: WKWebView!
    private let server: ServerSupervisor
    private var clickMonitor: Any?
    private var didStartLoad = false
    private var isWarm = false
    private var pendingShow = false
    private var parkedSize: CGSize = .zero
    private var keepAlive: NSObjectProtocol?
    private var previousApp: NSRunningApplication?

    private(set) var isVisible = false

    init(server: ServerSupervisor) {
        self.server = server
        super.init()
        let root = NSView(frame: .zero)
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.white.cgColor
        panel.contentView = root
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(spaceChanged),
            name: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil
        )
    }

    /// Must run after `applicationDidFinishLaunching` returns. Creating a
    /// WKWebView on that first turn deadlocks the WebContent XPC.
    func attachWebView() {
        if webView != nil { return }
        Paths.log("attachWebView")
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .default()
        config.userContentController.addUserScript(Self.shortcutScript())
        config.userContentController.addUserScript(Self.readyScript())
        config.userContentController.addUserScript(Self.readyWatchScript())
        config.userContentController.add(self, name: "rmsReady")
        config.userContentController.add(self, name: "rmsNative")
        let wv = MapWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsMagnification = false
        wv.allowsLinkPreview = false
        wv.translatesAutoresizingMaskIntoConstraints = false
        let root = panel.contentView ?? NSView()
        root.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            wv.topAnchor.constraint(equalTo: root.topAnchor),
            wv.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        webView = wv
        Paths.log("webview attached")
    }

    func preload() {
        if keepAlive == nil {
            keepAlive = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleSystemSleepDisabled],
                reason: "Keep the mind map painted while the overlay is parked"
            )
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.server.ensureRunning()
            } catch {
                Paths.log("preload server failed: \(error.localizedDescription)")
                return
            }
            await self.purgeStaleWebCache()
            self.startLoadIfNeeded()
            if !self.isVisible { self.parkOffscreen() }
        }
    }

    func toggle() {
        Paths.log("toggle visible=\(isVisible) warm=\(isWarm)")
        if isVisible { hide() } else { show() }
    }

    func show() {
        Paths.opsLog("overlay-show")
        if !didStartLoad {
            startLoadIfNeeded()
            Task { try? await server.ensureRunning() }
        }
        presentNow()
    }

    func hide() {
        if isVisible { Paths.opsLog("overlay-hide") }
        pendingShow = false
        guard isVisible else {
            parkOffscreen()
            return
        }
        removeClickMonitor()
        isVisible = false
        parkOffscreen()
        let restore = previousApp
        previousApp = nil
        if let restore, restore.bundleIdentifier != AppConfig.bundleId {
            restore.activate()
        }
    }

    func applyShortcuts() {
        guard webView != nil else { return }
        let json = ShortcutStore.shared.webJSON()
        webView.evaluateJavaScript("window.__RMS_SHORTCUTS__=\(json);") { _, error in
            if let error { Paths.log("applyShortcuts js error \(error)") }
        }
        pushNativeState()
    }

    func openInAppSettings() {
        guard webView != nil else { return }
        pushNativeState()
        webView.evaluateJavaScript("window.rmsOpenSettings&&window.rmsOpenSettings()") { _, error in
            if let error { Paths.log("openInAppSettings \(error)") }
        }
    }

    func pushNativeState() {
        guard webView != nil else { return }
        let toggle = ShortcutStore.shared.chord(for: .toggleOverlay)
        let login = LoginItem.isEnabled
        let payload: [String: Any] = [
            "toggleDisplay": toggle.display,
            "toggle": toggle.webSpec,
            "login": login,
            "language": AppLanguage.current.rawValue,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__rmsNativeState&&window.__rmsNativeState(\(json))")
    }

    /// WKWebView's default data store keeps disk cache across launches.
    /// That pinned overlay users to a stale styles.css so a rebuilt app
    /// still showed the closed search-wrap sliver. Keep localStorage.
    private func purgeStaleWebCache() async {
        let keep: Set<String> = [
            WKWebsiteDataTypeLocalStorage,
            WKWebsiteDataTypeSessionStorage,
            WKWebsiteDataTypeCookies,
            WKWebsiteDataTypeIndexedDBDatabases,
        ]
        let types = WKWebsiteDataStore.allWebsiteDataTypes().subtracting(keep)
        await WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast)
        Paths.log("purged webview cache")
    }

    private func startLoadIfNeeded() {
        guard webView != nil, !didStartLoad else { return }
        didStartLoad = true
        Paths.log("webview load \(AppConfig.url)")
        var comps = URLComponents(url: AppConfig.url, resolvingAgainstBaseURL: false) ?? URLComponents()
        var items = comps.queryItems ?? []
        items.append(URLQueryItem(name: "v", value: String(Int(Date().timeIntervalSince1970))))
        comps.queryItems = items
        var req = URLRequest(url: comps.url ?? AppConfig.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        webView.load(req)
    }

    /// Keep the live, fully painted window. Moving it off-screen (instead of
    /// orderOut / alpha 0) is what makes the next show a setFrame, not a first paint.
    private func parkOffscreen() {
        let screen = Self.targetScreen()
        let size = screen.visibleFrame.size
        parkedSize = size
        let parked = NSRect(x: -20000, y: -20000, width: size.width, height: size.height)
        panel.alphaValue = 1
        panel.ignoresMouseEvents = true
        panel.setFrame(parked, display: true)
        panel.orderFrontRegardless()
        Paths.log("parked offscreen \(size)")
    }

    private func markWarm() {
        guard !isWarm else {
            if pendingShow { presentNow() }
            return
        }
        // Force a backing-store raster so the first on-screen frame is not empty.
        let cfg = WKSnapshotConfiguration()
        cfg.rect = webView.bounds
        webView.takeSnapshot(with: cfg) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isWarm = true
                Paths.log("webview warm ready")
                if self.pendingShow { self.presentNow() }
            }
        }
    }

    private func presentNow() {
        pendingShow = false
        let screen = Self.targetScreen()
        var frame = screen.visibleFrame
        if parkedSize == frame.size {
            // Same size as the parked window — only the origin moves, no reflow.
            frame.size = parkedSize
        } else {
            parkedSize = frame.size
        }
        Paths.log("presentNow frame=\(frame) warm=\(isWarm)")
        panel.alphaValue = 1
        panel.ignoresMouseEvents = false
        panel.setFrame(frame, display: true)
        // Accessory + .nonactivatingPanel otherwise leaves the previous app
        // frontmost, so Cmd+C/V and Typeless target that app, not the map.
        if !isVisible {
            previousApp = NSWorkspace.shared.frontmostApplication
        }
        NSApp.activate()
        panel.orderFrontRegardless()
        panel.makeKey()
        panel.makeFirstResponder(webView)
        isVisible = true
        installClickMonitor()
    }

    private func installClickMonitor() {
        removeClickMonitor()
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor in
                self?.hideIfClickOutside(event)
            }
        }
    }

    private func removeClickMonitor() {
        if let clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
            self.clickMonitor = nil
        }
    }

    private func hideIfClickOutside(_ event: NSEvent) {
        guard isVisible else { return }
        let point = NSEvent.mouseLocation
        if !panel.frame.contains(point) {
            hide()
        }
    }

    @objc private func spaceChanged() {
        if isVisible { hide() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "rmsReady" {
            Paths.log("rmsReady from page")
            markWarm()
            pushNativeState()
            return
        }
        if message.name == "rmsNative" {
            handleNative(message.body)
        }
    }

    private func handleNative(_ body: Any) {
        guard let spec = body as? [String: Any] else { return }
        let op = spec["op"] as? String ?? ""
        if op == "getState" {
            pushNativeState()
            return
        }
        if op == "setLogin" {
            do {
                try LoginItem.setEnabled(bool(spec["on"]))
            } catch {
                Paths.log("setLogin \(error.localizedDescription)")
            }
            pushNativeState()
            return
        }
        if op == "setLanguage" {
            AppLanguage.current = AppLanguage.from(spec["lang"] as? String)
            return
        }
        if op == "setToggle" {
            if let chord = KeyChord.fromWeb(spec) {
                if !chord.hasModifier { return }
                ShortcutStore.shared.setChord(chord, for: .toggleOverlay)
                HotKeyCenter.shared.register(id: ShortcutID.toggleOverlay.carbonHotKeyID, chord: chord) { [weak self] in
                    if Thread.isMainThread {
                        MainActor.assumeIsolated { self?.toggle() }
                    } else {
                        DispatchQueue.main.async { self?.toggle() }
                    }
                }
                pushNativeState()
            }
        }
    }

    private func bool(_ value: Any?) -> Bool {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        return false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Paths.log("webview didFinish")
        webView.evaluateJavaScript("document.documentElement.classList.add('rms-wk')")
        webView.evaluateJavaScript(
            "typeof window.__rmsSignalReady+' ready='+window.__RMS_READY__+' nodes='+document.querySelectorAll('.node').length+' map='+!!window.map"
        ) { result, _ in
            Paths.log("page state \(result ?? "nil")")
        }
        pollReady(attemptsLeft: 80)
    }

    private func pollReady(attemptsLeft: Int) {
        if isWarm { return }
        webView.evaluateJavaScript("!!window.__RMS_READY__") { [weak self] result, _ in
            Task { @MainActor in
                guard let self, !self.isWarm else { return }
                if result as? Bool == true {
                    Paths.log("poll saw __RMS_READY__")
                    self.markWarm()
                    return
                }
                guard attemptsLeft > 0 else {
                    self.webView.evaluateJavaScript(
                        "typeof window.__rmsSignalReady+' ready='+window.__RMS_READY__+' nodes='+document.querySelectorAll('.node').length+' map='+!!window.map"
                    ) { result, _ in
                        Paths.log("ready poll timed out state=\(result ?? "nil")")
                    }
                    self.markWarm()
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    self.pollReady(attemptsLeft: attemptsLeft - 1)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Paths.log("webview didFail \(error.localizedDescription)")
        markWarm()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Paths.log("webview provisionalFail \(error.localizedDescription)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, !self.isWarm else { return }
            self.didStartLoad = false
            self.startLoadIfNeeded()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        if url.host == "127.0.0.1" || url.host == "localhost" { return .allow }
        if url.scheme == "about" { return .allow }
        NSWorkspace.shared.open(url)
        return .cancel
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private static func shortcutScript() -> WKUserScript {
        let json = ShortcutStore.shared.webJSON()
        return WKUserScript(
            source: "window.__RMS_SHORTCUTS__=\(json);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    private static func readyScript() -> WKUserScript {
        WKUserScript(
            source: """
            document.documentElement.classList.add('rms-wk');
            window.__RMS_READY__=false;
            (function(){
              var s=document.createElement('style');
              s.id='rms-boot-css';
              s.textContent='.search-wrap:not(.open){display:none!important;width:0!important;min-width:0!important;border:none!important;box-shadow:none!important}';
              document.documentElement.appendChild(s);
            })();
            document.addEventListener('contextmenu', function(e){ e.preventDefault(); }, true);
            try{ navigator.serviceWorker.getRegistrations().then(function(rs){ rs.forEach(function(r){ r.unregister(); }); }); }catch(e){}
            window.__rmsSignalReady=function(){
              if(window.__RMS_READY__) return;
              window.__RMS_READY__=true;
              try{ window.webkit.messageHandlers.rmsReady.postMessage('1'); }catch(e){}
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    private static func readyWatchScript() -> WKUserScript {
        WKUserScript(
            source: """
            (function(){
              function painted(){
                if(document.querySelector('.node')) return true;
                var empty=document.getElementById('empty');
                if(empty && empty.style.display==='grid') return true;
                var login=document.getElementById('loginOverlay');
                if(login && login.style.display==='flex') return true;
                return false;
              }
              function tick(){
                if(window.__RMS_READY__) return;
                if(painted() && typeof window.__rmsSignalReady==='function'){
                  window.__rmsSignalReady();
                  return;
                }
                setTimeout(tick, 16);
              }
              if(document.readyState==='loading'){
                document.addEventListener('DOMContentLoaded', function(){ setTimeout(tick, 0); });
              } else {
                setTimeout(tick, 0);
              }
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
    }

    private static func targetScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        if let hit = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) {
            return hit
        }
        return NSScreen.main ?? NSScreen.screens[0]
    }
}

/// WKWebView still builds a native menu (Reload / Inspect Element) even when
/// the page calls preventDefault on `contextmenu`. Empty it so the overlay
/// does not flash or jump.
private final class MapWebView: WKWebView {
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
        menu.cancelTracking()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        nil
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if handleClipboardShortcut(event) { return true }
        return super.performKeyEquivalent(with: event)
    }

    @objc func copy(_ sender: Any?) { nativeCopy() }
    @objc func cut(_ sender: Any?) { nativeCut() }
    @objc func paste(_ sender: Any?) { nativePaste() }
    override func selectAll(_ sender: Any?) { nativeSelectAll() }

    fileprivate func handleClipboardShortcut(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), !flags.contains(.option), !flags.contains(.control) else {
            return false
        }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "c":
            nativeCopy()
            return true
        case "x":
            nativeCut()
            return true
        case "v":
            nativePaste()
            return true
        case "a" where !flags.contains(.shift):
            nativeSelectAll()
            return true
        case "z" where flags.contains(.shift):
            nativeRedo()
            return true
        case "z":
            nativeUndo()
            return true
        default:
            return false
        }
    }

    private func nativeCopy() {
        evaluateJavaScript("window.__rmsClipboardCopy&&window.__rmsClipboardCopy()") { result, _ in
            guard let text = result as? String, !text.isEmpty else { return }
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(text, forType: .string)
        }
    }

    private func nativeCut() {
        evaluateJavaScript("window.__rmsClipboardCut&&window.__rmsClipboardCut()") { result, _ in
            guard let text = result as? String, !text.isEmpty else { return }
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(text, forType: .string)
        }
    }

    private func nativePaste() {
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        guard !text.isEmpty else { return }
        evaluateJavaScript("window.__rmsClipboardPaste&&window.__rmsClipboardPaste(\(Self.jsonString(text)))")
    }

    private static func jsonString(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              var encoded = String(data: data, encoding: .utf8),
              encoded.count >= 2 else { return "\"\"" }
        encoded.removeFirst()
        encoded.removeLast()
        return encoded
    }

    private func nativeSelectAll() {
        evaluateJavaScript("window.__rmsClipboardSelectAll&&window.__rmsClipboardSelectAll()")
    }

    private func nativeUndo() {
        evaluateJavaScript("window.__rmsClipboardUndo&&window.__rmsClipboardUndo()")
    }

    private func nativeRedo() {
        evaluateJavaScript("window.__rmsClipboardRedo&&window.__rmsClipboardRedo()")
    }
}
