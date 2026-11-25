import AppKit

/// System glass behind `content`: Liquid Glass on macOS 26 and later, the
/// classic frosted material before that. Building with an older SDK, which
/// does not know Liquid Glass, always gives the frosted one.
///
/// `liquid: false` always gives the classic frosted glass, kept active even when
/// the window is not in front. A whole window uses it: Liquid Glass cannot blur
/// while the window fades or while the Dock's minimize animation takes its
/// snapshot, and shows a dark sheet instead.
func makeGlass(frame: NSRect, cornerRadius: CGFloat, material: NSVisualEffectView.Material, content: NSView, liquid: Bool = true) -> NSView {
    #if compiler(>=6.2)
    if #available(macOS 26.0, *), liquid {
        let glass = NSGlassEffectView(frame: frame)
        glass.cornerRadius = cornerRadius
        glass.contentView = content
        return glass
    }
    #endif
    let blur = NSVisualEffectView(frame: frame)
    blur.material = material
    blur.blendingMode = .behindWindow
    blur.state = .active
    if cornerRadius > 0 {
        blur.wantsLayer = true
        blur.layer?.cornerRadius = cornerRadius
        blur.layer?.masksToBounds = true
    }
    content.frame = blur.bounds
    content.autoresizingMask = [.width, .height]
    blur.addSubview(content)
    return blur
}
