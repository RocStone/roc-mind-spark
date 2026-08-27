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
    static let rmsShortcutsDidChange = Notification.Name("com.roc.mindspark.shortcuts")
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
        "settings.overlay.help": "Default is Caps + Q when Caps Lock is Hyper (⌃⌥⇧⌘Q). Change it here if you want a different chord.",
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
        "error.title": "Could not start the canvas",
        "error.starting": "Starting the canvas…",
        "error.retry": "Retry",
        "error.node": "Could not find node. Roc Mind Spark needs Node.js 22.13.0 or later to run the local canvas server.\n\nInstall Node.js 22.13.0+, then tap Retry.",
        "error.server": "Could not find server.js: %@\n\nThen tap Retry.",
        "error.timeout": "The canvas server did not become ready. See %@\n\nThen tap Retry.",
        "error.port": "Port %d is already in use by another process (pid %d: %@).\n\nRoc Mind Spark will not take it over or stop that process.\n\nFree the port, then tap Retry.",
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
        "settings.overlay.help": "Caps Lock 映射成 Hyper（⌃⌥⇧⌘）时，默认是 Caps + Q。可在这里改成别的组合。",
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
        "error.title": "画布无法启动",
        "error.starting": "正在启动画布…",
        "error.retry": "重试",
        "error.node": "找不到 node。需要 Node.js 22.13.0 或更高版本，用来运行画布服务。\n\n装好 Node.js 22.13.0+ 后点重试。",
        "error.server": "找不到 server.js：%@\n\n然后点重试。",
        "error.timeout": "服务启动超时。看 %@\n\n然后点重试。",
        "error.port": "端口 %d 已被其他进程占用（pid %d：%@）。\n\nRoc Mind Spark 不会接管或结束那个进程。\n\n释放端口后点重试。",
    ]
}
