import AppKit

/// Tuna for Mac: one window around your Tuna server's interface, with the app's own player
/// underneath, so the music carries on with the window closed and answers the media keys.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var main: MainWindow!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        main = MainWindow()
        main.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { main.showWindow(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        main.audio.stop()
        Tunnel.shared.stop()
    }

    /// The Dock icon's menu: the music's controls, for when the window is closed.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        guard !main.audio.tracks.isEmpty else { return nil }
        let menu = NSMenu()
        menu.addItem(item(main.audio.wantsPlay ? L("Pause") : L("Play"), #selector(togglePlay), ""))
        menu.addItem(item(L("Next"), #selector(nextSong), ""))
        menu.addItem(item(L("Previous"), #selector(previousSong), ""))
        return menu
    }

    // ---------- Menus ----------

    @objc private func changeServer() {
        main.showWindow(nil)
        main.showSetup(error: nil)
    }
    @objc private func goHome() { main.goHome() }
    @objc private func reload() { main.reload() }
    @objc private func goBack() { main.web.goBack() }
    @objc private func showMain() { main.showWindow(nil) }
    @objc private func togglePlay() { main.audio.toggle() }
    @objc private func nextSong() { main.audio.skipNext() }
    @objc private func previousSong() { main.audio.previous() }

    private func buildMenu() {
        let menu = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: L("About Tuna"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(item(L("Change Server…"), #selector(changeServer), ""))
        app.addItem(.separator())
        app.addItem(withTitle: L("Hide Tuna"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: L("Hide Others"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: L("Show All"), action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: L("Quit Tuna"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        add(app, "Tuna", to: menu)

        // Copy/paste etc. only work in the page's text fields if these exist.
        let edit = NSMenu(title: L("Edit"))
        edit.addItem(withTitle: L("Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: L("Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: L("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        add(edit, L("Edit"), to: menu)

        let view = NSMenu(title: L("View"))
        view.addItem(item(L("Reload"), #selector(reload), "r"))
        let fullScreen = view.addItem(withTitle: L("Toggle Full Screen"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        add(view, L("View"), to: menu)

        let go = NSMenu(title: L("Go"))
        go.addItem(item(L("Home"), #selector(goHome), "1"))
        go.addItem(item(L("Back"), #selector(goBack), "["))
        add(go, L("Go"), to: menu)

        let window = NSMenu(title: L("Window"))
        window.addItem(withTitle: L("Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: L("Zoom"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        // Back after closing it (the music plays on meanwhile).
        window.addItem(item("Tuna", #selector(showMain), "0"))
        add(window, L("Window"), to: menu)
        NSApp.windowsMenu = window

        NSApp.mainMenu = menu
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func add(_ submenu: NSMenu, _ title: String, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        menu.addItem(item)
    }
}
