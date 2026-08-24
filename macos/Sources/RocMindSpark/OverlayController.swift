import AppKit
import CoreGraphics
import WebKit

@MainActor
final class OverlayController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let panel = OverlayPanel()
    private var webView: WKWebView!
    private let server: ServerSupervisor
    private var clickMonitor: Any?
    private var toggleListenLocal: Any?
    private var toggleListenGlobal: Any?
    private var toggleListenArmed = false
    private var didStartLoad = false
    private var isWarm = false
    private var pendingShow = false
    private var parkedSize: CGSize = .zero
    private var keepAlive: NSObjectProtocol?
    private var previousApp: NSRunningApplication?
    private var hudWatch: Timer?
    private var duckedUnderHud = false
    private var duckedHudId: UInt32 = 0
    private var ignoreActivateUntil: Date?

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
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(anotherAppActivated),
            name: NSWorkspace.didActivateApplicationNotification,
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

    func hide(restorePrevious: Bool = true) {
        if isVisible { Paths.opsLog("overlay-hide") }
        pendingShow = false
        restoreCoverStack(orderFront: false)
        stopHudWatch()
        guard isVisible else {
            parkOffscreen()
            return
        }
        removeClickMonitor()
        if toggleListenArmed {
            cancelToggleListen(rebind: true)
        }
        isVisible = false
        parkOffscreen()
        if restorePrevious {
            let restore = previousApp
            previousApp = nil
            if let restore, restore.bundleIdentifier != AppConfig.bundleId {
                restore.activate()
            }
        } else {
            previousApp = nil
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
                if CommandLine.arguments.contains("--demo-shot") {
                    self.runDemoShot()
                }
            }
        }
    }

    /// Frame a readable cluster for docs/screenshot.png. Does not persist camera.
    private func runDemoShot() {
        if !isVisible { show() }
        let js = """
        (function(){
          function go(){
            if(!window.map || !window.map.nodes || typeof applyView!=='function'){
              setTimeout(go, 80);
              return;
            }
            try{
              window.saveMapView=function(){};
              window._saveMapViewNow=function(){};
            }catch(e){}
            var side=document.getElementById('side');
            if(side){
              side.classList.add('collapsed');
              document.documentElement.classList.add('side-collapsed');
            }
            var hit=null;
            Object.keys(map.nodes).forEach(function(id){
              var t=map.nodes[id].text||'';
              if(/Mid-layer exploration|model has the right answer|GPT-5\\.6 Pro/.test(t)) hit=map.nodes[id];
            });
            if(!hit) hit=map.nodes[map.rootId];
            view.k=1.12;
            var sw=window.innerWidth, sh=window.innerHeight;
            view.x = sw/2 - (hit.x+(hit.w||140)/2)*view.k;
            view.y = sh/2 - (hit.y+(hit.h||50)/2)*view.k;
            applyView();
          }
          go();
        })();
        """
        webView.evaluateJavaScript(js) { _, error in
            if let error { Paths.log("demo-shot js \(error.localizedDescription)") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                Paths.log("demo-shot framed")
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
        panel.applyCoverLevel()
        panel.orderFrontRegardless()
        panel.makeKey()
        panel.makeFirstResponder(webView)
        isVisible = true
        duckedUnderHud = false
        duckedHudId = 0
        ignoreActivateUntil = nil
        installClickMonitor()
        startHudWatch()
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

    private func hideIfClickOutside(_: NSEvent) {
        guard isVisible else { return }
        if Self.isScreenshotApp(NSWorkspace.shared.frontmostApplication) { return }
        let point = NSEvent.mouseLocation
        if !panel.frame.contains(point) {
            hide(restorePrevious: false)
        }
    }

    private static func isScreenshotApp(_ app: NSRunningApplication?) -> Bool {
        guard let id = app?.bundleIdentifier?.lowercased(), !id.isEmpty else { return false }
        return id.contains("screencapture") || id.contains("screenshot")
    }

    @objc private func spaceChanged() {
        if isVisible { hide() }
    }

    /// Raycast closing reactivates the app behind the overlay. That is not
    /// a user switching away — keep the map up. Cmd-Tab to a different app
    /// still hides.
    static func shouldHideOnActivation(
        overlayVisible: Bool,
        activatedBundleId: String?,
        overlayBundleId: String,
        previousAppBundleId: String?,
        duckedUnderHud: Bool,
        now: Date,
        ignoreUntil: Date?,
        isScreenshot: Bool,
        isLauncher: Bool
    ) -> Bool {
        if !overlayVisible { return false }
        if isScreenshot || isLauncher { return false }
        if let activatedBundleId, activatedBundleId == overlayBundleId { return false }
        if let ignoreUntil, now < ignoreUntil { return false }
        if duckedUnderHud { return false }
        if let activatedBundleId, let previousAppBundleId, activatedBundleId == previousAppBundleId {
            return false
        }
        return true
    }

    @objc private func anotherAppActivated(_ note: Notification) {
        guard isVisible else { return }
        let app = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
            ?? NSWorkspace.shared.frontmostApplication
        let shouldHide = Self.shouldHideOnActivation(
            overlayVisible: isVisible,
            activatedBundleId: app?.bundleIdentifier,
            overlayBundleId: AppConfig.bundleId,
            previousAppBundleId: previousApp?.bundleIdentifier,
            duckedUnderHud: duckedUnderHud,
            now: Date(),
            ignoreUntil: ignoreActivateUntil,
            isScreenshot: Self.isScreenshotApp(app),
            isLauncher: Self.isLauncherHudOwner(
                name: app?.localizedName ?? "",
                bundleId: app?.bundleIdentifier
            )
        )
        if !shouldHide {
            if app?.bundleIdentifier == AppConfig.bundleId { return }
            if Self.isScreenshotApp(app) { return }
            if Self.isLauncherHudOwner(name: app?.localizedName ?? "", bundleId: app?.bundleIdentifier) {
                return
            }
            Paths.log("activation keep overlay app=\(app?.bundleIdentifier ?? "?")")
            reclaimAfterLauncher()
            return
        }
        hide(restorePrevious: false)
    }

    /// Raycast's search HUD is a non-activating panel, so
    /// `didActivateApplication` never fires. Keep the map up and stack
    /// under the HUD instead of hiding.
    private func startHudWatch() {
        guard hudWatch == nil else { return }
        let timer = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.syncLauncherHudStack()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        hudWatch = timer
        syncLauncherHudStack()
    }

    private func stopHudWatch() {
        hudWatch?.invalidate()
        hudWatch = nil
    }

    private func restoreCoverStack(orderFront: Bool = true) {
        guard duckedUnderHud else { return }
        duckedUnderHud = false
        duckedHudId = 0
        ignoreActivateUntil = Date().addingTimeInterval(0.8)
        panel.applyCoverLevel()
        if orderFront, isVisible {
            panel.orderFrontRegardless()
        }
        Paths.log("hud-watch restore cover")
    }

    private func reclaimAfterLauncher() {
        restoreCoverStack()
        ignoreActivateUntil = Date().addingTimeInterval(0.8)
        guard isVisible else { return }
        NSApp.activate()
        panel.makeKey()
        panel.makeFirstResponder(webView)
        Paths.log("hud-watch reclaim")
    }

    private func syncLauncherHudStack() {
        guard isVisible else { return }
        let huds = Self.launcherSnaps().filter(\.isHud)
        guard let hud = huds.max(by: { $0.layer < $1.layer }) else {
            restoreCoverStack()
            return
        }
        if duckedUnderHud, duckedHudId == hud.id { return }
        if !duckedUnderHud {
            Paths.log("hud-watch duck \(Self.describeLauncherSnaps([hud]))")
            ignoreActivateUntil = Date().addingTimeInterval(0.8)
        }
        duckedUnderHud = true
        duckedHudId = hud.id
        panel.duck(belowHudLayer: Int(hud.layer), windowNumber: Int(hud.id))
    }

    static func isLauncherHudOwner(name: String, bundleId: String?) -> Bool {
        if let bundleId {
            let id = bundleId.lowercased()
            if id == "com.raycast.macos" { return true }
            if id.contains("alfred") { return true }
            if id == "com.apple.spotlight" { return true }
        }
        let owner = name.lowercased()
        if owner.contains("raycast") { return true }
        if owner.contains("alfred") { return true }
        if owner == "spotlight" { return true }
        return false
    }

    /// Menu extras are tiny. The search HUD is a wide bar / results list.
    /// Zero size means the system redacted bounds (TCC); a window below
    /// status-window level is treated as the HUD in that case.
    static func isLauncherHudMetrics(width: Double, height: Double, alpha: Double) -> Bool {
        if alpha < 0.05 { return false }
        if width <= 0 || height <= 0 { return false }
        return width >= 280 && height >= 48
    }

    private static func launcherSnaps() -> [(id: UInt32, isHud: Bool, owner: String, layer: Int32, width: Double, height: Double, pid: pid_t)] {
        onScreenWindows().compactMap { info in
            guard isLauncherOwned(info) else { return nil }
            guard let num = info[kCGWindowNumber as String] as? NSNumber else { return nil }
            let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            let width = (bounds?["Width"] as? NSNumber)?.doubleValue ?? 0
            let height = (bounds?["Height"] as? NSNumber)?.doubleValue ?? 0
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.int32Value ?? 0
            let owner = (info[kCGWindowOwnerName as String] as? String) ?? ""
            let pid = pid_t((info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0)
            let statusLevel = Int32(CGWindowLevelForKey(.statusWindow))
            var isHud = isLauncherHudMetrics(width: width, height: height, alpha: alpha)
            // Screen Recording off: bounds are 0. Menu extras still sit at
            // status-window level; the search HUD is lower (floating / overlay).
            if !isHud, alpha >= 0.05, width <= 0 || height <= 0, layer < statusLevel {
                isHud = true
            }
            return (
                id: num.uint32Value,
                isHud: isHud,
                owner: owner,
                layer: layer,
                width: width,
                height: height,
                pid: pid
            )
        }
    }

    private static func describeLauncherSnaps(_ snaps: [(id: UInt32, isHud: Bool, owner: String, layer: Int32, width: Double, height: Double, pid: pid_t)]) -> String {
        snaps.map { snap in
            "\(snap.owner)#\(snap.id) \(Int(snap.width))x\(Int(snap.height)) layer=\(snap.layer) hud=\(snap.isHud)"
        }.joined(separator: "; ")
    }

    private static func isLauncherOwned(_ info: [String: Any]) -> Bool {
        let name = (info[kCGWindowOwnerName as String] as? String) ?? ""
        let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
        let bundle = pid > 0 ? NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier : nil
        if bundle == AppConfig.bundleId { return false }
        return isLauncherHudOwner(name: name, bundleId: bundle)
    }

    private static func onScreenWindows() -> [[String: Any]] {
        let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
        return (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
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
        if op == "listenToggle" {
            startToggleListen()
            return
        }
        if op == "cancelToggleListen" {
            cancelToggleListen(rebind: true)
            return
        }
        if op == "setToggle" {
            if let chord = KeyChord.fromWeb(spec) {
                ShortcutStore.shared.setChord(chord, for: .toggleOverlay)
                pushNativeState()
            }
        }
    }

    private func startToggleListen() {
        toggleListenArmed = false
        stopToggleListenMonitors()
        toggleListenArmed = true
        HotKeyCenter.shared.unregister(id: ShortcutID.toggleOverlay.carbonHotKeyID)
        NSApp.activate()
        panel.makeKey()
        panel.makeFirstResponder(webView)
        toggleListenLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let keyCode = event.keyCode
            let chord = KeyChord.from(event: event)
            let swallow = MainActor.assumeIsolated {
                self.applyToggleListen(keyCode: keyCode, chord: chord)
            }
            return swallow ? nil : event
        }
        toggleListenGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let keyCode = event.keyCode
            let chord = KeyChord.from(event: event)
            Task { @MainActor in
                _ = self?.applyToggleListen(keyCode: keyCode, chord: chord)
            }
        }
    }

    private func applyToggleListen(keyCode: UInt16, chord: KeyChord?) -> Bool {
        guard toggleListenArmed else { return false }
        if keyCode == 53 {
            cancelToggleListen(rebind: true)
            return true
        }
        guard let chord else { return true }
        if chord == .commandComma { return true }
        if !chord.hasModifier { return true }
        toggleListenArmed = false
        stopToggleListenMonitors()
        ShortcutStore.shared.setChord(chord, for: .toggleOverlay)
        notifyToggleListenDone(ok: true)
        return true
    }

    private func cancelToggleListen(rebind: Bool) {
        let wasArmed = toggleListenArmed
        toggleListenArmed = false
        stopToggleListenMonitors()
        guard wasArmed else { return }
        if rebind {
            NotificationCenter.default.post(name: .rmsShortcutsDidChange, object: nil)
        }
        notifyToggleListenDone(ok: false)
    }

    private func stopToggleListenMonitors() {
        let local = toggleListenLocal
        let global = toggleListenGlobal
        toggleListenLocal = nil
        toggleListenGlobal = nil
        guard local != nil || global != nil else { return }
        DispatchQueue.main.async {
            if let local { NSEvent.removeMonitor(local) }
            if let global { NSEvent.removeMonitor(global) }
        }
    }

    private func notifyToggleListenDone(ok: Bool) {
        pushNativeState()
        let flag = ok ? "true" : "false"
        webView.evaluateJavaScript("window.__rmsToggleListenDone&&window.__rmsToggleListenDone(\(flag))")
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
        evaluateJavaScript("window.__rmsClipboardCopyPayload&&window.__rmsClipboardCopyPayload()") { result, _ in
            self.writeClipboard(from: result)
        }
    }

    private func nativeCut() {
        evaluateJavaScript("window.__rmsClipboardCut&&window.__rmsClipboardCut()") { result, _ in
            let text = result as? String ?? ""
            self.evaluateJavaScript("window.__rmsClipboardCopyImageUrl&&window.__rmsClipboardCopyImageUrl()") { image, _ in
                self.writeClipboard(text: text, image: image as? String ?? "")
            }
        }
    }

    private func writeClipboard(from result: Any?) {
        var text = ""
        var image = ""
        if let s = result as? String, let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            text = obj["text"] as? String ?? ""
            image = obj["image"] as? String ?? ""
        } else if let s = result as? String {
            text = s
        }
        writeClipboard(text: text, image: image)
    }

    private func writeClipboard(text: String, image: String) {
        if image.isEmpty {
            guard !text.isEmpty else { return }
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(text, forType: .string)
            return
        }
        Task { @MainActor in
            let board = NSPasteboard.general
            board.clearContents()
            if let data = await self.imageData(from: image) {
                let jpeg = image.lowercased().contains(".jpg") || image.lowercased().contains("image/jpeg")
                board.setData(data, forType: jpeg ? Self.jpegType : .png)
            }
            if !text.isEmpty {
                board.setString(text, forType: .string)
            }
        }
    }

    private func imageData(from ref: String) async -> Data? {
        if ref.hasPrefix("data:") {
            guard let comma = ref.firstIndex(of: ",") else { return nil }
            return Data(base64Encoded: String(ref[ref.index(after: comma)...]))
        }
        guard let url = absoluteURL(ref) else { return nil }
        return try? await URLSession.shared.data(for: URLRequest(url: url)).0
    }

    private func absoluteURL(_ ref: String) -> URL? {
        if ref.hasPrefix("http://") || ref.hasPrefix("https://") { return URL(string: ref) }
        if ref.hasPrefix("/") { return URL(string: "http://127.0.0.1:\(AppConfig.port)\(ref)") }
        return nil
    }

    private func nativePaste() {
        if let payload = pasteboardImagePayload() {
            pasteImage(payload)
            return
        }
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        guard !text.isEmpty else { return }
        evaluateJavaScript("window.__rmsClipboardPaste&&window.__rmsClipboardPaste(\(Self.jsonString(text)))")
    }

    private struct PasteImage {
        let data: Data
        let mime: String
    }

    private static let jpegType = NSPasteboard.PasteboardType("public.jpeg")
    private static let gifType = NSPasteboard.PasteboardType("public.gif")
    private static let webpType = NSPasteboard.PasteboardType("public.webp")

    private static let imageFileExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
    ]

    private func pasteboardImagePayload() -> PasteImage? {
        let board = NSPasteboard.general
        if let png = board.data(forType: .png), png.count > 32 {
            return PasteImage(data: png, mime: "image/png")
        }
        if let jpeg = board.data(forType: Self.jpegType), jpeg.count > 32 {
            return PasteImage(data: jpeg, mime: "image/jpeg")
        }
        if let gif = board.data(forType: Self.gifType), gif.count > 32 {
            return PasteImage(data: gif, mime: "image/gif")
        }
        if let webp = board.data(forType: Self.webpType), webp.count > 32 {
            return PasteImage(data: webp, mime: "image/webp")
        }
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) {
            for case let url as URL in urls {
                let ext = url.pathExtension.lowercased()
                guard Self.imageFileExtensions.contains(ext) else { continue }
                if ["heic", "heif", "tif", "tiff", "bmp"].contains(ext),
                   let image = NSImage(contentsOf: url),
                   let png = Self.pngData(from: image) {
                    return PasteImage(data: png, mime: "image/png")
                }
                guard let data = try? Data(contentsOf: url), data.count > 32 else { continue }
                return PasteImage(data: data, mime: Self.mime(for: ext))
            }
        }
        if let tiff = board.data(forType: .tiff),
           let image = NSImage(data: tiff),
           let png = Self.pngData(from: image) {
            return PasteImage(data: png, mime: "image/png")
        }
        return nil
    }

    private static func mime(for ext: String) -> String {
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        default: return "image/png"
        }
    }

    private static func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    private func pasteImage(_ payload: PasteImage) {
        evaluateJavaScript("(window.map&&window.map.id)||''") { [weak self] result, _ in
            guard let self else { return }
            let mapId = result as? String ?? ""
            Task { @MainActor in
                if !mapId.isEmpty, let name = try? await self.uploadMapImage(mapId: mapId, payload: payload) {
                    _ = try? await self.evaluateJavaScript(
                        "window.__rmsClipboardPasteImageFile&&window.__rmsClipboardPasteImageFile(\(Self.jsonString(name)))"
                    )
                    return
                }
                let dataURL = "data:\(payload.mime);base64,\(payload.data.base64EncodedString())"
                _ = try? await self.evaluateJavaScript(
                    "window.__rmsClipboardPasteImage&&window.__rmsClipboardPasteImage(\(Self.jsonString(dataURL)))"
                )
            }
        }
    }

    private func uploadMapImage(mapId: String, payload: PasteImage) async throws -> String {
        guard let url = URL(string: "http://127.0.0.1:\(AppConfig.port)/api/maps/\(mapId)/images") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(payload.mime, forHTTPHeaderField: "Content-Type")
        req.httpBody = payload.data
        req.timeoutInterval = 30
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = obj["name"] as? String,
              !name.isEmpty
        else {
            throw URLError(.cannotParseResponse)
        }
        return name
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
