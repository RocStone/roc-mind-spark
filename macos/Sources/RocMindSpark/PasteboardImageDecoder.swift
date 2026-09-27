import AppKit

/// Turns what is on the pasteboard into one image payload for the canvas.
/// `Snapshot` reads the pasteboard on the main actor; `decode()` does the
/// expensive work and is safe to run on a background task.
enum PasteboardImageDecoder {
    struct Image: Sendable {
        let data: Data
        let mime: String
    }

    static let pngType = NSPasteboard.PasteboardType.png
    static let jpegType = NSPasteboard.PasteboardType("public.jpeg")
    static let gifType = NSPasteboard.PasteboardType("public.gif")
    static let webpType = NSPasteboard.PasteboardType("public.webp")

    static let imageFileExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
    ]

    struct Snapshot: Sendable {
        var png: Data?
        var jpeg: Data?
        var gif: Data?
        var webp: Data?
        var tiff: Data?
        var pdf: Data?
        var fileURLs: [URL] = []

        @MainActor
        init(board: NSPasteboard) {
            png = board.data(forType: PasteboardImageDecoder.pngType)
            jpeg = board.data(forType: PasteboardImageDecoder.jpegType)
            gif = board.data(forType: PasteboardImageDecoder.gifType)
            webp = board.data(forType: PasteboardImageDecoder.webpType)
            tiff = board.data(forType: .tiff)
            pdf = board.data(forType: .pdf)
            let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ?? []
            fileURLs = urls.compactMap { $0 as? URL }.filter {
                PasteboardImageDecoder.imageFileExtensions.contains($0.pathExtension.lowercased())
            }
        }

        init() {}

        /// Encoded PNG/JPEG bytes need no conversion; pass them through.
        var directImage: Image? {
            if let png, png.count > 32 { return Image(data: png, mime: "image/png") }
            if let jpeg, jpeg.count > 32 { return Image(data: jpeg, mime: "image/jpeg") }
            return nil
        }

        /// Largest image by pixel count among the remaining representations.
        func decode() -> Image? {
            var best: (image: Image, pixels: Int)?
            func consider(_ data: Data?, mime: String) {
                guard let data, data.count > 32 else { return }
                let pixels = NSBitmapImageRep(data: data).map { max(0, $0.pixelsWide * $0.pixelsHigh) } ?? 0
                let current = best?.pixels ?? -1
                if pixels > current || (pixels == current && data.count > (best?.image.data.count ?? 0)) {
                    best = (Image(data: data, mime: mime), pixels)
                }
            }
            consider(gif, mime: "image/gif")
            consider(webp, mime: "image/webp")
            if let tiff { consider(PasteboardImageDecoder.pngData(from: tiff), mime: "image/png") }
            if let pdf, let image = NSImage(data: pdf) {
                consider(PasteboardImageDecoder.pngData(from: image), mime: "image/png")
            }
            for url in fileURLs {
                let ext = url.pathExtension.lowercased()
                if ["heic", "heif", "tif", "tiff", "bmp"].contains(ext) {
                    if let data = try? Data(contentsOf: url), let png = PasteboardImageDecoder.pngData(from: data) {
                        consider(png, mime: "image/png")
                    } else if let image = NSImage(contentsOf: url), let png = PasteboardImageDecoder.pngData(from: image) {
                        consider(png, mime: "image/png")
                    }
                    continue
                }
                consider(try? Data(contentsOf: url), mime: PasteboardImageDecoder.mime(for: ext))
            }
            return best?.image
        }
    }

    static func mime(for ext: String) -> String {
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        default: return "image/png"
        }
    }

    static func pngData(from image: NSImage) -> Data? {
        var best: NSBitmapImageRep?
        for rep in image.representations {
            guard let bitmap = rep as? NSBitmapImageRep else { continue }
            if best == nil || bitmap.pixelsWide * bitmap.pixelsHigh > best!.pixelsWide * best!.pixelsHigh {
                best = bitmap
            }
        }
        if let best, let png = best.representation(using: .png, properties: [:]) { return png }
        guard let tiff = image.tiffRepresentation else { return nil }
        return pngData(from: tiff)
    }

    static func pngData(from data: Data) -> Data? {
        guard let rep = NSBitmapImageRep(data: data) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}
