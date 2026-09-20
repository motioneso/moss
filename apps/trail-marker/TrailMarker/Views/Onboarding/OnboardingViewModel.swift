import AppKit
import Foundation

/// Drives the first-run flow (design guide §8): Welcome → Waiting for browser approval →
/// (the browser approval screen itself lives on Moss, not here) → Device setup → Success.
/// Talks to `CompanionClient` directly — this is deliberately independent of
/// `ConnectionMachine`, which only learns about the result via a single `linkCompleted` event
/// once onboarding is done.
@MainActor
final class OnboardingViewModel: ObservableObject {
    enum Step: Equatable {
        case enteringURL
        case waitingForApproval
        case deviceSetup
        case success
    }

    @Published private(set) var step: Step = .enteringURL
    @Published var urlText: String = ""
    /// Shown on the Welcome screen. Set on any failure and the URL text is left untouched
    /// (§8 step 1: "Preserve the entered URL when an error occurs").
    @Published var bannerMessage: String?
    @Published var deviceName: String = Host.current().localizedName ?? "This Mac"
    @Published var startAtLogin = false
    @Published private(set) var accountName: String = ""
    @Published private(set) var accountEmail: String = ""
    @Published private(set) var instanceDescription: String = ""

    private var instance: InstanceURL?
    private var linkAttempt: LinkAttempt?
    private var attemptId: String?
    private var approvalPath: String?
    private var pollIntervalSeconds = 3
    private var linkedIdentity: LinkedIdentity?
    private var pendingCredential: String?
    private var serverAssignedDeviceName = ""
    private var pollTask: Task<Void, Never>?
    private var sessionToken = 0

    private let permissions: PermissionsService
    private let loginItem: LoginItemService
    private let appVersion: String
    private let osVersion: String
    private let onLinkCompleted: (LinkedIdentity, String) -> Void
    private let onFinished: () -> Void

    init(
        permissions: PermissionsService,
        loginItem: LoginItemService,
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
        osVersion: String = ProcessInfo.processInfo.operatingSystemVersionString,
        onLinkCompleted: @escaping (LinkedIdentity, String) -> Void,
        onFinished: @escaping () -> Void
    ) {
        self.permissions = permissions
        self.loginItem = loginItem
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.onLinkCompleted = onLinkCompleted
        self.onFinished = onFinished
    }

    // MARK: - Step 1: Welcome

    func connectInBrowser() {
        bannerMessage = nil
        switch InstanceURL.parse(urlText) {
        case .failure(let error):
            bannerMessage = OnboardingError.from(error).message
        case .success(let instance):
            self.instance = instance
            beginPairing(instance: instance)
        }
    }

    private func beginPairing(instance: InstanceURL) {
        sessionToken += 1
        let token = sessionToken
        let client = CompanionClient(instance: instance, transport: URLSessionTransport())
        let name = Host.current().localizedName ?? "This Mac"

        Task {
            do {
                let serverProtocol = try await client.protocolVersion()
                guard serverProtocol == COMPANION_PROTOCOL_VERSION_SUPPORTED else {
                    throw CompanionError.incompatible(protocolVersion: serverProtocol)
                }
                let attempt = LinkAttempt()
                let response = try await client.createPairAttempt(
                    CreatePairAttemptRequest(
                        deviceName: name, platform: "macos", appVersion: appVersion, osVersion: osVersion,
                        verifierHash: attempt.verifierHash
                    )
                )
                guard token == self.sessionToken else { return }
                self.linkAttempt = attempt
                self.attemptId = response.attemptId
                self.approvalPath = response.approvalPath
                self.pollIntervalSeconds = response.pollIntervalSeconds
                self.deviceName = name
                self.step = .waitingForApproval
                self.openApprovalPage()
                self.startPolling(client: client, token: token)
            } catch let error as CompanionError {
                guard token == self.sessionToken else { return }
                self.bannerMessage = OnboardingError.from(error).message
            } catch {
                guard token == self.sessionToken else { return }
                self.bannerMessage = OnboardingError.unreachable.message
            }
        }
    }

    // MARK: - Step 2: Waiting for browser approval

    func openApprovalPage() {
        guard let instance, let approvalPath else { return }
        NSWorkspace.shared.open(instance.browserURL(approvalPath))
    }

    private func startPolling(client: CompanionClient, token: Int) {
        pollTask?.cancel()
        pollTask = Task {
            var interval = TimeInterval(self.pollIntervalSeconds)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled, token == self.sessionToken,
                    let attempt = self.linkAttempt, let attemptId = self.attemptId
                else {
                    return
                }
                do {
                    let outcome = try await client.redeem(attemptId: attemptId, verifier: attempt.verifier)
                    guard token == self.sessionToken else { return }
                    switch outcome {
                    case .pending:
                        continue
                    case .issued(let response):
                        self.handleIssued(response)
                        return
                    case .denied:
                        self.returnToWelcome(message: "Linking was cancelled. Nothing was changed.")
                        return
                    case .expired, .redeemed, .unknown:
                        self.returnToWelcome(message: "This Mac couldn't be linked.")
                        return
                    }
                } catch CompanionError.rateLimited {
                    interval *= 2
                } catch {
                    // A transient failure while waiting is not fatal — keep polling at the
                    // same interval rather than aborting a link the person is actively watching.
                    continue
                }
            }
        }
    }

    private func handleIssued(_ response: RedeemPairAttemptResponse) {
        guard let instance else { return }
        let identity = LinkedIdentity(
            instance: instance, deviceId: response.device.id, accountName: response.account.name,
            accountEmail: response.account.email
        )
        linkedIdentity = identity
        pendingCredential = response.credential
        deviceName = response.device.displayName
        serverAssignedDeviceName = response.device.displayName
        accountName = response.account.name
        accountEmail = response.account.email
        instanceDescription = instance.origin.host ?? urlText
        step = .deviceSetup
    }

    func cancelWaiting() {
        sessionToken += 1
        pollTask?.cancel()
        if let instance, let attempt = linkAttempt, let attemptId {
            let client = CompanionClient(instance: instance, transport: URLSessionTransport())
            Task { try? await client.cancel(attemptId: attemptId, verifier: attempt.verifier) }
        }
        returnToWelcome(message: nil)
    }

    private func returnToWelcome(message: String?) {
        bannerMessage = message
        step = .enteringURL
    }

    // MARK: - Step 4: Device setup

    func skipPermissions() {
        permissions.refresh()
    }

    func finishDeviceSetup() {
        guard let identity = linkedIdentity, let credential = pendingCredential, let instance else { return }
        if startAtLogin {
            try? loginItem.setEnabled(true)
        }

        let trimmedName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let renamed = !trimmedName.isEmpty && trimmedName != serverAssignedDeviceName

        Task {
            if renamed {
                let client = CompanionClient(instance: instance, transport: URLSessionTransport())
                try? await client.rename(credential: credential, displayName: trimmedName)
            }
            self.onLinkCompleted(identity, credential)
            self.step = .success
        }
    }

    // MARK: - Step 5: Success

    func finish() {
        onFinished()
    }
}
