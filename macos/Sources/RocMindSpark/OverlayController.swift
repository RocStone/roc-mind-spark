import AppKit
import CoreGraphics
import WebKit

@MainActor
final class OverlayController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private let panel = OverlayPanel()
    private var webView: WKWebView!
    private var selectionDiagnostics: SelectionDiagnostics?
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
    /// The serial utility queue keeps CGWindowList/NSRunningApplication work
    /// off the main actor. `LauncherHUDWatchState` holds the slot until the
    /// result callback returns, including across hide/show.
    private let hudProbeQueue = DispatchQueue(
        label: "com.roc.mindspark.launcher-hud-probe",
        qos: .utility
    )
    private var hudWatchState = LauncherHUDWatchState()
    private var duckedUnderHud = false
    private var duckedHudId: UInt32 = 0
    private var ignoreActivateUntil: Date?
    /// WKWebView `<input type=file>` is stuck until `runOpenPanelWith` completes.
    private var pickingOpenPanel = false
    /// window.open(_blank) hits createWebViewWith; a follow-up <a> click can
    /// also hit decidePolicyFor. Both used to call NSWorkspace.open.
    private var lastExternalOpen: (url: URL, at: Date)?
    private var openPanel: NSOpenPanel?
    private var openPanelCompletion: (@MainActor @Sendable ([URL]?) -> Void)?
    private var boot = CanvasBootCoordinator()
    private var statusView: CanvasStatusView?
    private var lastBootError: Error?
    /// WKDownload is not retained by WebKit once it hands it to us.
    private var activeDownloads: Set<WKDownload> = []
    /// Save panels and JS dialogs are sheets on the overlay. While one is up,
    /// clicks and app switches it causes must not hide the overlay.
    private var nativeModalDepth = 0
    /// Mirrors the page's `{op:'saveState'}` (`rmsPageIsDirty()` in app.js):
    /// true while any map has an edit that has not reached the server yet,
    /// including drafts still in an open node editor, notes popup or
    /// Markdown pane.
    private(set) var pageDirty = false
    /// WebContent crashed; the page (and anything unsaved in it) is gone
    /// until the reload finishes.
    private var webProcessCrashed = false
    private var powerOffFlushInFlight = false

    private(set) var isVisible = false

    init(server: ServerSupervisor) {
        self.server = server
        super.init()
        server.onUnexpectedExit = { [weak self] in
            guard let self else { return }
            self.boot.markServiceUnavailable()
            self.lastBootError = ServerError.stoppedUnexpectedly
            self.applyBootUI()
        }
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
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(languageDidChange),
            name: .rmsLanguageDidChange,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(willPowerOff),
            name: NSWorkspace.willPowerOffNotification,
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
        if let directory = SelectionDiagnostics.directory {
            selectionDiagnostics = SelectionDiagnostics(window: panel, directory: directory)
            if let script = SelectionDiagnostics.userScript() { config.userContentController.addUserScript(script) }
        }
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
        attachStatusView(to: root)
        Paths.log("webview attached")
    }

    func preload() {
        if keepAlive == nil {
            keepAlive = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiatedAllowingIdleSystemSleep],
                reason: "Keep the mind map painted while the overlay is parked"
            )
        }
        runBoot(retry: false)
    }

    func toggle() {
        Paths.log("toggle visible=\(isVisible) warm=\(isWarm)")
        if isVisible { hide() } else { show() }
    }

    func show() {
        Paths.opsLog("overlay-show")
        presentNow()
        runBoot(retry: false)
        applyBootUI()
    }

    func hide(restorePrevious: Bool = true) {
        panel.cancelPendingDrag()
        cancelOpenPanel()
        if isVisible {
            Paths.opsLog("overlay-hide")
            webView?.evaluateJavaScript("void(window.rmsFlushForHide&&window.rmsFlushForHide())")
        }
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

    /// Normal application quit waits for the page's model and save queue.
    /// The page is kept alive if persistence fails, so drafts remain editable.
    /// False means quitting now cannot lose anything: the page never loaded,
    /// its process is dead, or the page reports nothing unsaved. The page's
    /// flag covers open editors too, so overlay visibility does not matter.
    var needsFlushBeforeQuit: Bool {
        QuitFlush.needsFlush(
            pageLoaded: webView != nil && didStartLoad,
            webProcessCrashed: webProcessCrashed,
            pageDirty: pageDirty
        )
    }

    /// Logout / restart / shutdown: save before AppKit asks us to quit, so
    /// the later `applicationShouldTerminate` can usually answer terminateNow.
    @objc private func willPowerOff() {
        guard needsFlushBeforeQuit, !powerOffFlushInFlight else { return }
        Paths.log("willPowerOff: flushing early")
        powerOffFlushInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await QuitFlush.run(timeout: .seconds(7)) { try await self.flushBeforeQuit() }
                Paths.log("willPowerOff: flush done")
            } catch {
                Paths.log("willPowerOff: flush failed \(error.localizedDescription)")
            }
            self.powerOffFlushInFlight = false
        }
    }

    func flushBeforeQuit() async throws {
        guard let webView, didStartLoad, !webProcessCrashed else { return }
        let result = try await webView.callAsyncJavaScript("""
            if (!window.rmsFlushPendingEdits) return {ok:true};
            let timer;
            try {
                await Promise.race([
                    window.rmsFlushPendingEdits(),
                    new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('Saving timed out')),5000); })
                ]);
                return {ok:true};
            } catch (error) { return {ok:false,message:String(error.message||error)}; }
            finally { clearTimeout(timer); }
            """, arguments: [:], in: nil, contentWorld: .page)
        if let response = result as? [String: Any], response["ok"] as? Bool == false {
            throw NSError(domain: "RocMindSpark.Save", code: 1, userInfo: [
                NSLocalizedDescriptionKey: response["message"] as? String ?? L10n.t("error.saveQuit")
            ])
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

    private func attachStatusView(to root: NSView) {
        if statusView != nil { return }
        let status = CanvasStatusView(frame: .zero)
        status.translatesAutoresizingMaskIntoConstraints = false
        status.onRetry = { [weak self] in self?.runBoot(retry: true) }
        status.isHidden = true
        root.addSubview(status)
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            status.topAnchor.constraint(equalTo: root.topAnchor),
            status.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        statusView = status
    }

    private func runBoot(retry: Bool) {
        let accepted = retry ? boot.requestRetry() : boot.requestStart()
        guard accepted else { return }
        applyBootUI()
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.server.ensureRunning()
                guard self.server.hasHealthyRunningChild else { throw ServerError.stoppedUnexpectedly }
                self.boot.markSucceeded()
                self.lastBootError = nil
                self.applyBootUI()
                self.startLoadIfNeeded()
                // A service restart keeps the live page and its unsaved drafts.
                _ = try? await self.webView?.evaluateJavaScript("void(window.rmsRetryPendingSaves&&window.rmsRetryPendingSaves())")
                if !self.isVisible { self.parkOffscreen() }
            } catch {
                Paths.log("canvas boot failed: \(error.localizedDescription)")
                self.boot.markFailed()
                self.lastBootError = error
                self.applyBootUI()
            }
        }
    }

    private func applyBootUI() {
        switch boot.phase {
        case .idle:
            statusView?.isHidden = true
        case .starting, .retrying:
            webView?.isHidden = true
            statusView?.showStarting()
        case .failed:
            webView?.isHidden = true
            statusView?.showFailure(message: lastBootError?.localizedDescription ?? L10n.t("error.title"))
        case .ready:
            statusView?.isHidden = true
            webView?.isHidden = false
            if isVisible { panel.makeFirstResponder(webView) }
        }
        if isVisible, boot.phase == .failed || boot.phase == .starting || boot.phase == .retrying {
            panel.makeFirstResponder(statusView)
        }
    }

    @objc private func languageDidChange() {
        if boot.phase == .failed, let lastBootError {
            statusView?.refreshFailure(message: lastBootError.localizedDescription)
        } else if boot.phase == .starting || boot.phase == .retrying {
            statusView?.showStarting()
        }
    }

    private func startLoadIfNeeded() {
        guard boot.shouldLoadCanvas else { return }
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

    /// Frame a readable cluster for a local `--demo-shot`. Does not persist camera.
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
        if boot.shouldLoadCanvas {
            panel.makeFirstResponder(webView)
            // AppKit drops WebKit's native editor focus while this panel is
            // parked. Reconnect the live page editor after showing it again.
            webView.evaluateJavaScript(
                "window.rmsRestoreAfterShow&&window.rmsRestoreAfterShow()"
            ) { _, error in
                if let error {
                    Paths.log("restore editor after show js error \(error.localizedDescription)")
                }
            }
        } else {
            panel.makeFirstResponder(statusView)
        }
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
        guard isVisible, !pickingOpenPanel, nativeModalDepth == 0, !SelectionDiagnostics.keepVisible else { return }
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
        guard !SelectionDiagnostics.keepVisible else { return }
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
        guard isVisible, !pickingOpenPanel, nativeModalDepth == 0, !SelectionDiagnostics.keepVisible else { return }
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
        hudWatchState.activateDisplay()
        let timer = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.requestLauncherHudSync()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        hudWatch = timer
        requestLauncherHudSync()
    }

    private func stopHudWatch() {
        hudWatch?.invalidate()
        hudWatch = nil
        // Do not clear an in-flight probe here. A native query cannot be
        // canceled safely; retaining its slot prevents hide/show from
        // starting a second query before this one has returned to main.
        hudWatchState.invalidateDisplay()
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

    private func requestLauncherHudSync() {
        guard isVisible, let probe = hudWatchState.beginProbeIfIdle() else { return }
        let bundleId = AppConfig.bundleId
        hudProbeQueue.async { [weak self] in
            let snapshot = LauncherHUDSnapshot.capture(overlayBundleId: bundleId)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let isCurrentDisplay = self.hudWatchState.finish(probe)
                guard isCurrentDisplay, self.isVisible else { return }
                self.syncLauncherHudStack(snapshot)
            }
        }
    }

    private func syncLauncherHudStack(_ snapshot: LauncherHUDSnapshot) {
        guard isVisible else { return }
        guard let hud = snapshot.topHud else {
            restoreCoverStack()
            return
        }
        if duckedUnderHud, duckedHudId == hud.id { return }
        if !duckedUnderHud {
            Paths.log("hud-watch duck \(hud.description)")
            ignoreActivateUntil = Date().addingTimeInterval(0.8)
        }
        duckedUnderHud = true
        duckedHudId = hud.id
        panel.duck(belowHudLayer: Int(hud.layer), windowNumber: Int(hud.id))
    }

    nonisolated static func isLauncherHudOwner(name: String, bundleId: String?) -> Bool {
        LauncherHUDSnapshot.isLauncherHudOwner(name: name, bundleId: bundleId)
    }

    /// Menu extras are tiny. The search HUD is a wide bar / results list.
    /// Zero size means the system redacted bounds (TCC); a window below
    /// status-window level is treated as the HUD in that case.
    nonisolated static func isLauncherHudMetrics(width: Double, height: Double, alpha: Double) -> Bool {
        LauncherHUDSnapshot.isLauncherHudMetrics(width: width, height: height, alpha: alpha)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "rmsReady" {
            Paths.log("rmsReady from page")
            markWarm()
            pushNativeState()
            return
        }
        if message.name == "rmsNative" {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  WebPolicy.isServerOrigin(host: origin.host, port: origin.port) else {
                Paths.log("rmsNative ignored from \(origin.protocol)://\(origin.host):\(origin.port) main=\(message.frameInfo.isMainFrame)")
                return
            }
            handleNative(message.body)
        }
    }

    private func handleNative(_ body: Any) {
        guard let spec = body as? [String: Any] else { return }
        let op = spec["op"] as? String ?? ""
        if op == "selectionTrace", let payload = spec["payload"] {
            selectionDiagnostics?.recordPage(payload)
            return
        }
        if op == "getState" {
            pushNativeState()
            return
        }
        if op == "saveState" {
            pageDirty = bool(spec["dirty"])
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
                commitToggleChord(chord)
            } else {
                notifyToggleListenDone(ok: false)
            }
            return
        }
        if op == "edit" {
            guard let map = webView as? MapWebView else { return }
            switch spec["act"] as? String {
            case "copy": map.copy(nil)
            case "cut": map.cut(nil)
            case "paste": map.paste(nil)
            case "selectAll": map.selectAll(nil)
            case "undo": map.undo(nil)
            case "redo": map.redo(nil)
            default: break
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
        // A bare key: keep listening for a real chord.
        if ShortcutStore.rejection(for: chord, id: .toggleOverlay) == .needsModifier { return true }
        toggleListenArmed = false
        stopToggleListenMonitors()
        commitToggleChord(chord)
        return true
    }

    /// Reports failure to the page (which then repaints the previous chord)
    /// when the chord is reserved or Carbon refuses to register it.
    private func commitToggleChord(_ chord: KeyChord) {
        let store = ShortcutStore.shared
        if !store.setChord(chord, for: .toggleOverlay) {
            Paths.log("toggle chord \(chord.display) rejected as reserved")
            // setChord posted nothing; rebind the chord listening unregistered.
            NotificationCenter.default.post(name: .rmsShortcutsDidChange, object: nil)
            showPageToast(String(format: L10n.t("hotkey.reserved"), chord.display))
            notifyToggleListenDone(ok: false)
            return
        }
        // The change notification rebinds synchronously; a failed Carbon
        // registration has already restored the previous chord in the store.
        if store.chord(for: .toggleOverlay) != chord {
            showPageToast(String(format: L10n.t("hotkey.registerFailed"), chord.display))
            notifyToggleListenDone(ok: false)
            return
        }
        notifyToggleListenDone(ok: true)
    }

    private func showPageToast(_ message: String) {
        webView?.evaluateJavaScript("typeof toast==='function'&&toast(\(Self.jsString(message)))")
    }

    private static func jsString(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let encoded = String(data: data, encoding: .utf8), encoded.count >= 2 else { return "\"\"" }
        return String(encoded.dropFirst().dropLast())
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

    /// WebContent crashed or was killed (memory pressure, GPU reset). The
    /// view goes blank and every evaluateJavaScript fails until we reload.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Paths.log("webview content process terminated; reloading")
        webProcessCrashed = true
        pageDirty = false
        isWarm = false
        didStartLoad = false
        startLoadIfNeeded()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Paths.log("webview didFinish")
        webProcessCrashed = false
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
            guard let self, !self.isWarm, self.boot.shouldLoadCanvas else { return }
            self.didStartLoad = false
            self.startLoadIfNeeded()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        let decision = WebPolicy.navigation(url: url, shouldPerformDownload: navigationAction.shouldPerformDownload)
        switch decision {
        case .allow: return .allow
        case .download: return .download
        case .openExternal:
            if let url { openExternal(url) }
            return .cancel
        case .cancel:
            Paths.log("navigation blocked \(url?.absoluteString ?? "nil")")
            return .cancel
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
        navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        adoptDownload(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        adoptDownload(download)
    }

    private func adoptDownload(_ download: WKDownload) {
        download.delegate = self
        activeDownloads.insert(download)
        Paths.log("download started \(download.originalRequest?.url?.absoluteString.prefix(80) ?? "?")")
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String
    ) async -> URL? {
        let save = NSSavePanel()
        save.nameFieldStringValue = suggestedFilename
        save.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        save.canCreateDirectories = true
        save.isExtensionHidden = false
        let result = await presentSavePanel(save)
        guard result == .OK, let url = save.url else {
            Paths.log("download cancelled by user")
            activeDownloads.remove(download)
            return nil
        }
        // NSSavePanel already asked about replacing. WKDownload refuses to
        // write over an existing file, so remove it now.
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                Paths.log("download could not replace \(url.path): \(error.localizedDescription)")
                activeDownloads.remove(download)
                return nil
            }
        }
        Paths.log("download destination \(url.path)")
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        Paths.log("download finished")
        activeDownloads.remove(download)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        Paths.log("download failed \(error.localizedDescription)")
        activeDownloads.remove(download)
    }

    /// A sheet attached to the overlay stays above its cover level. When the
    /// overlay is parked, fall back to a free-standing panel above it.
    private func presentSavePanel(_ save: NSSavePanel) async -> NSApplication.ModalResponse {
        beginNativeModal()
        defer { endNativeModal() }
        if isVisible {
            return await withCheckedContinuation { continuation in
                save.beginSheetModal(for: panel) { continuation.resume(returning: $0) }
            }
        }
        save.level = NSWindow.Level(rawValue: OverlayPanel.coverLevel.rawValue + 2)
        return await withCheckedContinuation { continuation in
            save.begin { continuation.resume(returning: $0) }
        }
    }

    private func presentAlert(_ alert: NSAlert) async -> NSApplication.ModalResponse {
        beginNativeModal()
        defer { endNativeModal() }
        if isVisible {
            return await withCheckedContinuation { continuation in
                alert.beginSheetModal(for: panel) { continuation.resume(returning: $0) }
            }
        }
        alert.window.level = NSWindow.Level(rawValue: OverlayPanel.coverLevel.rawValue + 2)
        return alert.runModal()
    }

    private func beginNativeModal() {
        nativeModalDepth += 1
        NSApp.activate()
        if isVisible { panel.makeKey() }
    }

    private func endNativeModal() {
        nativeModalDepth = max(0, nativeModalDepth - 1)
        guard nativeModalDepth == 0, isVisible else { return }
        panel.makeKey()
        panel.makeFirstResponder(webView)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            openExternal(url)
        }
        return nil
    }

    private func openExternal(_ url: URL) {
        guard WebPolicy.canOpenExternally(url) else {
            Paths.log("openExternal refused scheme \(url.scheme ?? "nil")")
            return
        }
        if let last = lastExternalOpen, last.url == url, Date().timeIntervalSince(last.at) < 0.8 {
            return
        }
        lastExternalOpen = (url, Date())
        NSWorkspace.shared.open(url)
    }

    /// WKWebView drops alert/confirm/prompt unless the UI delegate shows them.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable () -> Void
    ) {
        let alert = makeDialog(message)
        alert.addButton(withTitle: L10n.t("dialog.ok"))
        Task { @MainActor in
            _ = await self.presentAlert(alert)
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        let alert = makeDialog(message)
        alert.addButton(withTitle: L10n.t("dialog.ok"))
        alert.addButton(withTitle: L10n.t("dialog.cancel"))
        Task { @MainActor in
            let response = await self.presentAlert(alert)
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (String?) -> Void
    ) {
        let alert = makeDialog(prompt)
        alert.addButton(withTitle: L10n.t("dialog.ok"))
        alert.addButton(withTitle: L10n.t("dialog.cancel"))
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        Task { @MainActor in
            let response = await self.presentAlert(alert)
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    private func makeDialog(_ text: String) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = text
        alert.informativeText = ""
        return alert
    }

    /// Without this, `<input type=file>` (Attach image / Import) is a no-op
    /// in WKWebView.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
    ) {
        if pickingOpenPanel {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canCreateDirectories = false
        panel.level = NSWindow.Level(rawValue: OverlayPanel.coverLevel.rawValue + 2)
        NSApp.activate()
        pickingOpenPanel = true
        openPanel = panel
        openPanelCompletion = completionHandler
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] result in
            guard let self else { return }
            let urls = result == .OK ? panel.urls : nil
            self.finishOpenPanel(urls)
        }
        if isVisible {
            panel.beginSheetModal(for: self.panel, completionHandler: finish)
        } else {
            panel.begin(completionHandler: finish)
        }
    }

    private func finishOpenPanel(_ urls: [URL]?) {
        let done = openPanelCompletion
        openPanelCompletion = nil
        openPanel = nil
        pickingOpenPanel = false
        done?(urls)
        if isVisible {
            self.panel.makeKey()
            self.panel.makeFirstResponder(webView)
        }
    }

    private func cancelOpenPanel() {
        guard pickingOpenPanel || openPanelCompletion != nil else { return }
        openPanel?.close()
        finishOpenPanel(nil)
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
    @objc func undo(_ sender: Any?) { nativeUndo() }
    @objc func redo(_ sender: Any?) { nativeRedo() }

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
            // Fetch first: clearing before the await would leave the
            // pasteboard empty (and other apps seeing that) meanwhile.
            let data = await self.imageData(from: image)
            let board = NSPasteboard.general
            board.clearContents()
            if let data {
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
        evaluateJavaScript("window.__rmsClipboardWantsText&&window.__rmsClipboardWantsText()") { [weak self] result, _ in
            guard let self else { return }
            let wantsText = (result as? Bool) == true || (result as? NSNumber)?.boolValue == true
            let text = NSPasteboard.general.string(forType: .string) ?? ""
            if wantsText {
                guard !text.isEmpty else { return }
                self.evaluateJavaScript("window.__rmsClipboardPaste&&window.__rmsClipboardPaste(\(Self.jsonString(text)))")
                return
            }
            Task { @MainActor in
                if let payload = await self.pasteboardImagePayload() {
                    self.pasteImage(payload)
                    return
                }
                guard !text.isEmpty else { return }
                _ = try? await self.evaluateJavaScript("window.__rmsClipboardPaste&&window.__rmsClipboardPaste(\(Self.jsonString(text)))")
            }
        }
    }

    private typealias PasteImage = PasteboardImageDecoder.Image

    private static let jpegType = NSPasteboard.PasteboardType("public.jpeg")

    /// PNG/JPEG already on the pasteboard is used as-is. Anything that needs
    /// decoding (TIFF, PDF, HEIC files, …) is converted off the main actor.
    private func pasteboardImagePayload() async -> PasteImage? {
        let snapshot = PasteboardImageDecoder.Snapshot(board: NSPasteboard.general)
        if let direct = snapshot.directImage { return direct }
        return await Task.detached(priority: .userInitiated) { snapshot.decode() }.value
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
