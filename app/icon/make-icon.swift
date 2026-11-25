// Draws Fire Ring's app icon: the three-layer flame on a dark ember tile.
//
//   swift app/icon/make-icon.swift app/icon/AppIcon-1024.png
//   app/icon/make-icns.sh        (turns it into app/AppIcon.icns)
//
// The flame is the same mark as in the menu bar and the settings window.
import AppKit

let side: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { fatalError("no bitmap") }
NSGraphicsContext.saveGraphicsState()
let context = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = context
let cg = context.cgContext

// macOS icon grid: an 824-pt tile centred in the 1024 canvas.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let radius: CGFloat = 186
let tilePath = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

// Soft drop shadow under the tile, as system icons have.
cg.saveGState()
cg.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.45).cgColor)
cg.addPath(tilePath)
cg.setFillColor(NSColor.black.cgColor)
cg.fillPath()
cg.restoreGState()

let rgb = { (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) in CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a) }
let space = CGColorSpace(name: CGColorSpace.sRGB)!

cg.saveGState()
cg.addPath(tilePath)
cg.clip()
// Base: near-black, warmer towards the bottom where the fire sits.
let base = CGGradient(colorsSpace: space, colors: [rgb(22, 20, 26, 1), rgb(13, 12, 16, 1), rgb(38, 16, 10, 1)] as CFArray, locations: [0, 0.55, 1])!
cg.drawLinearGradient(base, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
// Ember glow behind the flame.
let glow = CGGradient(colorsSpace: space, colors: [rgb(255, 122, 43, 0.55), rgb(224, 35, 28, 0.18), rgb(224, 35, 28, 0)] as CFArray, locations: [0, 0.45, 1])!
cg.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 430), startRadius: 0, endCenter: CGPoint(x: 512, y: 430), endRadius: 430, options: [])
// Glass rim: a light top edge fading away.
let sheen = CGGradient(colorsSpace: space, colors: [rgb(255, 255, 255, 0.16), rgb(255, 255, 255, 0)] as CFArray, locations: [0, 1])!
cg.drawLinearGradient(sheen, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 700), options: [])
cg.restoreGState()

cg.saveGState()
cg.addPath(tilePath.copy(strokingWithWidth: 3, lineCap: .round, lineJoin: .round, miterLimit: 1))
cg.clip()
let rim = CGGradient(colorsSpace: space, colors: [rgb(255, 255, 255, 0.35), rgb(255, 255, 255, 0.06), rgb(255, 160, 90, 0.25)] as CFArray, locations: [0, 0.5, 1])!
cg.drawLinearGradient(rim, start: CGPoint(x: 100, y: 924), end: CGPoint(x: 924, y: 100), options: [])
cg.restoreGState()

// The flame, in its 24-unit grid with y running down.
typealias Curve = (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
let layers: [(CGColor, CGPoint, [Curve])] = [
    (rgb(224, 35, 28, 1), CGPoint(x: 12, y: 1), [
        (13.2, 5.5, 20, 9, 20, 15.5), (20, 20, 16.4, 23, 12, 23), (7.6, 23, 4, 20, 4, 15.5),
        (4, 12.5, 5.6, 10, 7.5, 8.5), (7.9, 10.3, 8.7, 11.3, 9.9, 11.8), (9.5, 7.8, 10.4, 4, 12, 1),
    ]),
    (rgb(255, 122, 43, 1), CGPoint(x: 12.5, y: 8), [
        (13.3, 11, 17, 13, 17, 17), (17, 20.2, 14.8, 22.3, 12, 22.3), (9.2, 22.3, 7, 20.2, 7, 17.2),
        (7, 15.4, 7.9, 14, 9, 13), (9.3, 14.2, 9.8, 14.9, 10.7, 15.3), (10.5, 12.6, 11.2, 10, 12.5, 8),
    ]),
    (rgb(255, 216, 74, 1), CGPoint(x: 12.3, y: 14.5), [
        (12.8, 16.2, 14.7, 17.2, 14.7, 19.2), (14.7, 20.8, 13.5, 21.8, 12, 21.8),
        (10.5, 21.8, 9.3, 20.8, 9.3, 19.3), (9.3, 17.7, 11.6, 16.5, 12.3, 14.5),
    ]),
]
let scale: CGFloat = 24        // 24 units → 576 pt
let origin = CGPoint(x: 512 - 12 * scale, y: 512 + 12 * scale + 6)
func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * scale, y: origin.y - y * scale) }

cg.saveGState()
cg.setShadow(offset: .zero, blur: 60, color: rgb(255, 110, 40, 0.7))
cg.beginTransparencyLayer(auxiliaryInfo: nil)
for (color, start, curves) in layers {
    let path = CGMutablePath()
    path.move(to: point(start.x, start.y))
    for (x1, y1, x2, y2, x, y) in curves {
        path.addCurve(to: point(x, y), control1: point(x1, y1), control2: point(x2, y2))
    }
    path.closeSubpath()
    cg.addPath(path)
    cg.setFillColor(color)
    cg.fillPath()
}
cg.endTransparencyLayer()
cg.restoreGState()

NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
try png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
