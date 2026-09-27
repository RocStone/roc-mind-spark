import Foundation
import Observation

@MainActor
@Observable
final class ShortcutStore {
    static let shared = ShortcutStore()

    private let defaultsKey = "shortcuts.v1"
    private(set) var chords: [ShortcutID: KeyChord]

    private init() {
        if let data = UserDefaults.standard.data(forKey: defaultsKey),
           let raw = try? JSONDecoder().decode([String: KeyChord].self, from: data) {
            var loaded: [ShortcutID: KeyChord] = [:]
            for id in ShortcutID.allCases {
                loaded[id] = raw[id.rawValue] ?? id.defaultChord
            }
            chords = loaded
        } else {
            chords = Dictionary(uniqueKeysWithValues: ShortcutID.allCases.map { ($0, $0.defaultChord) })
        }
        migrateBrokenToggleIfNeeded()
    }

    /// ⌥⇧⌘Q was a short-lived public default that never matched Caps-as-Hyper
    /// (all four modifiers). ⌘, is reserved for in-overlay settings and was
    /// bindable by accident, which then toggled the whole overlay.
    /// Runs once per install (`shortcuts.migrated.v1`). Recording and
    /// `setChord` reject the same chords, so they cannot come back later.
    private func migrateBrokenToggleIfNeeded() {
        let flag = "shortcuts.migrated.v1"
        guard !UserDefaults.standard.bool(forKey: flag) else { return }
        UserDefaults.standard.set(true, forKey: flag)
        guard let toggle = chords[.toggleOverlay],
              Self.rejection(for: toggle, id: .toggleOverlay) != nil else { return }
        chords[.toggleOverlay] = .hyperQ
        persist()
    }

    enum Rejection: Equatable {
        case needsModifier
        /// ⌥⇧⌘Q is macOS "Log Out immediately"; ⌘, opens in-overlay settings.
        case reserved
    }

    nonisolated static func rejection(for chord: KeyChord, id: ShortcutID) -> Rejection? {
        if id.isGlobal && !chord.hasModifier { return .needsModifier }
        if id.isGlobal && (chord == .optionShiftCommandQ || chord == .commandComma) { return .reserved }
        return nil
    }

    func chord(for id: ShortcutID) -> KeyChord {
        chords[id] ?? id.defaultChord
    }

    /// False when the chord is not allowed for `id`; nothing changes then.
    @discardableResult
    func setChord(_ chord: KeyChord, for id: ShortcutID) -> Bool {
        if Self.rejection(for: chord, id: id) != nil { return false }
        chords[id] = chord
        persist()
        NotificationCenter.default.post(name: .rmsShortcutsDidChange, object: nil)
        return true
    }

    /// Put back a chord that is known to work after registering a new one
    /// failed. No change notification: the caller rebinds it itself.
    func restoreChord(_ chord: KeyChord, for id: ShortcutID) {
        chords[id] = chord
        persist()
    }

    func resetDefaults() {
        chords = Dictionary(uniqueKeysWithValues: ShortcutID.allCases.map { ($0, $0.defaultChord) })
        persist()
        NotificationCenter.default.post(name: .rmsShortcutsDidChange, object: nil)
    }

    func conflict(for id: ShortcutID, chord: KeyChord) -> ShortcutID? {
        chords.first(where: { $0.key != id && $0.value == chord })?.key
    }

    func webPayload() -> [String: Any] {
        var out: [String: Any] = [:]
        for id in ShortcutID.allCases where !id.isGlobal {
            out[id.rawValue] = chord(for: id).webSpec
        }
        return out
    }

    func webJSON() -> String {
        let data = (try? JSONSerialization.data(withJSONObject: webPayload(), options: [])) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func persist() {
        let raw = Dictionary(uniqueKeysWithValues: chords.map { ($0.key.rawValue, $0.value) })
        if let data = try? JSONEncoder().encode(raw) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
