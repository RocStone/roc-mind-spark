import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let server = ServerSupervisor()
    private let store = ShortcutStore.shared
    private var overlay: OverlayController!
    private var statusItem: NSStatusItem?
    /// Retained for the process lifetime. Turns POSIX SIGTERM into a normal
    /// `NSApp.terminate(nil)` on the main queue.
    private var terminationBridge: POSIXTerminationBridge?

    func applicationDidFinishLaunching(_ notification: Notification) {
        terminationBridge = POSIXTerminationBridge {
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        terminationBridge?.install()
        installEditMenu()
        overlay = OverlayController(server: server)
        installStatusItem()
        bindGlobalHotKeys()
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(toggleOverlay),
            name: Notification.Name("com.roc.mindspark.toggle"),
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(languageDidChange),
            name: .rmsLanguageDidChange,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(shortcutsDidChangeNote),
            name: .rmsShortcutsDidChange,
            object: nil
        )
        Paths.log("launch arguments=\(CommandLine.arguments)")
        enableLoginItemOnce()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.overlay.attachWebView()
            self.overlay.preload()
            if CommandLine.arguments.contains("--show") || CommandLine.arguments.contains("--demo-shot") {
                self.overlay.show()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        overlay.hide()
        server.stopIfLaunched()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        overlay.show()
        return false
    }

    /// Accessory apps have no Dock menu. Cmd+C/V are Edit-menu key
    /// equivalents, so without this they go to whichever app is still
    /// frontmost behind the overlay.
    private func installEditMenu() {
        let edit = NSMenu(title: L10n.t("menu.edit"))
        edit.addItem(withTitle: L10n.t("menu.undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: L10n.t("menu.redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: L10n.t("menu.cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L10n.t("menu.copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L10n.t("menu.paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L10n.t("menu.selectAll"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            let image = NSImage(systemSymbolName: "map.fill", accessibilityDescription: "Roc Mind Spark")
            image?.isTemplate = true
            button.image = image
        }
        statusItem = item
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        if L10n.isChinese {
            menu.font = NSFont(name: "PingFang SC", size: 13) ?? .menuFont(ofSize: 13)
        }

        let toggle = NSMenuItem(title: L10n.t("menu.toggle"), action: #selector(toggleOverlay), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        let prefs = NSMenuItem(title: L10n.t("menu.settings"), action: #selector(openSettings), keyEquivalent: "")
        prefs.target = self
        menu.addItem(prefs)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: L10n.t("menu.quit"), action: #selector(quit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        statusItem?.menu = menu
        statusItem?.button?.toolTip = "Roc Mind Spark  \(store.chord(for: .toggleOverlay).display)"
    }

    private func bindGlobalHotKeys() {
        let center = HotKeyCenter.shared
        center.unregister(id: ShortcutID.openSettings.carbonHotKeyID)
        center.register(id: ShortcutID.toggleOverlay.carbonHotKeyID, chord: store.chord(for: .toggleOverlay)) { [weak self] in
            Self.onMain { self?.overlay.toggle() }
        }
    }

    private func shortcutsDidChange() {
        bindGlobalHotKeys()
        rebuildMenu()
        overlay.applyShortcuts()
    }

    @objc private func languageDidChange() {
        rebuildMenu()
        installEditMenu()
    }

    @objc private func shortcutsDidChangeNote() {
        shortcutsDidChange()
    }

    @objc private func toggleOverlay() {
        overlay.toggle()
    }

    @objc private func openSettings() {
        overlay.show()
        overlay.openInAppSettings()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// Carbon already delivers on the main thread. Hopping via async would add a frame.
    private static func onMain(_ work: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated(work)
        } else {
            DispatchQueue.main.async { work() }
        }
    }

    private func enableLoginItemOnce() {
        let key = "loginItem.autoEnabled"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        do {
            try LoginItem.setEnabled(true)
            UserDefaults.standard.set(true, forKey: key)
            Paths.log("login item enabled")
        } catch {
            Paths.log("login item failed: \(error.localizedDescription)")
        }
    }
}

@main
enum RocMindSparkMain {
    static func main() {
        let stamp = "boot \(ISO8601DateFormatter().string(from: Date())) pid=\(ProcessInfo.processInfo.processIdentifier)\n"
        try? stamp.write(to: URL(fileURLWithPath: "/tmp/rms-boot.log"), atomically: true, encoding: .utf8)
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
