import AppKit
import ServiceManagement
import WebKit

/// The settings window: connections, network,
/// launch at login and updates. Its content is settings.html on system glass.
final class PreferencesWindow: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow?
    private var web: WKWebView?
    private let tokenScript: () -> WKUserScript
    private let quit: () -> Void
    private var pendingSection: String?
    private var pageReady = false
    private var pendingReveal: (() -> Void)?
    private var closing = false

    init(tokenScript: @escaping () -> WKUserScript, quit: @escaping () -> Void) {
        self.tokenScript = tokenScript
        self.quit = quit
    }

    /// Whether Fire Ring has been opened before (the first launch opens Connections).
    static var onboarded: Bool { FireRingPaths.readConfig()["onboarded"] as? Bool ?? false }

    /// 提前在后台把页面加载好，第一次打开时就不会先出现一块空玻璃。
    func prepare() {
        if window == nil { build() }
    }

    /// 打开时先把 App 切到前台，窗口淡入。若窗口在 App 还没切到前台时就出现，
    /// 系统玻璃会先以「非活动」的暗色显示一下，看起来像闪黑。
    func show(section: String? = nil) {
        if window == nil { build() }
        guard let window else { return }
        pendingSection = section
        if let section { jump(to: section) }
        window.appearance = FireRingTheme.appearance
        NSApp.setActivationPolicy(.regular)   // a normal window wants a Dock icon and ⌘-Tab while open
        NSApp.activate()
        web?.evaluateJavaScript("window.__onShow && window.__onShow()", completionHandler: nil)
        if window.isVisible && window.alphaValue > 0.99 && !closing {
            window.makeKeyAndOrderFront(nil)
            return
        }
        closing = false
        window.alphaValue = 0
        window.center()
        window.makeKeyAndOrderFront(nil)
        let reveal = {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().alphaValue = 1
            }
        }
        if pageReady {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: reveal)
        } else {
            pendingReveal = reveal
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self, let waiting = self.pendingReveal else { return }
                self.pendingReveal = nil
                waiting()
            }
        }
    }

    /// 关闭：短促地淡出，再让窗口失去焦点。
    func closeAnimated() {
        guard let window, window.isVisible, !closing else { return }
        closing = true
        pendingReveal = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.closing else { return }
            window.close()
            self.closing = false
        })
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeAnimated()
        return false
    }

    private func jump(to section: String) {
        let quoted = section.replacingOccurrences(of: "\"", with: "")
        web?.evaluateJavaScript("window.__jump && window.__jump(\"\(quoted)\")", completionHandler: nil)
    }

    private func build() {
        let size = NSSize(width: 560, height: 640)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Fire Ring"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.appearance = FireRingTheme.appearance
        window.isOpaque = false
        window.backgroundColor = .clear
        window.animationBehavior = .none   // 系统的放大缩小动画会拍一张玻璃的快照，显示成黑色；改用淡入淡出
        window.alphaValue = 0
        window.delegate = self

        let controller = WKUserContentController()
        controller.add(self, name: "prefs")
        controller.addUserScript(tokenScript())
        controller.addUserScript(WKUserScript(
            source: "window.__NATIVE__ = \(nativeStateJSON());",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        let web = AcceptsFirstMouseWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        self.web = web

        let background = makeGlass(frame: NSRect(origin: .zero, size: size), cornerRadius: 0, material: .sidebar, content: web, liquid: false)
        background.autoresizingMask = [.width, .height]

        // The page covers the whole window and takes every click, so the window
        // could not be moved. A strip over the empty band at the top moves it.
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        root.autoresizingMask = [.width, .height]
        root.addSubview(background)
        let strip = WindowDragStrip(frame: NSRect(x: 0, y: size.height - 48, width: size.width, height: 48))
        strip.autoresizingMask = [.width, .minYMargin]
        root.addSubview(strip)
        window.contentView = root
        self.window = window

        if let url = Bundle.main.url(forResource: "settings", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let section = pendingSection { jump(to: section) }
        pageReady = true
        if let reveal = pendingReveal {
            pendingReveal = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: reveal)
        }
    }

    func windowWillClose(_ notification: Notification) {
        GlobalHotKey.stopRecording()
        NSApp.setActivationPolicy(.accessory)
    }

    private func nativeStateJSON() -> String {
        let payload: [String: Any] = [
            "loginItem": LoginItem.enabled,
            "loginItemNeedsApproval": LoginItem.needsApproval,
            "hotKeys": GlobalHotKey.state(),
            "appPath": Bundle.main.bundlePath,
            "version": BridgeProcess.version,
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func reply(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.__native && window.__native(\(text))", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        switch kind {
        case "loginItem":
            let error = LoginItem.set(body["on"] as? Bool ?? true)
            reply(["loginItem": LoginItem.enabled, "loginItemNeedsApproval": LoginItem.needsApproval, "error": error ?? NSNull()])
        case "theme":
            window?.appearance = FireRingTheme.appearance(for: body["value"] as? String)
        case "loginPrompt":
            let error = LoginItem.answer(body["choice"] as? String ?? "")
            reply(["loginItem": LoginItem.enabled, "loginItemNeedsApproval": LoginItem.needsApproval, "error": error ?? NSNull()])
        case "hotKeyRecord":
            GlobalHotKey.record { [weak self] error in
                self?.reply(["hotKeys": GlobalHotKey.state(), "hotKeyError": error ?? NSNull()])
            }
        case "hotKeyCancel":
            GlobalHotKey.stopRecording()
            reply(["hotKeys": GlobalHotKey.state(), "hotKeyError": NSNull()])
        case "hotKeyClear":
            GlobalHotKey.stopRecording()
            _ = GlobalHotKey.set(nil)
            reply(["hotKeys": GlobalHotKey.state(), "hotKeyError": NSNull()])
        case "hotKeyEnabled":
            GlobalHotKey.stopRecording()
            let error = GlobalHotKey.setEnabled(body["on"] as? Bool ?? false)
            reply(["hotKeys": GlobalHotKey.state(), "hotKeyError": error ?? NSNull()])
        case "openLoginItemSettings":
            SMAppService.openSystemSettingsLoginItems()
        case "copy":
            if let text = body["text"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        case "openURL":
            if let text = body["url"] as? String, let url = URL(string: text), ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
        case "revealLogs":
            NSWorkspace.shared.activateFileViewerSelecting([FireRingPaths.logs.appendingPathComponent("bridge.log")])
        case "installUpdate":
            guard let staged = body["staged"] as? String else { return }
            if let error = UpdateInstaller.install(staged: staged, then: quit) {
                reply(["installError": error])
            }
        case "playSound":
            AlertCenter.shared.play(body["sound"] as? String ?? "none", volume: (body["volume"] as? NSNumber)?.doubleValue ?? 60)
        case "testAlert":
            AlertCenter.shared.deliver(body)
        case "notifyStatus":
            AlertCenter.shared.permission { [weak self] value in self?.reply(["notify": value]) }
        case "notifyRequest":
            AlertCenter.shared.requestPermission { [weak self] value, error in
                self?.reply(["notify": value, "notifyError": error ?? NSNull()])
            }
        case "openNotificationSettings":
            AlertCenter.shared.openSettings()
        case "saveDiagnostics":
            reply(Diagnostics.save(body["text"] as? String ?? ""))
        case "revealFile":
            if let path = body["path"] as? String, Diagnostics.isOurs(path) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            }
        case "close":
            closeAnimated()
        case "quit":
            quit()
        default:
            break
        }
    }
}

/// 诊断信息存进「下载」文件夹，文件名带上时间。
enum Diagnostics {
    static let prefix = "Fire Ring 诊断信息 "
    static var folder: URL { FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0] }

    static func save(_ text: String) -> [String: Any] {
        guard !text.isEmpty else { return ["diagError": "没有内容"] }
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.dateFormat = "yyyy-MM-dd HHmmss"
        let name = prefix + stamp.string(from: Date()) + ".txt"
        let url = folder.appendingPathComponent(name)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            return ["diagName": name, "diagPath": url.path]
        } catch {
            return ["diagError": error.localizedDescription]
        }
    }

    /// 只允许在访达里显示我们自己存的诊断文件。
    static func isOurs(_ path: String) -> Bool {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        return url.deletingLastPathComponent().path == folder.standardizedFileURL.path
            && url.lastPathComponent.hasPrefix(prefix) && url.pathExtension == "txt"
    }
}

/// An invisible band that drags its window: a press anywhere on it moves the
/// window. (The window has a fixed size, so a double-click does nothing.)
final class WindowDragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

/// The app's menus. A menu-bar app has no menu of its own, but the standard
/// keyboard shortcuts (⌘V, ⌘C, ⌘X, ⌘A, ⌘Z) only work through an Edit menu,
/// so without one nothing could be pasted into the settings window.
func installMainMenu(quit: Selector, target: AnyObject) {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu(title: "Fire Ring")
    let quitItem = NSMenuItem(title: "退出 Fire Ring", action: quit, keyEquivalent: "q")
    quitItem.target = target
    appMenu.addItem(quitItem)
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "编辑")
    edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(redo)
    edit.addItem(.separator())
    edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    NSApp.mainMenu = main
}

/// Launch at login, and whether to ask about it.
///
/// Asked at the top of the menu-bar panel after the first launch,
/// until it is on. "不允许" stops asking for as long as the app keeps running;
/// "以后不再提醒" (saved as loginPrompt: "never" by the page) stops for good.
enum LoginItem {
    static var declinedThisRun = false

    static var enabled: Bool { SMAppService.mainApp.status == .enabled }
    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    @discardableResult
    static func set(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// The answer to the prompt: "allow", "deny" or "never".
    @discardableResult
    static func answer(_ choice: String) -> String? {
        switch choice {
        case "allow": return set(true)
        case "deny", "never": declinedThisRun = true
        default: break
        }
        return nil
    }

    /// Whether the menu-bar panel should ask right now.
    static var shouldAsk: Bool {
        let config = FireRingPaths.readConfig()
        let never = (config["loginPrompt"] as? String) == "never"
        let onboarded = config["onboarded"] as? Bool ?? false
        return onboarded && !enabled && !never && !declinedThisRun
    }
}

/// The colour mode chosen in Settings → General: "dark" (default), "light" or
/// "system". It sets the windows' glass; the pages follow the same setting.
enum FireRingTheme {
    static var appearance: NSAppearance? {
        appearance(for: FireRingPaths.readConfig()["theme"] as? String)
    }

    static func appearance(for theme: String?) -> NSAppearance? {
        switch theme {
        case "light": return NSAppearance(named: .aqua)
        case "system": return nil
        default: return NSAppearance(named: .darkAqua)
        }
    }
}
