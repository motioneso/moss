import AppKit
import Combine
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let connection = ConnectionRuntime()
    private let permissions = PermissionsService()
    private let loginItem = LoginItemService()
    private let updater = UpdaterService()

    private var menuBarController: MenuBarController?
    private var onboardingWindowController: NSWindowController?
    private var settingsWindowController: NSWindowController?
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        permissions.refresh()
        connection.start()

        connection.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                self.updater.setAutomaticChecksEnabled(state != .disconnected)
            }
            .store(in: &cancellables)

        connection.$lastDiagnostic
            .compactMap { $0 }
            .receive(on: DispatchQueue.main)
            .sink { message in
                let alert = NSAlert()
                alert.messageText = "Logged out on this Mac"
                alert.informativeText = message
                alert.addButton(withTitle: "Dismiss")
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
            .store(in: &cancellables)

        menuBarController = MenuBarController(
            connection: connection,
            onOpenSettings: { [weak self] in self?.showSettings() },
            onOpenOnboarding: { [weak self] in self?.showOnboarding() },
            onCheckForUpdates: { [weak self] in self?.updater.checkForUpdates() }
        )

        if case .notLinked = connection.state {
            showOnboarding()
        }
    }

    private func showOnboarding() {
        if let onboardingWindowController {
            onboardingWindowController.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let viewModel = OnboardingViewModel(
            permissions: permissions,
            loginItem: loginItem,
            onLinkCompleted: { [weak self] identity, credential in
                guard let self else { return }
                self.connection.send(
                    .linkCompleted(identity, credential: credential, generation: self.connection.currentGeneration)
                )
            },
            onFinished: { [weak self] in self?.closeOnboarding() }
        )
        let view = OnboardingFlow(viewModel: viewModel, permissions: permissions)
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "Trail Marker"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        // The onboarding palette (bone, forest, gold) is fixed brand color, not a system
        // semantic — DesignTokens.swift has no dark-mode variants for it on purpose, so the
        // window must not follow system Dark Mode or default label colors turn illegible.
        window.appearance = NSAppearance(named: .aqua)
        place(window, hosting: hosting)

        let controller = NSWindowController(window: window)
        onboardingWindowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func closeOnboarding() {
        onboardingWindowController?.close()
        onboardingWindowController = nil
    }

    private func showSettings() {
        if let settingsWindowController {
            settingsWindowController.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let view = SettingsWindow(
            connection: connection, permissions: permissions, updater: updater, loginItem: loginItem,
            onSetUp: { [weak self] in self?.showOnboarding() }
        )
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "Trail Marker Settings"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        place(window, hosting: hosting)

        let controller = NSWindowController(window: window)
        settingsWindowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Sizes the window to its content first, then centres it inside the visible screen area
    /// (below the menu bar). Centring before SwiftUI has sized the content left tall windows with
    /// their title bar off the top of the screen.
    private func place(_ window: NSWindow, hosting: NSHostingController<some View>) {
        hosting.view.layoutSubtreeIfNeeded()
        window.setContentSize(hosting.view.fittingSize)

        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        var frame = window.frame
        frame.size.height = min(frame.size.height, visible.height)
        frame.origin.x = visible.midX - frame.width / 2
        frame.origin.y = visible.midY - frame.height / 2
        window.setFrame(frame, display: false)
    }
}
