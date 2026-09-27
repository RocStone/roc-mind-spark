import Foundation

/// Pure navigation rules for the overlay's WKWebView. Kept free of WebKit so
/// the decisions can be unit tested.
enum WebPolicy {
    enum NavigationDecision: Equatable {
        case allow
        case download
        case openExternal
        case cancel
    }

    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost"]
    static let externalSchemes: Set<String> = ["http", "https", "mailto"]

    /// `shouldPerformDownload` is WebKit's flag for `<a download>` clicks.
    static func navigation(url: URL?, shouldPerformDownload: Bool, serverPort: Int = AppConfig.port) -> NavigationDecision {
        if shouldPerformDownload { return .download }
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        switch scheme {
        case "blob":
            // A blob: navigation would replace the canvas page with the blob
            // itself. The page only creates blobs for exports, so save them.
            return isServerURL(blobOrigin(of: url), serverPort: serverPort) ? .download : .cancel
        case "about":
            return .allow
        case "http", "https":
            if isServerURL(url, serverPort: serverPort) { return .allow }
            if let host = url.host?.lowercased(), loopbackHosts.contains(host) { return .cancel }
            return .openExternal
        case "mailto":
            return .openExternal
        default:
            return .cancel
        }
    }

    static func canOpenExternally(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return externalSchemes.contains(scheme)
    }

    /// Only the canvas server (http://127.0.0.1:<port>) counts as ours.
    static func isServerURL(_ url: URL?, serverPort: Int = AppConfig.port) -> Bool {
        guard let url, url.scheme?.lowercased() == "http" else { return false }
        return isServerOrigin(host: url.host, port: url.port ?? 80, serverPort: serverPort)
    }

    static func isServerOrigin(host: String?, port: Int, serverPort: Int = AppConfig.port) -> Bool {
        guard let host = host?.lowercased(), loopbackHosts.contains(host) else { return false }
        return port == serverPort
    }

    /// `blob:http://127.0.0.1:3034/<uuid>` → `http://127.0.0.1:3034/<uuid>`.
    static func blobOrigin(of url: URL) -> URL? {
        let text = url.absoluteString
        guard text.lowercased().hasPrefix("blob:") else { return nil }
        return URL(string: String(text.dropFirst(5)))
    }
}
