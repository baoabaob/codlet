import AppKit
import Foundation

private struct RuntimePin: Decodable {
    struct Platform: Decodable { let version: String? }
    let version: String
    let platforms: [String: Platform]
}

final class Launcher: NSObject, NSApplicationDelegate {
    private let resources = Bundle.main.resourceURL!
    private let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Codlet")
    private var core: Process?
    private var setup: Process?
    private var status: NSStatusItem?
    private var panel: NSPanel?
    private var gui: NSButton!
    private var ui: NSButton!
    private var desktop: NSButton!
    private var shortcut: NSButton!
    private var startButton: NSButton!
    private var setupLabel: NSTextField!
    private var stopping = false
    private var launchAfterSetup = true
    private var waitingForClientExit = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--packaging-smoke-test") {
            do {
                let pin = try JSONDecoder().decode(RuntimePin.self, from: Data(contentsOf: resources.appendingPathComponent("runtime/node-runtime.json")))
                guard pin.platforms["darwin-arm64"] != nil, FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("codlet").path) else { exit(2) }
                print("Native launcher resources verified; no client or user configuration was opened.")
                exit(0)
            } catch { fputs("\(error)\n", stderr); exit(2) }
        }
        if Bundle.main.bundlePath.hasPrefix("/Volumes/") || Bundle.main.bundlePath.contains("/AppTranslocation/") {
            _ = alert("请先安装 Codlet", "将 Codlet.app 拖入 Applications，再从应用程序文件夹打开。")
            NSApp.terminate(nil); return
        }
        let duplicates = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!).filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if let existing = duplicates.first { existing.activate(options: [.activateIgnoringOtherApps]); NSApp.terminate(nil); return }
        makeMenu()
        if !FileManager.default.fileExists(atPath: home.appendingPathComponent("macos-setup.json").path) { configure() }
        else { prepareLaunch() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let panel { panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        else if core != nil { NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").first?.activate(options: [.activateIgnoringOtherApps]) }
        return true
    }
    private func makeMenu() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status?.button?.title = "Codlet"
        let menu = NSMenu()
        for (title, action) in [("选择官方插件…", #selector(configure)), ("打开日志文件夹", #selector(openLogs)), ("退出 Codlet", #selector(quit))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; menu.addItem(item)
        }
        status?.menu = menu
    }
    private func alert(_ title: String, _ message: String, buttons: [String] = ["好"]) -> NSApplication.ModalResponse {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
        buttons.forEach { alert.addButton(withTitle: $0) }
        return alert.runModal()
    }
    @objc private func configure() {
        guard setup == nil else { return }
        guard !waitingForClientExit else { return }
        if let panel { panel.makeKeyAndOrderFront(nil); return }
        launchAfterSetup = core == nil
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 430), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "欢迎使用 Codlet"; window.center()
        let view = window.contentView!
        let firstSetup = !FileManager.default.fileExists(atPath: home.appendingPathComponent("macos-setup.json").path)
        func label(_ text: String, _ y: CGFloat, _ height: CGFloat, _ size: CGFloat) -> NSTextField {
            let label = NSTextField(wrappingLabelWithString: text)
            label.font = .systemFont(ofSize: size); label.frame = NSRect(x: 28, y: y, width: 504, height: height); view.addSubview(label); return label
        }
        _ = label("按你的方式设置 Codlet", 373, 30, 24)
        _ = label(firstSetup ? "选择需要的官方插件。全部取消可仅使用 Core 和 CLI。\n安装后也可以通过菜单栏重新选择。" : "仅勾选本次希望补装的插件。已安装插件的设置会保留。\n取消勾选不会删除插件，已移除插件不会自动恢复。", 317, 48, 14)
        func checkbox(_ text: String, _ y: CGFloat, _ checked: Bool) -> NSButton {
            let box = NSButton(checkboxWithTitle: text, target: self, action: #selector(syncDependencies))
            box.frame = NSRect(x: 28, y: y, width: 504, height: 30); box.state = checked ? .on : .off; view.addSubview(box); return box
        }
        gui = checkbox("Codlet GUI · 图形化管理插件", 271, firstSetup)
        ui = checkbox("UI Adapter · 侧栏与插件页面（GUI 必需）", 235, firstSetup)
        desktop = checkbox("Desktop Adapter · 客户端与对话接口", 199, firstSetup)
        shortcut = checkbox("在桌面创建 Codlet 快捷入口", 153, false)
        setupLabel = label("所选插件将获得其声明的界面访问或插件管理权限。\n这是未经 Apple 公证的预览版，使用前请确认来源。", 86, 55, 12)
        setupLabel.textColor = .secondaryLabelColor
        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelSetup))
        cancel.frame = NSRect(x: 324, y: 28, width: 92, height: 32); view.addSubview(cancel)
        startButton = NSButton(title: launchAfterSetup ? "设置并打开" : "安装所选插件", target: self, action: #selector(initialize))
        startButton.keyEquivalent = "\r"; startButton.frame = NSRect(x: 420, y: 28, width: 112, height: 32); view.addSubview(startButton)
        panel = window; syncDependencies(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func cancelSetup() {
        guard setup == nil else { return }
        panel?.close(); panel = nil
        if core == nil { NSApp.terminate(nil) }
    }
    @objc private func syncDependencies() { if gui.state == .on { ui.state = .on }; ui.isEnabled = gui.state != .on }
    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment; env["CODLET_HOME"] = home.path; return env
    }
    private func logHandle(_ name: String) throws -> FileHandle {
        let directory = home.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let handle = try FileHandle(forWritingTo: file); try handle.seekToEnd(); return handle
    }
    @objc private func initialize() {
        guard setup == nil else { return }
        do {
            let pin = try JSONDecoder().decode(RuntimePin.self, from: Data(contentsOf: resources.appendingPathComponent("runtime/node-runtime.json")))
            let version = pin.platforms["darwin-arm64"]?.version ?? pin.version
            let process = Process(); process.executableURL = resources.appendingPathComponent("runtime/node-v\(version)-darwin-arm64/bin/node")
            var arguments = [resources.appendingPathComponent("initialize.mjs").path]
            for (box, id) in [(ui!, "codex.ui.adapter"), (desktop!, "codex.desktop.adapter"), (gui!, "codlet-gui")] { if box.state == .on { arguments.append(id) } }
            process.arguments = arguments; process.environment = environment()
            let log = try logHandle("macos-setup.log"); process.standardOutput = log; process.standardError = log
            process.terminationHandler = { [weak self] process in
                try? log.close()
                DispatchQueue.main.async { self?.setupFinished(process.terminationStatus) }
            }
            setup = process; startButton.isEnabled = false; setupLabel.stringValue = "正在校验并初始化所选插件…"
            try process.run()
        } catch { setup = nil; startButton.isEnabled = true; _ = alert("无法初始化 Codlet", error.localizedDescription) }
    }
    private func setupFinished(_ result: Int32) {
        setup = nil; startButton.isEnabled = true
        if result != 0 {
            if alert("初始化未完成", "详细原因保存在 macos-setup.log。已存在的插件设置会保留，可查看日志后重试。", buttons: ["打开日志", "返回"]) == .alertFirstButtonReturn { openLogs() }
            return
        }
        if shortcut.state == .on {
            do {
                let desktopURL = try FileManager.default.url(for: .desktopDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
                let alias = desktopURL.appendingPathComponent("Codlet.app")
                if !FileManager.default.fileExists(atPath: alias.path) { try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: Bundle.main.bundleURL) }
            } catch { _ = alert("快捷入口未创建", "Codlet 已完成设置。\(error.localizedDescription)") }
        }
        panel?.close(); panel = nil
        if launchAfterSetup { prepareLaunch() }
        else if core == nil { NSApp.terminate(nil) }
    }
    private func prepareLaunch() {
        guard core == nil, !waitingForClientExit else { return }
        let clients = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
        guard !clients.isEmpty else { launch(); return }
        let answer = alert("Codex 仍在运行", "请先完成并保存正在进行的任务。继续会请求 Codex 正常退出，最多等待 15 秒；你也可以取消后自行退出。", buttons: ["请求正常退出", "取消"])
        guard answer == .alertFirstButtonReturn else { NSApp.terminate(nil); return }
        waitingForClientExit = true
        clients.forEach { _ = $0.terminate() }
        let deadline = Date().addingTimeInterval(15)
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            if clients.allSatisfy({ $0.isTerminated }) { timer.invalidate(); self.waitingForClientExit = false; self.launch() }
            else if Date() >= deadline {
                timer.invalidate()
                self.waitingForClientExit = false
                _ = self.alert("Codex 尚未退出", "Codlet 没有强制结束任何任务。请在 Codex 中处理保存或退出提示，再打开 Codlet。")
                NSApp.terminate(nil)
            }
        }
    }
    private func launch() {
        guard core == nil else { return }
        do {
            let process = Process(); process.executableURL = resources.appendingPathComponent("codlet")
            process.arguments = ["launch"]; process.environment = environment()
            let log = try logHandle("macos-launch.log"); process.standardOutput = log; process.standardError = log
            process.terminationHandler = { [weak self] process in
                try? log.close()
                DispatchQueue.main.async {
                    guard let self else { return }; self.core = nil
                    if process.terminationStatus != 0 && !self.stopping {
                        if self.alert("Codlet 未能正常运行", "请检查已安装的官方 Codex 版本和 macos-launch.log 中的具体原因。", buttons: ["打开日志", "关闭"]) == .alertFirstButtonReturn { self.openLogs() }
                    }
                    if self.setup == nil { NSApp.terminate(nil) }
                }
            }
            core = process; try process.run(); status?.button?.title = "Codlet"
        } catch { core = nil; _ = alert("无法打开 Codlet", error.localizedDescription); NSApp.terminate(nil) }
    }
    @objc private func openLogs() { NSWorkspace.shared.open(home.appendingPathComponent("logs")) }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if setup?.isRunning == true { _ = alert("正在完成初始化", "初始化包含有时限的命令，请完成后再退出。"); return .terminateCancel }
        guard let core, core.isRunning else { return .terminateNow }
        if stopping { return .terminateCancel }
        guard alert("退出 Codlet？", "这会正常停止本次 Codlet 会话及其启动的 Codex。请先完成正在进行的任务。", buttons: ["退出", "取消"]) == .alertFirstButtonReturn else { return .terminateCancel }
        stopping = true; core.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, self.core?.isRunning == true else { return }
            self.stopping = false
            _ = self.alert("Codlet 仍在清理", "应用保持响应，没有强制结束任务。请处理 Codex 中的退出提示；可稍后再次退出。")
        }
        return .terminateCancel
    }
}

let application = NSApplication.shared
let delegate = Launcher()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
