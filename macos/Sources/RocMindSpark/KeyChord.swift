import AppKit
import Carbon
import Foundation

struct KeyChord: Codable, Equatable, Hashable, Sendable {
    var keyCode: UInt32
    var command: Bool
    var control: Bool
    var option: Bool
    var shift: Bool

    var isHyper: Bool { command && control && option && shift }

    var carbonModifiers: UInt32 {
        var bits: UInt32 = 0
        if command { bits |= UInt32(cmdKey) }
        if control { bits |= UInt32(controlKey) }
        if option { bits |= UInt32(optionKey) }
        if shift { bits |= UInt32(shiftKey) }
        return bits
    }

    var nsModifiers: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if command { flags.insert(.command) }
        if control { flags.insert(.control) }
        if option { flags.insert(.option) }
        if shift { flags.insert(.shift) }
        return flags
    }

    var hasModifier: Bool { command || control || option || shift }

    var display: String {
        let key = Self.keyName(keyCode)
        if isHyper { return "Caps + \(key)" }
        var bits: [String] = []
        if control { bits.append("⌃") }
        if option { bits.append("⌥") }
        if shift { bits.append("⇧") }
        if command { bits.append("⌘") }
        return bits.isEmpty ? key : bits.joined(separator: " ") + " " + key
    }

    var webSpec: [String: Any] {
        [
            "key": Self.jsKey(keyCode),
            "code": Self.jsCode(keyCode),
            "meta": command,
            "ctrl": control,
            "alt": option,
            "shift": shift,
        ]
    }

    static func fromWeb(_ spec: [String: Any]) -> KeyChord? {
        let jsCode = spec["code"] as? String ?? ""
        let jsKey = spec["key"] as? String ?? ""
        guard let keyCode = carbonKeyCode(jsCode: jsCode, jsKey: jsKey) else { return nil }
        return KeyChord(
            keyCode: keyCode,
            command: bool(spec["meta"]),
            control: bool(spec["ctrl"]),
            option: bool(spec["alt"]),
            shift: bool(spec["shift"])
        )
    }

    static func from(event: NSEvent) -> KeyChord? {
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let code = UInt32(event.keyCode)
        if Self.isModifierKeyCode(code) { return nil }
        return KeyChord(
            keyCode: code,
            command: flags.contains(.command),
            control: flags.contains(.control),
            option: flags.contains(.option),
            shift: flags.contains(.shift)
        )
    }

    static let hyperQ = KeyChord(keyCode: 12, command: true, control: true, option: true, shift: true)
    static let optionShiftCommandQ = KeyChord(keyCode: 12, command: true, control: false, option: true, shift: true)
    static let commandComma = KeyChord(keyCode: 43, command: true, control: false, option: false, shift: false)
    static let tab = KeyChord(keyCode: 48, command: false, control: false, option: false, shift: false)
    static let enter = KeyChord(keyCode: 36, command: false, control: false, option: false, shift: false)
    static let f2 = KeyChord(keyCode: 120, command: false, control: false, option: false, shift: false)
    static let delete = KeyChord(keyCode: 51, command: false, control: false, option: false, shift: false)
    static let space = KeyChord(keyCode: 49, command: false, control: false, option: false, shift: false)
    static let letterL = KeyChord(keyCode: 37, command: false, control: false, option: false, shift: false)
    static let commandZ = KeyChord(keyCode: 6, command: true, control: false, option: false, shift: false)
    static let commandShiftZ = KeyChord(keyCode: 6, command: true, control: false, option: false, shift: true)
    static let commandF = KeyChord(keyCode: 3, command: true, control: false, option: false, shift: false)
    static let question = KeyChord(keyCode: 44, command: false, control: false, option: false, shift: true)

    private static func isModifierKeyCode(_ code: UInt32) -> Bool {
        // shift, control, option, command, fn, caps
        [56, 60, 59, 62, 58, 61, 55, 54, 63, 57].contains(code)
    }

    static func keyName(_ code: UInt32) -> String {
        switch code {
        case 36: return "↩"
        case 48: return "Tab"
        case 49: return "Space"
        case 51: return "⌫"
        case 53: return "Esc"
        case 117: return "⌦"
        case 122: return "F1"
        case 120: return "F2"
        case 99: return "F3"
        case 118: return "F4"
        case 96: return "F5"
        case 97: return "F6"
        case 98: return "F7"
        case 100: return "F8"
        case 101: return "F9"
        case 109: return "F10"
        case 103: return "F11"
        case 111: return "F12"
        case 80: return "F19"
        case 123: return "←"
        case 124: return "→"
        case 125: return "↓"
        case 126: return "↑"
        case 43: return ","
        case 44: return "/"
        default:
            if let letter = letterMap[code] { return letter.uppercased() }
            return "Key \(code)"
        }
    }

    static func jsKey(_ code: UInt32) -> String {
        switch code {
        case 36: return "Enter"
        case 48: return "Tab"
        case 49: return " "
        case 51: return "Backspace"
        case 53: return "Escape"
        case 117: return "Delete"
        case 122: return "F1"
        case 120: return "F2"
        case 99: return "F3"
        case 118: return "F4"
        case 123: return "ArrowLeft"
        case 124: return "ArrowRight"
        case 125: return "ArrowDown"
        case 126: return "ArrowUp"
        case 43: return ","
        case 44: return "/"
        default:
            return letterMap[code] ?? ""
        }
    }

    static func jsCode(_ code: UInt32) -> String {
        switch code {
        case 36: return "Enter"
        case 48: return "Tab"
        case 49: return "Space"
        case 51: return "Backspace"
        case 53: return "Escape"
        case 117: return "Delete"
        case 122: return "F1"
        case 120: return "F2"
        case 99: return "F3"
        case 118: return "F4"
        case 123: return "ArrowLeft"
        case 124: return "ArrowRight"
        case 125: return "ArrowDown"
        case 126: return "ArrowUp"
        case 43: return "Comma"
        case 44: return "Slash"
        default:
            if let letter = letterMap[code] { return "Key\(letter.uppercased())" }
            return ""
        }
    }

    private static func bool(_ value: Any?) -> Bool {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        return false
    }

    private static func carbonKeyCode(jsCode: String, jsKey: String) -> UInt32? {
        let table: [String: UInt32] = [
            "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6,
            "KeyX": 7, "KeyC": 8, "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14,
            "KeyR": 15, "KeyY": 16, "KeyT": 17, "KeyO": 31, "KeyU": 32, "KeyI": 34, "KeyP": 35,
            "KeyL": 37, "KeyJ": 38, "KeyK": 40, "KeyN": 45, "KeyM": 46,
            "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
            "Comma": 43, "Slash": 44, "Period": 47, "Minus": 27, "Equal": 24,
            "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96,
            "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        ]
        if let n = table[jsCode] { return n }
        if jsCode.hasPrefix("Key"), let letter = jsCode.dropFirst(3).lowercased().first {
            return letterMap.first(where: { $0.value == String(letter) })?.key
        }
        let key = jsKey.lowercased()
        if let n = letterMap.first(where: { $0.value == key })?.key { return n }
        return nil
    }

    private static let letterMap: [UInt32: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v",
        11: "b", 12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t",
        31: "o", 32: "u", 34: "i", 35: "p", 37: "l", 38: "j", 40: "k",
        45: "n", 46: "m",
    ]
}

enum ShortcutID: String, CaseIterable, Codable, Identifiable {
    case toggleOverlay
    case openSettings
    case addChild
    case addSibling
    case editNode
    case deleteNode
    case collapse
    case link
    case undo
    case redo
    case find
    case help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .toggleOverlay: return L10n.t("shortcut.toggle")
        case .openSettings: return L10n.t("shortcut.openSettings")
        case .addChild: return L10n.t("shortcut.addChild")
        case .addSibling: return L10n.t("shortcut.addSibling")
        case .editNode: return L10n.t("shortcut.editNode")
        case .deleteNode: return L10n.t("shortcut.deleteNode")
        case .collapse: return L10n.t("shortcut.collapse")
        case .link: return L10n.t("shortcut.link")
        case .undo: return L10n.t("shortcut.undo")
        case .redo: return L10n.t("shortcut.redo")
        case .find: return L10n.t("shortcut.find")
        case .help: return L10n.t("shortcut.help")
        }
    }

    var isGlobal: Bool {
        switch self {
        case .toggleOverlay: return true
        default: return false
        }
    }

    var section: String {
        isGlobal ? L10n.t("settings.overlay") : L10n.t("settings.canvas")
    }

    var defaultChord: KeyChord {
        switch self {
        case .toggleOverlay: return .hyperQ
        case .openSettings: return .commandComma
        case .addChild: return .tab
        case .addSibling: return .enter
        case .editNode: return .f2
        case .deleteNode: return .delete
        case .collapse: return .space
        case .link: return .letterL
        case .undo: return .commandZ
        case .redo: return .commandShiftZ
        case .find: return .commandF
        case .help: return .question
        }
    }

    var carbonHotKeyID: UInt32 {
        switch self {
        case .toggleOverlay: return 1
        case .openSettings: return 2
        default: return 100
        }
    }
}
