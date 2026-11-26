import AppKit
import Carbon
import QuartzCore
import WebKit

// Fire Ring — a notch-shaped island for Claude Code, Codex and DeepSeek Harness.
//
//   collapsed → hugs the notch; counts sit on the two wings
//   a turn ends → the bar grows downward into a card
//   click → opens that conversation
//
// The window is a borderless, non-activating NSPanel at menu-bar level hosting
// a WKWebView. The page is a fixed transparent canvas: only the shape drawn
// inside it animates, because resizing a WKWebView mid-animation stutters and
// flashes. The window keeps the canvas width but is only as tall as the bar
// needs while collapsed, so it does not sit over other apps. It grows to the
// full canvas the moment the pointer arrives or a card is about to open, and
// shrinks back only after the close animation is over. The page is pinned to
// the window's top-left (a flipped view), so resizing never moves it.
// Clicks pass through everything outside the shape.

final class Island: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let canvas = NSSize(width: 560, height: 440)

    private var panel: NSPanel!
    private var web: WKWebView!
    private var screen: NSScreen!

    private var notchWidth: CGFloat = 0
    private var leftWing: CGFloat = 0
    private var rightWing: CGFloat = 0
    private var barHeight: CGFloat = 32
    private var shapeSize = NSSize(width: 176, height: 32)
    private var windowHeight: CGFloat = 60
    private var shrinkWork: DispatchWorkItem?
    private let glowMargin: CGFloat = 28   // below the collapsed bar: its glow and shadow

    private var activity: NSObjectProtocol?
    private var statusItem: NSStatusItem?
    private var hoverTimer: Timer?
    private var pointerMonitors: [Any] = []
    private var lastHoverInside = false
    private var enclosedInside = false
    private var lastMousePoint = NSPoint(x: -1000, y: -1000)
    private var lastPointerSent: CFTimeInterval = 0
    private var watchdog: Timer?
    private var failedChecks = 0
    private var screensAsleep = false
    private var reloadBackoff: CFTimeInterval = 0
    private var nextReloadAt: CFTimeInterval = 0
    private var fullscreenTimer: Timer?
    private var lastFullscreen: Bool?
    private var fullscreenChecking = false
    private var alertSeq: Int?          // the last alert delivered (or already there at launch)
    private var alertTimer: Timer?
    private var hotKey: GlobalHotKey?

    private let settings = SettingsPanel()
    private let bridge = BridgeProcess()
    private lazy var preferences = PreferencesWindow(
        tokenScript: { [unowned self] in self.tokenScript() },
        quit: { [unowned self] in self.quit() }
    )

    func quit() {
        bridge.stop()
        NSApp.terminate(nil)
    }

    @objc func quitFromMenu() {
        quit()
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKey?.unregister()
        bridge.stop()
    }

    /// Opening the app again (from Finder or Launchpad) shows its settings,
    /// since a menu-bar app has no window of its own to bring forward.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        preferences.show()
        return false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One Fire Ring at a time: a second copy hands over to the first.
        let mine = ProcessInfo.processInfo.processIdentifier
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .first(where: { $0.processIdentifier != mine }) {
            other.activate()
            NSApp.terminate(nil)
            return
        }
        bridge.start()
        installMainMenu(quit: #selector(quitFromMenu), target: self)
        // A background-only floating panel is a prime candidate for App Nap,
        // which throttles CSS animations to a visibly low frame rate.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "notch island animation"
        )
        applyScreen()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )

        let controller = WKUserContentController()
        controller.add(self, name: "ui")
        let geometry = "window.__NOTCH__ = \(notchGeometryJSON());"
        controller.addUserScript(
            WKUserScript(source: geometry, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        controller.addUserScript(tokenScript())

        let config = WKWebViewConfiguration()
        config.userContentController = controller

        web = AcceptsFirstMouseWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false
        web.navigationDelegate = self

        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: canvas),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 1)
        // canJoinAllApplications lets it join other apps' full-screen spaces as
        // part of them, instead of being added only after the swipe has finished.
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle, .canJoinAllApplications]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.ignoresMouseEvents = true
        let root = FlippedView(frame: NSRect(origin: .zero, size: canvas))
        root.autoresizesSubviews = false
        web.frame = NSRect(origin: .zero, size: canvas)
        root.addSubview(web)
        panel.contentView = root
        windowHeight = fittedHeight(for: shapeSize)
        positionCanvas()
        panel.orderFrontRegardless()

        guard let url = Bundle.main.url(forResource: "index", withExtension: "html") else {
            NSLog("Fire Ring: index.html missing")
            return
        }
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())

        setupStatusItem()
        hotKey = GlobalHotKey(
            onPanel: { [weak self] in self?.togglePanelFromShortcut() },
            onPreferences: { [weak self] in
                self?.settings.close()
                self?.preferences.show()
            }
        )
        startPointerTracking()
        startWatchdog()
        AlertCenter.shared.start()
        startAlertPolling()
        AlertCenter.shared.openSession = { [weak self] id in
            guard let data = try? JSONSerialization.data(withJSONObject: [id]),
                  let quoted = String(data: data, encoding: .utf8) else { return }
            self?.callJS("window.__openSession && window.__openSession(\(quoted)[0])")
        }
        startFullscreenWatch()
        // 提前把设置页加载好，第一次打开时直接是毛玻璃
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.preferences.prepare() }
        if !PreferencesWindow.onboarded {
            // First launch: open Connections once, so there is a place to start.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.preferences.show(section: "connect")
                self?.postBridge("/config?onboarded=1")
            }
        }
    }

    /// The page hears from the bridge at least every 25 s, so a minute of
    /// silence means it is stuck: reload it. After the Mac wakes, ask again at
    /// once rather than trust a request that slept through the change.
    private func startWatchdog() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            center.addObserver(self, selector: #selector(resync), name: name, object: nil)
        }
        center.addObserver(self, selector: #selector(screensSlept), name: NSWorkspace.screensDidSleepNotification, object: nil)
        watchdog = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.checkPage()
        }
    }

    @objc private func screensSlept() {
        screensAsleep = true
    }

    @objc private func resync() {
        screensAsleep = false
        callJS("window.__resync && window.__resync()")
        settings.resync()
    }

    private func checkPage() {
        // A sleeping screen or a hidden window lets WebKit pause the page; that
        // silence is not a fault, and reloading would not cure it.
        guard !screensAsleep, panel.occlusionState.contains(.visible) else {
            failedChecks = 0
            return
        }
        web.evaluateJavaScript("window.__lastSync ? window.__lastSync() : -1") { [weak self] value, error in
            guard let self else { return }
            let silence = (value as? NSNumber)?.doubleValue ?? -1
            self.failedChecks = error == nil ? 0 : self.failedChecks + 1
            guard silence > 60_000 || self.failedChecks >= 3 else {
                self.reloadBackoff = 0   // healthy again
                return
            }
            // A reload that does not cure it waits longer before the next one:
            // 1, 2, 4 ... up to 15 minutes.
            let now = CACurrentMediaTime()
            guard now >= self.nextReloadAt else { return }
            self.reloadBackoff = min(max(self.reloadBackoff * 2, 60), 900)
            self.nextReloadAt = now + self.reloadBackoff
            NSLog("Fire Ring: page stuck (silent %.0f ms, %d failed checks), reloading", silence, self.failedChecks)
            self.failedChecks = 0
            self.web.reload()
        }
    }

    /// 全屏 App 里刘海怎么显示由页面按设置决定；这里只告诉它现在是不是全屏。
    private func startFullscreenWatch() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification] {
            center.addObserver(self, selector: #selector(checkFullscreen), name: name, object: nil)
        }
        center.addObserver(self, selector: #selector(spaceChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        fullscreenTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkFullscreen()
        }
    }

    // MARK: Alerts

    /// Sounds and notifications come straight from the bridge once a second,
    /// so they do not depend on the notch page, which macOS slows down while
    /// the notch is hidden (a full-screen app) or covered.
    private func startAlertPolling() {
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.pollAlerts() }
        timer.tolerance = 0.2
        RunLoop.main.add(timer, forMode: .common)
        alertTimer = timer
    }

    private func pollAlerts() {
        guard let url = URL(string: Self.bridgeURL + "/alerts") else { return }
        Self.localSession.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let seq = (body["seq"] as? NSNumber)?.intValue else { return }
            let events = body["events"] as? [[String: Any]] ?? []
            DispatchQueue.main.async {
                guard let self else { return }
                // First look, or the bridge restarted: only alerts from now on.
                guard let last = self.alertSeq, seq >= last else { self.alertSeq = seq; return }
                for event in events {
                    guard let n = (event["seq"] as? NSNumber)?.intValue else { continue }
                    self.deliverAlert(seq: n, event: event, via: "App")
                }
            }
        }.resume()
    }

    private func deliverAlert(seq: Int, event: [String: Any], via: String) {
        if let last = alertSeq, seq <= last { return }
        alertSeq = seq
        AlertCenter.shared.deliver(event)
        let note = "[alert] 已发出 #\(seq)（\(via)）"
        if let encoded = note.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { postBridge("/log?m=" + encoded) }
    }

    /// On a new space, bring the island forward at once rather than waiting
    /// for the system to place it.
    @objc private func spaceChanged() {
        guard let panel, panel.alphaValue > 0 else { return }
        panel.orderFrontRegardless()
    }

    /// Listing every window on screen takes a few milliseconds, so it runs off
    /// the main thread and never lands in the middle of an animation frame.
    @objc private func checkFullscreen() {
        guard let screen, !screensAsleep, !fullscreenChecking else { return }
        fullscreenChecking = true
        let frame = screen.frame
        let primaryHeight = NSScreen.screens.first?.frame.height ?? frame.height
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let now = FullscreenWatch.isFullscreen(frame: frame, primaryHeight: primaryHeight)
            DispatchQueue.main.async {
                guard let self else { return }
                self.fullscreenChecking = false
                guard now != self.lastFullscreen else { return }
                self.lastFullscreen = now
                self.callJS("window.__setFullscreen && window.__setFullscreen(\(now))")
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        lastFullscreen = nil   // 页面重新加载后，再告诉它一次
    }

    /// If WebKit's page process dies, the window would stay blank until restart.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("Fire Ring: page process ended, reloading")
        webView.reload()
    }

    private func applyScreen() {
        guard let target = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main else { return }
        screen = target
        barHeight = max(30, target.safeAreaInsets.top)
        if let left = target.auxiliaryTopLeftArea, let right = target.auxiliaryTopRightArea {
            leftWing = left.width
            rightWing = right.width
            notchWidth = target.frame.width - left.width - right.width
        } else {
            // No notch (or an external display): a centred bar that still works.
            notchWidth = 160
            leftWing = 0
            rightWing = 0
        }
    }

    @objc private func screensChanged() {
        applyScreen()
        callJS("window.__setGeometry && window.__setGeometry(\(notchGeometryJSON()))")
        positionCanvas()
    }

    /// Centred under the notch, flush with the top of the screen. The page sits
    /// at the window's top-left, so changing the height never moves it.
    private func positionCanvas() {
        guard let screen, let panel else { return }
        let origin = NSPoint(x: (screen.frame.midX - canvas.width / 2).rounded(), y: screen.frame.maxY - windowHeight)
        panel.setFrame(NSRect(origin: origin, size: NSSize(width: canvas.width, height: windowHeight)), display: false)
    }

    private func fittedHeight(for shape: NSSize) -> CGFloat {
        min(canvas.height, (shape.height + glowMargin).rounded(.up))
    }

    /// Full canvas, before anything starts to grow.
    private func expandWindow() {
        shrinkWork?.cancel()
        guard windowHeight < canvas.height else { return }
        windowHeight = canvas.height
        positionCanvas()
    }

    /// The page reports the shape's target size when an animation starts.
    /// Growing: make room now. Shrinking: wait until the animation is over.
    private func shapeChanged() {
        let target = fittedHeight(for: shapeSize)
        if target > windowHeight { expandWindow(); return }
        shrinkWork?.cancel()
        guard target < windowHeight else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let latest = self.fittedHeight(for: self.shapeSize)
            guard latest < self.windowHeight, !self.lastHoverInside else { return }
            self.windowHeight = latest
            self.positionCanvas()
        }
        shrinkWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)   // the page's longest shape animation is 420 ms
    }

    /// The bridge's shared secret, handed to the pages so a website cannot pose
    /// as them. Whichever of the app and the bridge starts first creates it.
    private func tokenScript() -> WKUserScript {
        let manager = FileManager.default
        let dir = FireRingPaths.data
        let file = dir.appendingPathComponent("token")
        var token = ((try? String(contentsOf: file, encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            token = UUID().uuidString.lowercased()
            try? manager.createDirectory(at: dir, withIntermediateDirectories: true)
            try? token.write(to: file, atomically: true, encoding: .utf8)
            try? manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        return WKUserScript(
            source: "window.__BRIDGE_TOKEN__ = \"\(token)\";",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    /// Every mouse move is handled as it happens, so the island follows the
    /// pointer without waiting for a timer. A window that never becomes key gets
    /// no hover events of its own, so these monitors are the source. The slow
    /// timer only catches the shape growing under a pointer that is not moving.
    private func startPointerTracking() {
        let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: moves, handler: { [weak self] _ in
            self?.pointerChanged()
        }) { pointerMonitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: moves, handler: { [weak self] event in
            self?.pointerChanged()
            return event
        }) { pointerMonitors.append(monitor) }
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.pointerChanged()
        }
    }

    private func shapeContains(_ point: NSPoint) -> Bool {
        guard let screen else { return false }
        let rect = NSRect(
            x: screen.frame.midX - shapeSize.width / 2,
            y: screen.frame.maxY - shapeSize.height,
            width: shapeSize.width,
            height: shapeSize.height
        )
        return rect.insetBy(dx: -2, dy: -2).contains(point)
    }

    private func pointerChanged() {
        guard let panel, panel.alphaValue > 0 else { return }
        let point = NSEvent.mouseLocation
        let moved = hypot(point.x - lastMousePoint.x, point.y - lastMousePoint.y) > 0.5
        lastMousePoint = point

        let inside = shapeContains(point)
        if panel.ignoresMouseEvents == inside { panel.ignoresMouseEvents = !inside }

        // CSS :hover does not fire here either, so the page lights its own rows.
        let now = CACurrentMediaTime()
        if inside && moved && now - lastPointerSent > 0.012 {
            lastPointerSent = now
            callJS("window.__pointer && window.__pointer(\(point.x - panel.frame.minX), \(panel.frame.maxY - point.y))")
        }

        // 黑条长大时把静止的指针圈进来，之后指针一动，才算真正的悬停。
        if inside && moved && enclosedInside {
            enclosedInside = false
            expandWindow()
            callJS("window.__setHover && window.__setHover(true)")
            return
        }
        guard inside != lastHoverInside else { return }

        // 只有指针自己移动进来的才算"悬停进入"。内容变化导致黑条变宽、
        // 把静止的指针圈进来时，不应该弹出刘海面板。
        if inside && !moved {
            lastHoverInside = true
            enclosedInside = true
            return
        }

        enclosedInside = false
        lastHoverInside = inside
        if inside { expandWindow() }
        callJS("window.__setHover && window.__setHover(\(inside))")
        if !inside { shapeChanged() }   // nothing opened: shrink back once the pointer leaves
    }

    /// The flame in the menu bar, beside the notch.
    private func setupStatusItem() {
        // A new icon lands at the far left, against the notch. Start it one slot
        // in; once dragged with ⌘, the system's remembered position wins.
        let positionKey = "NSStatusItem Preferred Position \(Self.statusItemName)"
        if UserDefaults.standard.object(forKey: positionKey) == nil {
            UserDefaults.standard.set(Self.initialStatusItemOffset, forKey: positionKey)
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = Self.statusItemName
        item.isVisible = true
        if let button = item.button {
            button.image = Self.flameIcon()
            button.toolTip = "Fire Ring"
            button.setAccessibilityIdentifier("FireRing.StatusItem")
            button.action = #selector(toggleSettings)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item

        let controller = WKUserContentController()
        controller.add(self, name: "panel")
        controller.addUserScript(tokenScript())
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        settings.load(config: config, delegate: self)
    }

    private static let statusItemName = "FireFlame"
    private static let initialStatusItemOffset = 385.0

    /// One flame curve: control point, control point, end point.
    private typealias FlameCurve = (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)

    /// Three flames nested inside each other, in a 24-unit grid with y running down.
    private static let flameLayers: [(color: NSColor, start: NSPoint, curves: [FlameCurve])] = [
        (
            NSColor(srgbRed: 0.878, green: 0.137, blue: 0.110, alpha: 1),
            NSPoint(x: 12, y: 1),
            [
                (13.2, 5.5, 20, 9, 20, 15.5), (20, 20, 16.4, 23, 12, 23), (7.6, 23, 4, 20, 4, 15.5),
                (4, 12.5, 5.6, 10, 7.5, 8.5), (7.9, 10.3, 8.7, 11.3, 9.9, 11.8), (9.5, 7.8, 10.4, 4, 12, 1),
            ]
        ),
        (
            NSColor(srgbRed: 1.000, green: 0.478, blue: 0.169, alpha: 1),
            NSPoint(x: 12.5, y: 8),
            [
                (13.3, 11, 17, 13, 17, 17), (17, 20.2, 14.8, 22.3, 12, 22.3), (9.2, 22.3, 7, 20.2, 7, 17.2),
                (7, 15.4, 7.9, 14, 9, 13), (9.3, 14.2, 9.8, 14.9, 10.7, 15.3), (10.5, 12.6, 11.2, 10, 12.5, 8),
            ]
        ),
        (
            NSColor(srgbRed: 1.000, green: 0.847, blue: 0.290, alpha: 1),
            NSPoint(x: 12.3, y: 14.5),
            [
                (12.8, 16.2, 14.7, 17.2, 14.7, 19.2), (14.7, 20.8, 13.5, 21.8, 12, 21.8),
                (10.5, 21.8, 9.3, 20.8, 9.3, 19.3), (9.3, 17.7, 11.6, 16.5, 12.3, 14.5),
            ]
        ),
    ]

    /// Red outside, orange inside it, a yellow heart. Not a template image, or
    /// the menu bar would flatten it to one colour.
    private static func flameIcon() -> NSImage {
        let side: CGFloat = 18
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { _ in
            let scale = NSAffineTransform()
            scale.scale(by: side / 24)
            scale.concat()
            for layer in flameLayers {
                let path = NSBezierPath()
                path.move(to: layer.start)
                for (x1, y1, x2, y2, x, y) in layer.curves {
                    path.curve(to: NSPoint(x: x, y: y), controlPoint1: NSPoint(x: x1, y: y1), controlPoint2: NSPoint(x: x2, y: y2))
                }
                path.close()
                layer.color.setFill()
                path.fill()
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "Fire Ring"
        return image
    }

    @objc private func toggleSettings() {
        guard let button = statusItem?.button else { return }
        // 右键，或按住 control 点：弹出菜单。左键照常打开菜单栏面板。
        if let event = NSApp.currentEvent,
           event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            showStatusMenu()
            return
        }
        settings.toggle(relativeTo: button)
    }

    private func togglePanelFromShortcut() {
        if let button = statusItem?.button {
            settings.toggle(relativeTo: button)
        } else {
            preferences.show()
        }
    }

    // MARK: 右键菜单

    private static let bridgeURL = "http://127.0.0.1:47821"

    /// 只连本机后台，不经过任何代理。
    private static let localSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 1
        return URLSession(configuration: config)
    }()

    private func showStatusMenu() {
        settings.close()
        guard let url = URL(string: Self.bridgeURL + "/state") else { return }
        Self.localSession.dataTask(with: url) { [weak self] data, _, _ in
            var counts: (waiting: Int, running: Int)?
            if let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let sessions = body["sessions"] as? [[String: Any]] {
                let status = sessions.compactMap { $0["status"] as? String }
                counts = (status.filter { $0 == "waiting" }.count, status.filter { $0 == "running" }.count)
            }
            DispatchQueue.main.async { self?.popStatusMenu(counts: counts) }
        }.resume()
    }

    private func popStatusMenu(counts: (waiting: Int, running: Int)?) {
        guard let item = statusItem else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        if let counts {
            let text = counts.waiting + counts.running == 0
                ? "没有在等你或在跑的任务"
                : "\(counts.waiting) 个在等你 · \(counts.running) 个在跑"
            let status = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            status.isEnabled = false
            menu.addItem(status)
            menu.addItem(.separator())
        }

        let alerts = FireRingPaths.readConfig()["alerts"] as? [String: Any]
        let pausedUntil = (alerts?["pausedUntil"] as? NSNumber)?.doubleValue ?? 0
        if pausedUntil > Date().timeIntervalSince1970 * 1000 {
            let until = Date(timeIntervalSince1970: pausedUntil / 1000)
            let format = DateFormatter()
            format.locale = Locale(identifier: "zh_CN")
            format.dateFormat = Calendar.current.isDateInToday(until) ? "HH:mm" : "明天 HH:mm"
            let note = NSMenuItem(title: "提醒已暂停，\(format.string(from: until)) 恢复", action: nil, keyEquivalent: "")
            note.isEnabled = false
            menu.addItem(note)
            menu.addItem(menuItem("现在恢复提醒", #selector(resumeAlerts)))
        } else {
            let pause = NSMenuItem(title: "暂停提醒", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            sub.addItem(menuItem("1 小时", #selector(pauseAlertsHour)))
            sub.addItem(menuItem("到明天早上", #selector(pauseAlertsTomorrow)))
            pause.submenu = sub
            menu.addItem(pause)
        }
        menu.addItem(.separator())
        menu.addItem(menuItem("设置…", #selector(openPreferencesFromMenu), key: ","))
        menu.addItem(menuItem("检查更新…", #selector(checkUpdatesFromMenu)))
        menu.addItem(.separator())
        menu.addItem(menuItem("退出 Fire Ring", #selector(quitFromMenu), key: "q"))

        item.menu = menu
        item.button?.performClick(nil)   // 弹出菜单，菜单关掉后再拿掉，左键仍然打开面板
        item.menu = nil
    }

    private func menuItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func postBridge(_ path: String, json: [String: Any]? = nil) {
        guard let url = URL(string: Self.bridgeURL + path) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let json { request.httpBody = try? JSONSerialization.data(withJSONObject: json) }
        Self.localSession.dataTask(with: request).resume()
    }

    @objc private func pauseAlertsHour() {
        postBridge("/alerts/prefs", json: ["pausedUntil": (Date().timeIntervalSince1970 + 3600) * 1000])
    }

    @objc private func pauseAlertsTomorrow() {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        postBridge("/alerts/prefs", json: ["pausedUntil": morning.timeIntervalSince1970 * 1000])
    }

    @objc private func resumeAlerts() {
        postBridge("/alerts/prefs", json: ["pausedUntil": 0])
    }

    @objc private func openPreferencesFromMenu() {
        preferences.show()
    }

    @objc private func checkUpdatesFromMenu() {
        postBridge("/update/check")
        preferences.show(section: "update")
    }

    private func notchGeometryJSON() -> String {
        let payload: [String: Any] = [
            "notchWidth": Double(notchWidth),
            "leftWing": Double(leftWing),
            "rightWing": Double(rightWing),
            "barHeight": Double(barHeight),
            "screenWidth": Double(screen.frame.width),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    /// `open` hands the deep link to whichever app owns it and brings that app
    /// forward. An already running app is raised directly, because macOS may
    /// refuse a plain open request from a background app.
    private func raise(bundle: String) {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return }
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
            NSApp.yieldActivation(to: running)
            running.unhide()
            running.activate(options: [.activateAllWindows])
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        switch kind {
        case "shape":
            let width = (body["width"] as? NSNumber)?.doubleValue ?? Double(shapeSize.width)
            let height = (body["height"] as? NSNumber)?.doubleValue ?? Double(shapeSize.height)
            shapeSize = NSSize(width: width, height: height)
            shapeChanged()
            pointerChanged()
        case "hide":
            // Keep the panel on screen but invisible: an ordered-out WebView is
            // throttled by macOS and its timers stop, so it would never notice
            // being switched back on.
            panel.ignoresMouseEvents = true
            panel.alphaValue = 0
        case "show":
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        case "alert":
            // The notch page forwards alerts too; whichever arrives first plays.
            if let seq = (body["seq"] as? NSNumber)?.intValue { deliverAlert(seq: seq, event: body, via: "刘海页面") }
            else { AlertCenter.shared.deliver(body) }
        case "burn":
            // 清除时的燃烧声：单条「余烬」，全部「呼燃」。音量跟提示音一致。
            let alerts = FireRingPaths.readConfig()["alerts"] as? [String: Any]
            let volume = (alerts?["volume"] as? NSNumber)?.doubleValue ?? 60
            AlertCenter.shared.play(body["scope"] as? String == "all" ? "fr-blaze" : "fr-singe", volume: volume)
        case "closePanel":
            settings.close()
        case "openPanel":
            togglePanelFromShortcut()
        case "loginPrompt":
            LoginItem.answer(body["choice"] as? String ?? "")
        case "openPreferences":
            settings.close()
            preferences.show(section: body["section"] as? String)
        case "panelSize":
            if let height = (body["height"] as? NSNumber)?.doubleValue { settings.setContentHeight(CGFloat(height)) }
        case "openURL":
            if let text = body["url"] as? String, let url = URL(string: text) { NSWorkspace.shared.open(url) }
        case "openApp":
            if let bundle = body["bundle"] as? String { raise(bundle: bundle) }
        case "terminal":
            if let command = body["command"] as? String {
                let escaped = command.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                let script = "tell application \"Terminal\" to do script \"cd ~; " + escaped + "\"\nactivate application \"Terminal\""
                var error: NSDictionary?
                NSAppleScript(source: script)?.executeAndReturnError(&error)
            }
        case "focus":
            if let url = URL(string: "dsh://open") { NSWorkspace.shared.open(url) }
        default:
            break
        }
    }
}

extension Island {
    func callJS(_ script: String) {
        web.evaluateJavaScript(script, completionHandler: nil)
    }
}

/// The menu-bar panel: system glass that springs out of the flame.
final class SettingsPanel {
    private let width: CGFloat = 320
    private let sideMargin: CGFloat = 32   // room for the overshoot and the shadow
    private let topMargin: CGFloat = 8
    private let bottomMargin: CGFloat = 48
    private let cornerRadius: CGFloat = 22

    private let window = KeyablePanel(
        contentRect: NSRect(x: 0, y: -2000, width: 384, height: 756),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
    )
    private let card = NSView()
    private let edgeOutline = CAShapeLayer()
    private let edgeSheen = CAGradientLayer()
    private let edgeSheenMask = CAShapeLayer()
    private let edgeBevel = CAShapeLayer()
    private let edgeRim = CAGradientLayer()
    private let edgeRimMask = CAShapeLayer()
    private var web: WKWebView?
    private let maxContentHeight: CGFloat = 1100  // the page stays this size; the window follows the card
    private var availableHeight: CGFloat = 700    // what fits below the menu bar on this screen
    private var height: CGFloat = 340
    private var heightTarget: CGFloat = 340
    private var heightTween: Timer?
    private var tweenFrom: CGFloat = 340
    private var tweenStart: CFTimeInterval = 0
    private var anchorX: CGFloat = 160
    private var isOpen = false
    private var isOpening = false
    private var clickMonitors: [Any] = []
    private weak var anchorButton: NSStatusBarButton?

    func resync() {
        web?.evaluateJavaScript("window.__resync && window.__resync()", completionHandler: nil)
    }

    func load(config: WKWebViewConfiguration, delegate: WKNavigationDelegate) {
        // The window is only as tall as the card needs (plus its shadow), so the
        // empty space below the card never catches clicks meant for other apps.
        window.setContentSize(NSSize(width: width + sideMargin * 2, height: windowHeight(for: height)))
        window.isFloatingPanel = true
        window.level = .popUpMenu
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.animationBehavior = .none
        window.appearance = FireRingTheme.appearance

        let web = AcceptsFirstMouseWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = delegate
        self.web = web

        // The page never resizes: it stays full height, pinned to the top, and
        // the glass reveals as much of it as the content needs.
        let full = NSRect(x: 0, y: 0, width: width, height: maxContentHeight)
        let clip = NSView(frame: full)
        clip.clipsToBounds = true
        clip.autoresizingMask = [.width, .height]
        web.frame = full
        web.autoresizingMask = [.minYMargin]
        clip.addSubview(web)

        let surface = makeGlass(frame: full, cornerRadius: cornerRadius, material: .popover, content: clip)
        surface.autoresizingMask = [.width, .height]

        card.wantsLayer = true
        card.addSubview(surface)
        card.layer?.shadowColor = NSColor.black.cgColor
        card.layer?.shadowOpacity = 0.35
        card.layer?.shadowRadius = 22
        card.layer?.shadowOffset = CGSize(width: 0, height: -10)
        buildEdge()

        let root = NSView()
        root.wantsLayer = true
        root.addSubview(card)
        window.contentView = root
        applySize()

        // WebKit will not start a page in a view that has never been on screen.
        // Showing it once, invisibly, also means the height is known before the
        // first real open.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.orderFrontRegardless()
        if let url = Bundle.main.url(forResource: "panel", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, !self.isOpen else { return }
            self.window.orderOut(nil)
        }
    }

    /// The page's `--spring` curve, so the glass and the list move together.
    private static let springStops: [CGFloat] = [
        0, 0.058, 0.194, 0.361, 0.529, 0.679, 0.802, 0.897, 0.964, 1.007,
        1.032, 1.044, 1.046, 1.042, 1.035, 1.028, 1.02, 1.013, 1.008, 1,
    ]
    private static let heightTweenDuration: CFTimeInterval = 0.42

    private static func spring(_ progress: CGFloat) -> CGFloat {
        let position = min(max(progress, 0), 1) * CGFloat(springStops.count - 1)
        let index = min(Int(position), springStops.count - 2)
        return springStops[index] + (springStops[index + 1] - springStops[index]) * (position - CGFloat(index))
    }

    func setContentHeight(_ requested: CGFloat) {
        let next = min(requested, availableHeight, maxContentHeight)   // never taller than the screen allows
        guard next > 0, next != heightTarget else { return }
        heightTarget = next
        guard isOpen else {
            jumpToHeight(next)
            return
        }
        tweenFrom = height
        tweenStart = CACurrentMediaTime()
        fitWindow(to: max(height, next), growOnly: true)
        guard heightTween == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.stepHeight() }
        RunLoop.main.add(timer, forMode: .common)
        heightTween = timer
    }

    private func stepHeight() {
        let progress = CGFloat((CACurrentMediaTime() - tweenStart) / Self.heightTweenDuration)
        height = tweenFrom + (heightTarget - tweenFrom) * Self.spring(progress)
        applySize()
        if progress >= 1 {
            heightTween?.invalidate()
            heightTween = nil
            fitWindow(to: heightTarget)
        }
    }

    private func jumpToHeight(_ next: CGFloat) {
        heightTween?.invalidate()
        heightTween = nil
        heightTarget = next
        height = next
        fitWindow(to: next)
        applySize()
    }

    /// Room for the card at this height, its springy overshoot and its shadow.
    private func windowHeight(for cardHeight: CGFloat) -> CGFloat {
        (cardHeight * 1.06 + topMargin + bottomMargin).rounded(.up)
    }

    /// Resizes the window around the card, keeping its top edge where it is.
    private func fitWindow(to cardHeight: CGFloat, growOnly: Bool = false) {
        let next = windowHeight(for: cardHeight)
        let frame = window.frame
        guard next != frame.height, !(growOnly && next < frame.height) else { return }
        window.setFrame(NSRect(x: frame.minX, y: frame.maxY - next, width: frame.width, height: next), display: false)
        applySize()
    }

    private func applySize() {
        card.frame = NSRect(x: sideMargin, y: window.frame.height - topMargin - height, width: width, height: height)
        card.subviews.first?.frame = card.bounds
        card.layer?.shadowPath = roundedPath(inset: 0)
        layoutEdge()
    }

    private func roundedPath(inset: CGFloat) -> CGPath {
        let radius = max(0, cornerRadius - inset)
        return CGPath(
            roundedRect: card.bounds.insetBy(dx: inset, dy: inset),
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        )
    }

    /// What makes it read as a slab of glass rather than a flat sheet: light
    /// catching one corner of the rim, a thin bevel inside it, a soft sheen
    /// across the top, and a dark hairline separating it from what is behind.
    private func buildEdge() {
        guard let layer = card.layer else { return }
        let white = { (alpha: CGFloat) in NSColor.white.withAlphaComponent(alpha).cgColor }

        edgeOutline.fillColor = nil
        edgeOutline.strokeColor = NSColor.black.withAlphaComponent(0.32).cgColor
        edgeOutline.lineWidth = 0.75

        edgeSheen.colors = [white(0.16), white(0.04), white(0)]
        edgeSheen.locations = [0, 0.22, 0.5]
        edgeSheen.startPoint = CGPoint(x: 0.5, y: 1)
        edgeSheen.endPoint = CGPoint(x: 0.5, y: 0)
        edgeSheenMask.fillColor = NSColor.black.cgColor
        edgeSheen.mask = edgeSheenMask

        edgeBevel.fillColor = nil
        edgeBevel.strokeColor = white(0.09)
        edgeBevel.lineWidth = 0.75

        edgeRim.colors = [white(0.78), white(0.22), white(0.08), white(0.16), white(0.46)]
        edgeRim.locations = [0, 0.3, 0.55, 0.75, 1]
        edgeRim.startPoint = CGPoint(x: 0, y: 1)
        edgeRim.endPoint = CGPoint(x: 1, y: 0)
        edgeRimMask.fillColor = nil
        edgeRimMask.strokeColor = NSColor.black.cgColor
        edgeRimMask.lineWidth = 1.25
        edgeRim.mask = edgeRimMask

        for (index, part) in [edgeOutline, edgeSheen, edgeBevel, edgeRim].enumerated() {
            part.zPosition = CGFloat(10 + index)
            layer.addSublayer(part)
        }
    }

    private func layoutEdge() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for part in [edgeOutline, edgeSheen, edgeBevel, edgeRim, edgeSheenMask, edgeRimMask] { part.frame = card.bounds }
        edgeOutline.path = roundedPath(inset: -0.375)
        edgeSheenMask.path = roundedPath(inset: 0)
        edgeBevel.path = roundedPath(inset: 1.75)
        edgeRimMask.path = roundedPath(inset: 0.625)
        CATransaction.commit()
    }

    private func position(below button: NSStatusBarButton) {
        let mouse = NSEvent.mouseLocation
        let activeScreen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        if let buttonWindow = button.window {
            let rect = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
            // An icon hidden by a menu bar manager or pushed behind the notch may report
            // zero width or coordinates off any display; anchor cleanly near top-right then.
            let host = rect.width > 1 ? NSScreen.screens.first { $0.frame.contains(NSPoint(x: rect.midX, y: rect.midY)) } : nil
            let visible = (host ?? activeScreen)?.visibleFrame ?? rect
            let iconX = host == nil ? visible.maxX - width / 2 - 12 : rect.midX
            let cardX = min(max(iconX - width / 2, visible.minX + 8), visible.maxX - width - 8)
            let top = host == nil ? visible.maxY - 6 : min(rect.minY - 6, visible.maxY - 6)
            anchorX = iconX - cardX
            availableHeight = max(240, min(maxContentHeight, top - visible.minY - 12))
            window.setFrameTopLeftPoint(NSPoint(x: cardX - sideMargin, y: top + topMargin))
            return
        }
        guard let visible = activeScreen?.visibleFrame else { return }
        let cardX = max(visible.minX + 8, visible.maxX - width - 12)
        let top = visible.maxY - 6
        anchorX = width / 2
        availableHeight = max(240, min(maxContentHeight, top - visible.minY - 12))
        window.setFrameTopLeftPoint(NSPoint(x: cardX - sideMargin, y: top + topMargin))
    }

    func toggle(relativeTo button: NSStatusBarButton) {
        if isOpen {
            close()
            return
        }
        guard !isOpening else { return }
        // Choose the category and size first, so it opens already the right height.
        isOpening = true
        guard let web else { return }
        window.appearance = FireRingTheme.appearance
        position(below: button)
        let ask = LoginItem.shouldAsk ? "true" : "false"
        web.evaluateJavaScript("window.__setLoginAsk && window.__setLoginAsk(\(ask)); window.__prepareOpen && window.__prepareOpen(\(Int(availableHeight)))") { [weak self] value, _ in
            guard let self else { return }
            self.isOpening = false
            if let next = value as? NSNumber, next.doubleValue > 0 { self.jumpToHeight(CGFloat(next.doubleValue)) }
            self.open(relativeTo: button)
        }
    }

    /// The scale about the top of the card, under the flame.
    private func scaled(_ scale: CGFloat) -> CATransform3D {
        let tx = anchorX, ty = height
        var m = CATransform3DMakeTranslation(-tx, -ty, 0)
        m = CATransform3DConcat(m, CATransform3DMakeScale(scale, scale, 1))
        return CATransform3DConcat(m, CATransform3DMakeTranslation(tx, ty, 0))
    }

    private func open(relativeTo button: NSStatusBarButton) {
        guard let layer = card.layer else { return }
        anchorButton = button
        position(below: button)
        isOpen = true
        layer.removeAllAnimations()
        window.alphaValue = 1
        window.ignoresMouseEvents = false
        window.orderFrontRegardless()
        window.makeKey()
        web?.evaluateJavaScript("window.__onOpen && window.__onOpen()", completionHandler: nil)

        // A damped spring, sampled exactly so the overshoot is the same every time.
        let start: CGFloat = 0.78
        let stiffness = 260.0
        let damping = 0.42
        let omega = stiffness.squareRoot()
        let damped = omega * (1 - damping * damping).squareRoot()
        let duration = 0.62
        let steps = 48
        var values: [NSValue] = []
        var times: [NSNumber] = []
        for i in 0...steps {
            let t = duration * Double(i) / Double(steps)
            let decay = exp(-damping * omega * t)
            let wave = cos(damped * t) + damping * omega / damped * sin(damped * t)
            let scale = 1 - (1 - start) * CGFloat(decay * wave)
            values.append(NSValue(caTransform3D: scaled(scale)))
            times.append(NSNumber(value: Double(i) / Double(steps)))
        }
        let spring = CAKeyframeAnimation(keyPath: "transform")
        spring.values = values
        spring.keyTimes = times
        spring.calculationMode = .linear
        spring.duration = duration
        layer.add(spring, forKey: "open")

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.14
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(fade, forKey: "fadeIn")

        watchOutsideClicks()
    }

    func close() {
        guard isOpen, let layer = card.layer else { return }
        isOpen = false
        clickMonitors.forEach(NSEvent.removeMonitor)
        clickMonitors = []
        layer.removeAllAnimations()

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self, !self.isOpen else { return }
            self.window.alphaValue = 0
            self.window.ignoresMouseEvents = true
            self.window.orderOut(nil)
            layer.removeAllAnimations()
        }
        let shrink = CABasicAnimation(keyPath: "transform")
        shrink.toValue = NSValue(caTransform3D: scaled(0.88))
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.toValue = 0
        for animation in [shrink, fade] {
            animation.duration = 0.18
            animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0, 1, 1)
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
        }
        layer.add(shrink, forKey: "closeTransform")
        layer.add(fade, forKey: "closeFade")
        CATransaction.commit()
    }

    private func watchOutsideClicks() {
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: clicks, handler: { [weak self] _ in
            self?.close()
        }) { clickMonitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: clicks, handler: { [weak self] event in
            guard let self else { return event }
            if event.window === self.window {
                // The margin around the card belongs to this window but looks like nothing.
                if !self.card.frame.contains(event.locationInWindow) { self.close() }
            } else if event.window !== self.anchorButton?.window {
                // Another window of this app, the notch above all, is "elsewhere" too.
                // The flame is left alone, so its own click still toggles the panel.
                self.close()
            }
            return event
        }) { clickMonitors.append(monitor) }
    }
}

/// Top-left origin, so the notch page stays put while the window's height changes.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// A WKWebView that reacts to the very first click, so buttons work without a
/// preceding focusing click.
final class AcceptsFirstMouseWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Global shortcuts the user records in Settings (no Accessibility permission
/// needed). None are set by default: a global shortcut takes the same keys away
/// from every other app.
final class GlobalHotKey {
    enum Action: String, CaseIterable {
        case panel, prefs
        var id: UInt32 { self == .panel ? 1 : 2 }
    }

    struct Combo: Codable {
        let keyCode: UInt32
        let mods: UInt32     // Carbon modifier mask
        let label: String
    }

    static let changed = Notification.Name("FireRing.globalHotKeysChanged")
    private static func key(_ a: Action) -> String { "hotKey." + a.rawValue }

    static func combo(_ a: Action) -> Combo? {
        guard let data = UserDefaults.standard.data(forKey: key(a)) else { return nil }
        return try? JSONDecoder().decode(Combo.self, from: data)
    }

    /// Saves (or clears, with nil) one shortcut and re-registers. Returns why it could not be used.
    static func set(_ a: Action, _ combo: Combo?) -> String? {
        if let combo, let data = try? JSONEncoder().encode(combo) { UserDefaults.standard.set(data, forKey: key(a)) }
        else { UserDefaults.standard.removeObject(forKey: key(a)) }
        var errors: [Action: String] = [:]
        NotificationCenter.default.post(name: changed, object: nil, userInfo: ["reply": { (e: [Action: String]) in errors = e }])
        return errors[a]
    }

    /// What Settings shows: each action's label, or null.
    static func state() -> [String: Any] {
        var out: [String: Any] = [:]
        for a in Action.allCases { out[a.rawValue] = combo(a)?.label ?? NSNull() }
        return out
    }

    /// 0.2.3 测试版只有一个开关（⌥⌘F / ⇧⌥⌘F）；打开过的，换成同样的两个组合。
    static func migrate() {
        let old = "globalHotKeys"
        guard UserDefaults.standard.object(forKey: old) != nil else { return }
        if UserDefaults.standard.bool(forKey: old), combo(.panel) == nil, combo(.prefs) == nil {
            let f = UInt32(kVK_ANSI_F)
            _ = try? UserDefaults.standard.set(JSONEncoder().encode(Combo(keyCode: f, mods: UInt32(optionKey | cmdKey), label: "⌥⌘F")), forKey: key(.panel))
            _ = try? UserDefaults.standard.set(JSONEncoder().encode(Combo(keyCode: f, mods: UInt32(shiftKey | optionKey | cmdKey), label: "⇧⌥⌘F")), forKey: key(.prefs))
        }
        UserDefaults.standard.removeObject(forKey: old)
    }

    // MARK: Recording

    private static var monitor: Any?
    static var isRecording: Bool { monitor != nil }

    /// Waits for the next key press in Fire Ring's own windows. Esc cancels.
    /// The shortcuts are paused meanwhile, so pressing a current one records it.
    static func record(_ a: Action, done: @escaping (_ error: String?) -> Void) {
        stopRecording()
        NotificationCenter.default.post(name: changed, object: nil, userInfo: ["pause": true])
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == UInt16(kVK_Escape) {
                stopRecording()
                done(nil)
                return nil
            }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard !flags.intersection([.command, .option, .control]).isEmpty else {
                NSSound.beep()
                return nil   // keep waiting: a shortcut needs ⌘, ⌥ or ⌃
            }
            var mods: UInt32 = 0
            var label = ""
            if flags.contains(.control) { mods |= UInt32(controlKey); label += "⌃" }
            if flags.contains(.option) { mods |= UInt32(optionKey); label += "⌥" }
            if flags.contains(.shift) { mods |= UInt32(shiftKey); label += "⇧" }
            if flags.contains(.command) { mods |= UInt32(cmdKey); label += "⌘" }
            label += keyName(event)
            stopRecording(resume: false)
            done(set(a, Combo(keyCode: UInt32(event.keyCode), mods: mods, label: label)))
            return nil
        }
    }

    static func stopRecording(resume: Bool = true) {
        if let monitor { NSEvent.removeMonitor(monitor) }
        let was = monitor != nil
        monitor = nil
        if was && resume { NotificationCenter.default.post(name: changed, object: nil) }
    }

    private static let named: [Int: String] = [
        kVK_Space: "空格", kVK_Return: "↩", kVK_Tab: "⇥", kVK_Delete: "⌫", kVK_ForwardDelete: "⌦",
        kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
        kVK_Home: "↖", kVK_End: "↘", kVK_PageUp: "⇞", kVK_PageDown: "⇟",
        kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4", kVK_F5: "F5", kVK_F6: "F6",
        kVK_F7: "F7", kVK_F8: "F8", kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12",
    ]

    private static func keyName(_ event: NSEvent) -> String {
        if let name = named[Int(event.keyCode)] { return name }
        let base = event.characters(byApplyingModifiers: []) ?? event.charactersIgnoringModifiers ?? "?"
        return base.uppercased()
    }

    // MARK: Registration

    private static let signature: OSType = 0x46524E47 // 'FRNG'
    private var refs: [Action: EventHotKeyRef] = [:]
    private var handlerRef: EventHandlerRef?
    private let handlers: [Action: () -> Void]
    private var observer: NSObjectProtocol?

    init(onPanel: @escaping () -> Void, onPreferences: @escaping () -> Void) {
        handlers = [.panel: onPanel, .prefs: onPreferences]
        Self.migrate()
        installHandler()
        _ = registerAll()
        observer = NotificationCenter.default.addObserver(forName: Self.changed, object: nil, queue: nil) { [weak self] note in
            guard let self else { return }
            self.unregisterAll()
            if note.userInfo?["pause"] as? Bool == true { return }
            let errors = self.registerAll()
            (note.userInfo?["reply"] as? ([Action: String]) -> Void)?(errors)
        }
    }

    private func installHandler() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let callback: EventHandlerUPP = { _, event, userData in
            guard let event, let userData else { return noErr }
            var hkID = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            guard status == noErr, hkID.signature == GlobalHotKey.signature else { return noErr }
            let target = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async {
                if let action = Action.allCases.first(where: { $0.id == hkID.id }) { target.handlers[action]?() }
            }
            return noErr
        }
        InstallEventHandler(GetApplicationEventTarget(), callback, 1, &eventType, selfPtr, &handlerRef)
    }

    /// Registers every recorded shortcut; returns the ones another app already holds.
    private func registerAll() -> [Action: String] {
        var errors: [Action: String] = [:]
        var seen: [String: Action] = [:]
        for a in Action.allCases {
            guard let c = Self.combo(a) else { continue }
            let sig = "\(c.keyCode):\(c.mods)"
            if seen[sig] != nil { errors[a] = c.label + " 已经用在另一项上了"; continue }
            seen[sig] = a
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(c.keyCode, c.mods, EventHotKeyID(signature: Self.signature, id: a.id),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[a] = ref } else { errors[a] = c.label + " 已被别的软件占用" }
        }
        return errors
    }

    private func unregisterAll() {
        for ref in refs.values { UnregisterEventHotKey(ref) }
        refs = [:]
    }

    func unregister() {
        unregisterAll()
        if let h = handlerRef { RemoveEventHandler(h); handlerRef = nil }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        unregister()
    }
}

let island = Island()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = island
app.run()
