import AppKit

/// Fire Ring's own folders.
enum FireRingPaths {
    static let data = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Fire Ring", isDirectory: true)
    static let logs = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Fire Ring", isDirectory: true)
    static let config = data.appendingPathComponent("config.json")
    static let updates = data.appendingPathComponent("updates", isDirectory: true)

    /// The app's settings file, as the bridge writes it.
    static func readConfig() -> [String: Any] {
        guard let data = try? Data(contentsOf: config),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}

/// The background bridge: the copy of Node inside the app running
/// bridge/src/main.mjs. It lives as long as the app and is restarted if it stops.
final class BridgeProcess {
    private var process: Process?
    private var stopping = false
    private var quickExits = 0
    private var startedAt = Date()

    private var resources: URL { Bundle.main.resourceURL! }
    private var node: URL { resources.appendingPathComponent("runtime/node") }
    private var script: URL { resources.appendingPathComponent("bridge/src/main.mjs") }
    private var logFile: URL { FireRingPaths.logs.appendingPathComponent("bridge.log") }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    func start() {
        stopping = false
        launch()
    }

    func stop() {
        stopping = true
        process?.terminate()
    }

    private func launch() {
        guard !stopping else { return }
        let manager = FileManager.default
        guard manager.isExecutableFile(atPath: node.path), manager.fileExists(atPath: script.path) else {
            NSLog("Fire Ring: bundled bridge missing at \(resources.path)")
            return
        }
        try? manager.createDirectory(at: FireRingPaths.logs, withIntermediateDirectories: true)
        rotateLog()
        if !manager.fileExists(atPath: logFile.path) { manager.createFile(atPath: logFile.path, contents: nil) }
        guard let log = try? FileHandle(forWritingTo: logFile) else { return }
        log.seekToEndOfFile()

        var environment = ProcessInfo.processInfo.environment
        // The bridge picks its network route from its own settings only.
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy", "NODE_OPTIONS"] {
            environment.removeValue(forKey: key)
        }
        environment["FIRE_RING_VERSION"] = Self.version
        environment["FIRE_RING_REPO"] = Bundle.main.object(forInfoDictionaryKey: "FireRingUpdateRepo") as? String ?? ""
        environment["FIRE_RING_APP_PATH"] = Bundle.main.bundlePath
        environment["FIRE_RING_RESOURCES"] = resources.path
        environment["FIRE_RING_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)

        let process = Process()
        process.executableURL = node
        process.arguments = ["--disable-warning=ExperimentalWarning", script.path]
        process.environment = environment
        process.currentDirectoryURL = resources
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.exited(code: finished.terminationStatus) }
        }
        do {
            startedAt = Date()
            try process.run()
            self.process = process
        } catch {
            NSLog("Fire Ring: could not start the bridge: \(error.localizedDescription)")
        }
    }

    /// Restarts after a short wait that grows while it keeps failing at once.
    /// Exit 3 means another copy already serves the port, so it waits longer.
    private func exited(code: Int32) {
        process = nil
        guard !stopping else { return }
        quickExits = Date().timeIntervalSince(startedAt) < 10 ? quickExits + 1 : 0
        let delay = code == 3 ? 10.0 : min(30.0, pow(2.0, Double(min(quickExits, 5))))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.launch() }
    }

    /// Keeps the log under 5 MB: the older half moves to bridge.log.1.
    private func rotateLog() {
        let manager = FileManager.default
        guard let size = (try? manager.attributesOfItem(atPath: logFile.path))?[.size] as? NSNumber,
              size.intValue > 5_000_000 else { return }
        let older = logFile.appendingPathExtension("1")
        try? manager.removeItem(at: older)
        try? manager.moveItem(at: logFile, to: older)
    }
}

/// Replaces the running app with a downloaded, checked update and reopens it.
enum UpdateInstaller {
    static func install(staged path: String, then quit: @escaping () -> Void) -> String? {
        let manager = FileManager.default
        let staged = URL(fileURLWithPath: path).standardizedFileURL
        let target = URL(fileURLWithPath: Bundle.main.bundlePath).standardizedFileURL
        guard staged.path.hasPrefix(FireRingPaths.updates.standardizedFileURL.path + "/"),
              staged.pathExtension == "app",
              manager.fileExists(atPath: staged.appendingPathComponent("Contents/Info.plist").path) else {
            return "更新文件不在预期的位置"
        }
        guard Bundle(url: staged)?.bundleIdentifier == Bundle.main.bundleIdentifier else {
            return "更新文件不是 Fire Ring"
        }
        guard manager.isWritableFile(atPath: target.deletingLastPathComponent().path) else {
            return "没有权限替换 \(target.path)"
        }
        // Waits for this app to quit, swaps the bundles (putting the old one back
        // if anything fails), and opens the new one.
        let script = """
        pid="$1"; staged="$2"; target="$3"
        while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        backup="$target.previous"
        rm -rf "$backup"
        if mv "$target" "$backup" && mv "$staged" "$target"; then
          rm -rf "$backup"
        else
          [ -d "$target" ] || mv "$backup" "$target"
        fi
        xattr -dr com.apple.quarantine "$target" 2>/dev/null
        open "$target"
        """
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        helper.arguments = ["-c", script, "fire-ring-update", String(ProcessInfo.processInfo.processIdentifier), staged.path, target.path]
        do {
            try helper.run()
        } catch {
            return "无法启动更新：\(error.localizedDescription)"
        }
        quit()
        return nil
    }
}
