import AppKit
import XCTest
@testable import RocMindSpark

final class PasteboardImageDecoderTests: XCTestCase {
    private func bitmap(_ w: Int, _ h: Int) -> NSBitmapImageRep {
        NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )!
    }

    func testPNGIsPassedThroughUnchanged() {
        let png = bitmap(4, 4).representation(using: .png, properties: [:])!
        var snap = PasteboardImageDecoder.Snapshot()
        snap.png = png
        snap.tiff = bitmap(40, 40).tiffRepresentation
        XCTAssertEqual(snap.directImage?.data, png)
        XCTAssertEqual(snap.directImage?.mime, "image/png")
    }

    func testTIFFOnlyIsConvertedToPNG() {
        var snap = PasteboardImageDecoder.Snapshot()
        snap.tiff = bitmap(8, 6).tiffRepresentation
        XCTAssertNil(snap.directImage)
        let image = snap.decode()
        XCTAssertEqual(image?.mime, "image/png")
        let rep = image.flatMap { NSBitmapImageRep(data: $0.data) }
        XCTAssertEqual(rep?.pixelsWide, 8)
        XCTAssertEqual(rep?.pixelsHigh, 6)
    }

    func testEmptySnapshotHasNoImage() {
        let snap = PasteboardImageDecoder.Snapshot()
        XCTAssertNil(snap.directImage)
        XCTAssertNil(snap.decode())
    }
}
