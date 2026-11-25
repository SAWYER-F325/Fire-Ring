import AppKit
import UserNotifications

/// 刘海之外的提醒：提示音和 macOS 系统通知。
///
/// 要不要提醒、用哪个声音、写什么字，都由后台按设置决定，这里只照做。
/// 原创音效随 App 放在 Resources/sounds，macOS 自带的直接用系统声音。
final class AlertCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AlertCenter()

    /// 点了某条通知：打开对应的对话。
    var openSession: ((String) -> Void)?

    private var playing: NSSound?
    private static let soundID = try! NSRegularExpression(pattern: "^(fr-[a-z]+|mac-[A-Za-z]+)$")

    func start() {
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: 提示音

    func play(_ id: String, volume: Double) {
        guard volume > 0, Self.soundID.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil else { return }
        var sound: NSSound?
        if id.hasPrefix("mac-") {
            sound = (NSSound(named: NSSound.Name(String(id.dropFirst(4))))?.copy() as? NSSound)
        } else if let url = Bundle.main.url(forResource: id, withExtension: "m4a", subdirectory: "sounds") {
            sound = NSSound(contentsOf: url, byReference: true)
        }
        guard let sound else {
            NSLog("Fire Ring: sound %@ not found", id)
            return
        }
        playing?.stop()
        sound.volume = Float(max(0, min(1, volume / 100)))
        sound.play()
        playing = sound
    }

    // MARK: 系统通知

    /// "granted"、"denied" 或 "unknown"（还没问过）。
    func permission(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let value: String
            switch settings.authorizationStatus {
            case .authorized, .provisional: value = "granted"
            case .denied: value = "denied"
            default: value = "unknown"
            }
            DispatchQueue.main.async { done(value) }
        }
    }

    func requestPermission(_ done: @escaping (String, String?) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, error in
            let message = error?.localizedDescription
            if let message { NSLog("Fire Ring: notification permission failed: %@", message) }
            self.permission { done($0, message) }
        }
    }

    func openSettings() {
        let id = Bundle.main.bundleIdentifier ?? "dev.firering.app"
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=" + id) {
            NSWorkspace.shared.open(url)
        }
    }

    /// 发一条通知；没有权限就不发。声音由 Fire Ring 自己放，通知本身不带声音。
    func post(title: String, body: String, session: String?) {
        permission { value in
            guard value == "granted" else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if let session { content.userInfo = ["session": session] }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request) { error in
                if let error { NSLog("Fire Ring: notification failed: %@", error.localizedDescription) }
            }
        }
    }

    /// 后台产生的一条提醒，或设置里的「试一下」。
    func deliver(_ body: [String: Any]) {
        let volume = (body["volume"] as? NSNumber)?.doubleValue ?? 60
        play(body["sound"] as? String ?? "none", volume: volume)
        if body["notify"] as? Bool == true {
            post(
                title: String((body["title"] as? String ?? "Fire Ring").prefix(120)),
                body: String((body["body"] as? String ?? "").prefix(240)),
                session: body["session"] as? String
            )
        }
    }

    // Fire Ring 的设置窗口在前面时，通知也照常显示。
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let session = response.notification.request.content.userInfo["session"] as? String {
            DispatchQueue.main.async { self.openSession?(session) }
        }
        completionHandler()
    }
}

/// 刘海所在的屏幕上，现在是不是一个全屏 App（看视频、全屏写代码）。
enum FullscreenWatch {
    static func isFullscreen(on screen: NSScreen) -> Bool {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        // 窗口位置用的是左上角为原点的坐标
        let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let frame = screen.frame
        let target = CGRect(x: frame.minX, y: primaryHeight - frame.maxY, width: frame.width, height: frame.height)
        let mine = ProcessInfo.processInfo.processIdentifier
        for window in windows {
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  (window[kCGWindowOwnerPID as String] as? Int32) != mine,
                  let dict = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict) else { continue }
            if abs(bounds.minX - target.minX) < 1, abs(bounds.minY - target.minY) < 1,
               abs(bounds.width - target.width) < 1, abs(bounds.height - target.height) < 1 {
                return true
            }
        }
        return false
    }
}
