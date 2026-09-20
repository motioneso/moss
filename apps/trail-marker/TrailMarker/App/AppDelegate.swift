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
        window.center()

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
        window.center()

        let controller = NSWindowController(window: window)
        settingsWindowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
