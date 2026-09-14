#!/usr/bin/env swift
// make-icon.swift: renders the Sipper app icon and writes a macOS AppIcon.appiconset.
//
//   swift tools/make-icon.swift <output appiconset dir>      (or `make icon`)
//
// Draws a 1024x1024 master (the macOS squircle with a subtle teal-to-slate gradient and a
// white "phone.fill" SF Symbol), downsamples it to every size macOS needs and writes the
// PNGs plus a Contents.json into the given directory, creating it if necessary.

import AppKit
import ImageIO
import UniformTypeIdentifiers

// MARK: - Design constants

let canvas: CGFloat = 1024
/// Apple's macOS icon template: an 824pt body centred on a 1024pt canvas (~10% transparent margin).
let bodyInset: CGFloat = 100
/// Corner radius as a fraction of the body side (185.4pt on 824pt in Apple's template).
let cornerRadiusFraction: CGFloat = 0.225
/// Width of the visible handset glyph relative to the squircle body.
let glyphWidthFraction: CGFloat = 0.55
let symbolName = "phone.fill"
let gradientTop = (r: 0.149, g: 0.502, b: 0.541)     // teal  #268089
let gradientBottom = (r: 0.133, g: 0.282, b: 0.353)  // slate #22485A

/// The (points, scale) slots a macOS appiconset must contain.
let iconSlots: [(size: Int, scale: Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
]

// MARK: - Helpers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func makeContext(width: Int, height: Int) -> CGContext {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fail("Could not create a \(width)x\(height) bitmap context")
    }
    ctx.interpolationQuality = .high
    return ctx
}

/// Continuous-curvature rounded rectangle matching the macOS/iOS icon shape. Each corner is three
/// cubic Béziers (the widely used iOS squircle fit); the curve leaves the edge 1.5287·r from the corner.
func squirclePath(in rect: CGRect, cornerRadius r: CGFloat) -> CGPath {
    let k: CGFloat = 1.52866483
    let segments: [(c1: CGPoint, c2: CGPoint, to: CGPoint)] = [
        (CGPoint(x: 1.08849323, y: 0), CGPoint(x: 0.86840689, y: 0), CGPoint(x: 0.63149379, y: 0.07491139)),
        (CGPoint(x: 0.37282383, y: 0.16905956), CGPoint(x: 0.16905956, y: 0.37282383), CGPoint(x: 0.07491139, y: 0.63149379)),
        (CGPoint(x: 0, y: 0.86840689), CGPoint(x: 0, y: 1.08849323), CGPoint(x: 0, y: k)),
    ]
    let (x0, y0, x1, y1) = (rect.minX, rect.minY, rect.maxX, rect.maxY)
    let path = CGMutablePath()
    // Places the unit corner (running from k·r along one edge to k·r along the next) via `map`.
    func corner(_ map: (CGFloat, CGFloat) -> CGPoint) {
        for s in segments {
            path.addCurve(to: map(s.to.x * r, s.to.y * r),
                          control1: map(s.c1.x * r, s.c1.y * r),
                          control2: map(s.c2.x * r, s.c2.y * r))
        }
    }
    path.move(to: CGPoint(x: x0 + k * r, y: y0))
    path.addLine(to: CGPoint(x: x1 - k * r, y: y0))
    corner { u, v in CGPoint(x: x1 - u, y: y0 + v) }  // bottom-right
    path.addLine(to: CGPoint(x: x1, y: y1 - k * r))
    corner { u, v in CGPoint(x: x1 - v, y: y1 - u) }  // top-right
    path.addLine(to: CGPoint(x: x0 + k * r, y: y1))
    corner { u, v in CGPoint(x: x0 + u, y: y1 - v) }  // top-left
    path.addLine(to: CGPoint(x: x0, y: y0 + k * r))
    corner { u, v in CGPoint(x: x0 + v, y: y0 + u) }  // bottom-left
    path.closeSubpath()
    return path
}

/// Bounding box, in image pixel coordinates (origin top-left), of the non-transparent pixels.
func visibleBounds(of ctx: CGContext) -> CGRect? {
    guard let data = ctx.data else { return nil }
    let bytes = data.assumingMemoryBound(to: UInt8.self)
    let (w, h, stride) = (ctx.width, ctx.height, ctx.bytesPerRow)
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
        for x in 0..<w where bytes[y * stride + x * 4 + 3] > 0 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    guard maxX >= minX, maxY >= minY else { return nil }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

/// Renders the SF Symbol at `pointSize`, tints it white and crops it to its visible pixels.
func renderGlyph(pointSize: CGFloat) -> CGImage {
    let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .medium)
    guard let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
            .withSymbolConfiguration(config) else {
        fail("SF Symbol \"\(symbolName)\" is not available on this system")
    }
    let width = Int(ceil(symbol.size.width)), height = Int(ceil(symbol.size.height))
    let bounds = CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
    let ctx = makeContext(width: width, height: height)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    symbol.draw(in: bounds)
    NSGraphicsContext.restoreGraphicsState()

    // Keep the symbol's coverage only and paint it white.
    ctx.setBlendMode(.sourceIn)
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(bounds)

    guard let image = ctx.makeImage(), let visible = visibleBounds(of: ctx),
          let cropped = image.cropping(to: visible) else {
        fail("SF Symbol \"\(symbolName)\" rendered no pixels")
    }
    return cropped
}

func renderMaster() -> CGImage {
    let size = Int(canvas)
    let ctx = makeContext(width: size, height: size)
    let body = CGRect(x: bodyInset, y: bodyInset, width: canvas - 2 * bodyInset, height: canvas - 2 * bodyInset)

    // Squircle filled with a vertical gradient (teal at the top, slate at the bottom).
    ctx.saveGState()
    ctx.addPath(squirclePath(in: body, cornerRadius: body.width * cornerRadiusFraction))
    ctx.clip()
    let colours = [gradientTop, gradientBottom].map { CGColor(srgbRed: $0.r, green: $0.g, blue: $0.b, alpha: 1) }
    guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                                    colors: colours as CFArray, locations: [0, 1]) else {
        fail("Could not create the background gradient")
    }
    ctx.drawLinearGradient(gradient, start: CGPoint(x: body.midX, y: body.maxY),
                           end: CGPoint(x: body.midX, y: body.minY), options: [])
    ctx.restoreGState()

    // Handset glyph: measure once, then re-render at the point size that makes the visible glyph
    // exactly the target width so it is composited 1:1 without resampling.
    let targetWidth = body.width * glyphWidthFraction
    let probe = renderGlyph(pointSize: 256)
    let glyph = renderGlyph(pointSize: 256 * targetWidth / CGFloat(probe.width))
    let origin = CGPoint(x: ((canvas - CGFloat(glyph.width)) / 2).rounded(),
                         y: ((canvas - CGFloat(glyph.height)) / 2).rounded())
    ctx.draw(glyph, in: CGRect(origin: origin, size: CGSize(width: glyph.width, height: glyph.height)))

    guard let image = ctx.makeImage() else { fail("Could not rasterise the icon") }
    return image
}

func downscale(_ image: CGImage, to pixels: Int) -> CGImage {
    if image.width == pixels && image.height == pixels { return image }
    let ctx = makeContext(width: pixels, height: pixels)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
    guard let scaled = ctx.makeImage() else { fail("Could not downscale the icon to \(pixels)px") }
    return scaled
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("Could not create \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("Could not write \(url.path)") }
}

// MARK: - Main

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fail("usage: swift tools/make-icon.swift <output appiconset dir>")
}
let outputDir = URL(fileURLWithPath: arguments[1])

do {
    try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    let master = renderMaster()
    var images: [[String: String]] = []
    for slot in iconSlots {
        let pixels = slot.size * slot.scale
        let filename = "icon_\(slot.size)x\(slot.size)" + (slot.scale == 1 ? "" : "@\(slot.scale)x") + ".png"
        writePNG(downscale(master, to: pixels), to: outputDir.appendingPathComponent(filename))
        images.append(["filename": filename, "idiom": "mac", "scale": "\(slot.scale)x", "size": "\(slot.size)x\(slot.size)"])
        print("wrote \(filename) (\(pixels)x\(pixels))")
    }
    let contents: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
    let json = try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
    try (json + Data("\n".utf8)).write(to: outputDir.appendingPathComponent("Contents.json"))
    print("wrote Contents.json")
} catch {
    fail("make-icon failed: \(error.localizedDescription)")
}
