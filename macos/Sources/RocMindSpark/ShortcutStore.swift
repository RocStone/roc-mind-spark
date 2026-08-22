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
    }

    func chord(for id: ShortcutID) -> KeyChord {
        chords[id] ?? id.defaultChord
    }

    func setChord(_ chord: KeyChord, for id: ShortcutID) {
        if id.isGlobal && !chord.hasModifier { return }
        chords[id] = chord
        persist()
    }

    func resetDefaults() {
        chords = Dictionary(uniqueKeysWithValues: ShortcutID.allCases.map { ($0, $0.defaultChord) })
        persist()
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
