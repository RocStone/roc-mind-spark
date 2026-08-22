import Foundation

enum AppLanguage: String {
    case english = "en"
    case chinese = "zh"

    static let defaultsKey = "app.language"

    static var current: AppLanguage {
        get {
            AppLanguage(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "en") ?? .english
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey)
            NotificationCenter.default.post(name: .rmsLanguageDidChange, object: nil)
        }
    }

    static func from(_ raw: String?) -> AppLanguage {
        switch raw {
        case "zh", "zh-CN", "zh-Hans": return .chinese
        default: return .english
        }
    }

    var isChinese: Bool { self == .chinese }
}

extension Notification.Name {
    static let rmsLanguageDidChange = Notification.Name("com.roc.mindspark.language")
}

enum L10n {
    static var isChinese: Bool { AppLanguage.current.isChinese }

    static func t(_ key: String) -> String {
        (isChinese ? zh : en)[key] ?? en[key] ?? key
    }

    private static let en: [String: String] = [
        "menu.toggle": "Show / Hide",
        "menu.settings": "Settings…",
        "menu.quit": "Quit",
        "settings.title": "Settings",
        "settings.window": "Roc Mind Spark Settings",
        "settings.startup": "Startup",
        "settings.login": "Launch at login",
        "settings.login.help": "Starts the menu bar extra and warms the canvas after you log in. The hotkey only brings the already-painted window forward.",
        "settings.overlay": "Overlay",
        "settings.overlay.help": "Default is ⌥ ⇧ ⌘ Q (Option-Shift-Command-Q). It is a busy chord on purpose — change it here if you want something simpler.",
        "settings.canvas": "Canvas",
        "settings.reset": "Restore defaults",
        "settings.press": "Press a key…",
        "settings.needModifier": "Global shortcuts need at least one modifier key.",
        "settings.conflict": "Conflicts with “%@”.",
        "shortcut.toggle": "Show / Hide",
        "shortcut.openSettings": "Open settings",
        "shortcut.addChild": "Add child",
        "shortcut.addSibling": "Add sibling",
        "shortcut.editNode": "Edit node",
        "shortcut.deleteNode": "Delete node",
        "shortcut.collapse": "Collapse / expand",
        "shortcut.link": "Cross-link",
        "shortcut.undo": "Undo",
        "shortcut.redo": "Redo",
        "shortcut.find": "Find",
        "shortcut.help": "Shortcut list",
        "error.node": "Could not find node. Roc Mind Spark needs Node 22+ to run the local canvas server.",
        "error.server": "Could not find server.js: %@",
        "error.timeout": "The canvas server did not become ready. See %@",
    ]

    private static let zh: [String: String] = [
        "menu.toggle": "显示 / 隐藏",
        "menu.settings": "设置…",
        "menu.quit": "退出",
        "settings.title": "设置",
        "settings.window": "Roc Mind Spark 设置",
        "settings.startup": "启动",
        "settings.login": "登录时启动",
        "settings.login.help": "登录后菜单栏会自己起来并预热页面。热键只把已经画好的窗口推到前面。",
        "settings.overlay": "浮层",
        "settings.overlay.help": "默认 ⌥ ⇧ ⌘ Q（Option + Shift + Command + Q）。和弦比较满，可在这里改成更好按的组合。",
        "settings.canvas": "画布",
        "settings.reset": "恢复默认",
        "settings.press": "按下新按键…",
        "settings.needModifier": "全局快捷键至少要带一个修饰键。",
        "settings.conflict": "和「%@」冲突。",
        "shortcut.toggle": "显示 / 隐藏",
        "shortcut.openSettings": "打开设置",
        "shortcut.addChild": "添加子节点",
        "shortcut.addSibling": "添加同级节点",
        "shortcut.editNode": "编辑节点",
        "shortcut.deleteNode": "删除节点",
        "shortcut.collapse": "折叠 / 展开",
        "shortcut.link": "交叉连接",
        "shortcut.undo": "撤销",
        "shortcut.redo": "重做",
        "shortcut.find": "查找",
        "shortcut.help": "快捷键列表",
        "error.node": "找不到 node。需要 Node 22+，用来跑画布服务。",
        "error.server": "找不到 server.js：%@",
        "error.timeout": "服务启动超时。看 %@",
    ]
}
