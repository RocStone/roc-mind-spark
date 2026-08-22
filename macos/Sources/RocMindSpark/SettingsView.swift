import AppKit
import SwiftUI

struct SettingsView: View {
    @Bindable var store: ShortcutStore
    var onChange: () -> Void

    @State private var listening: ShortcutID?
    @State private var loginEnabled = LoginItem.isEnabled
    @State private var loginError: String?
    @State private var conflictText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(L10n.t("settings.title"))
                .font(titleFont)

            section(L10n.t("settings.startup")) {
                Toggle(isOn: loginBinding) {
                    Text(L10n.t("settings.login"))
                        .font(bodyFont)
                }
                .toggleStyle(.checkbox)
                if let loginError {
                    Text(loginError)
                        .font(smallFont)
                        .foregroundStyle(.red)
                }
                Text(L10n.t("settings.login.help"))
                    .font(smallFont)
                    .foregroundStyle(.secondary)
            }

            section(L10n.t("settings.overlay")) {
                ForEach(ShortcutID.allCases.filter(\.isGlobal)) { id in
                    shortcutRow(id)
                }
                Text(L10n.t("settings.overlay.help"))
                    .font(smallFont)
                    .foregroundStyle(.secondary)
            }

            section(L10n.t("settings.canvas")) {
                ForEach(ShortcutID.allCases.filter { !$0.isGlobal }) { id in
                    shortcutRow(id)
                }
            }

            if let conflictText {
                Text(conflictText)
                    .font(smallFont)
                    .foregroundStyle(.orange)
            }

            HStack {
                Spacer()
                Button(L10n.t("settings.reset")) {
                    store.resetDefaults()
                    listening = nil
                    conflictText = nil
                    onChange()
                }
                .font(bodyFont)
            }
        }
        .padding(22)
        .frame(minWidth: 460, idealWidth: 500)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { loginEnabled = LoginItem.isEnabled }
    }

    private var titleFont: Font {
        L10n.isChinese ? .custom("PingFang SC", size: 20).weight(.semibold) : .system(size: 20, weight: .semibold)
    }
    private var bodyFont: Font {
        L10n.isChinese ? .custom("PingFang SC", size: 13) : .system(size: 13)
    }
    private var smallFont: Font {
        L10n.isChinese ? .custom("PingFang SC", size: 12) : .system(size: 12)
    }

    private var loginBinding: Binding<Bool> {
        Binding(
            get: { loginEnabled },
            set: { newValue in
                do {
                    try LoginItem.setEnabled(newValue)
                    loginEnabled = LoginItem.isEnabled
                    loginError = nil
                } catch {
                    loginError = error.localizedDescription
                    loginEnabled = LoginItem.isEnabled
                }
            }
        )
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(smallFont.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func shortcutRow(_ id: ShortcutID) -> some View {
        HStack {
            Text(id.title)
                .font(bodyFont)
            Spacer()
            Button {
                listening = (listening == id) ? nil : id
                conflictText = nil
            } label: {
                Text(listening == id ? L10n.t("settings.press") : store.chord(for: id).display)
                    .font(bodyFont)
                    .monospacedDigit()
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(listening == id ? Color.accentColor.opacity(0.18) : Color(nsColor: .controlBackgroundColor))
                    .clipShape(.rect(cornerRadius: 6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(listening == id ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .background(ShortcutCatcher(
            active: listening == id,
            onCancel: { listening = nil },
            onChord: { event in
                guard let chord = KeyChord.from(event: event) else { return }
                if id.isGlobal && !chord.hasModifier {
                    conflictText = L10n.t("settings.needModifier")
                    listening = nil
                    return
                }
                if id == .toggleOverlay && chord == .commandComma {
                    listening = nil
                    return
                }
                if let other = store.conflict(for: id, chord: chord) {
                    conflictText = String(format: L10n.t("settings.conflict"), other.title)
                    listening = nil
                    return
                }
                store.setChord(chord, for: id)
                listening = nil
                conflictText = nil
                onChange()
            }
        ))
    }
}

/// Invisible catcher: when a row is listening, the next key-down becomes the shortcut.
private struct ShortcutCatcher: NSViewRepresentable {
    var active: Bool
    var onCancel: () -> Void
    var onChord: (NSEvent) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onChord = onChord
        view.onCancel = onCancel
        return view
    }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.onChord = onChord
        view.onCancel = onCancel
        view.active = active
    }

    final class CatcherView: NSView {
        var onChord: ((NSEvent) -> Void)?
        var onCancel: (() -> Void)?
        var monitor: Any?
        var active = false {
            didSet { sync() }
        }

        override func viewDidMoveToWindow() { sync() }
        override func viewWillMove(toWindow newWindow: NSWindow?) {
            if newWindow == nil { stop() }
        }

        private func stop() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }

        private func sync() {
            stop()
            guard active, window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53 {
                    self?.onCancel?()
                    return nil
                }
                self?.onChord?(event)
                return nil
            }
        }
    }
}

@MainActor
final class SettingsController {
    private var window: NSWindow?

    func show(store: ShortcutStore, onChange: @escaping () -> Void) {
        if window == nil {
            let root = SettingsView(store: store, onChange: onChange)
            let host = NSHostingController(rootView: root)
            let win = NSWindow(contentViewController: host)
            win.styleMask = [.titled, .closable]
            win.title = L10n.t("settings.window")
            win.titlebarAppearsTransparent = false
            win.isReleasedWhenClosed = false
            win.center()
            window = win
        } else if let host = window?.contentViewController as? NSHostingController<SettingsView> {
            host.rootView = SettingsView(store: store, onChange: onChange)
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
