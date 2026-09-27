import Foundation

/// Where the download save panel opens: the folder the user picked last
/// time, or ~/Downloads when there is none or it has since gone away.
enum DownloadLocation {
    static let defaultsKey = "download.lastDir"

    static func initialDirectory(
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) -> URL? {
        if let path = defaults.string(forKey: defaultsKey) {
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                return URL(fileURLWithPath: path, isDirectory: true)
            }
        }
        return fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first
    }

    /// Records the folder of the file the user chose to save.
    static func remember(savedFile url: URL, defaults: UserDefaults = .standard) {
        defaults.set(url.deletingLastPathComponent().path, forKey: defaultsKey)
    }
}
