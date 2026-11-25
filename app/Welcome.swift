import AppKit
import WebKit

/// The very first launch: the "fire" signature writes itself on a small glass
/// card in the middle of the screen, then fades away. Shown once, ever.
final class WelcomeSignature: NSObject, WKScriptMessageHandler {
    private static let shownKey = "FireRingWelcomeShown"
    private static var current: WelcomeSignature?

    private var window: NSPanel?
    private var then: (() -> Void)?

    /// Plays the signature if it has never played, then calls `then`.
    static func showOnce(then: @escaping () -> Void) {
        guard !UserDefaults.standard.bool(forKey: shownKey) else {
            then()
            return
        }
        UserDefaults.standard.set(true, forKey: shownKey)
        let welcome = WelcomeSignature()
        current = welcome
        welcome.present(then: then)
    }

    /// 设置里的「重新看欢迎引导」：不管看过没有，再放一次。
    static func replay(then: @escaping () -> Void) {
        guard current == nil else { return }
        let welcome = WelcomeSignature()
        current = welcome
        welcome.present(then: then)
    }

    private func present(then: @escaping () -> Void) {
        self.then = then
        let size = NSSize(width: 420, height: 300)
        let screen = NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.visibleFrame ?? NSRect(origin: .zero, size: size)
        let origin = NSPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2 + 40)

        let panel = NSPanel(
            contentRect: NSRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let controller = WKUserContentController()
        controller.add(self, name: "welcome")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.autoresizingMask = [.width, .height]

        let glass = makeGlass(frame: NSRect(origin: .zero, size: size), cornerRadius: 28, material: .hudWindow, content: web)
        panel.contentView = glass
        window = panel

        if let url = Bundle.main.url(forResource: "welcome", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.35
            panel.animator().alphaValue = 1
        }
        // Never stay up if the page cannot say it is done.
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in self?.finish() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        finish()
    }

    private func finish() {
        guard let panel = window else { return }
        window = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.45
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            panel.orderOut(nil)
            self?.then?()
            self?.then = nil
            WelcomeSignature.current = nil
        })
    }
}
