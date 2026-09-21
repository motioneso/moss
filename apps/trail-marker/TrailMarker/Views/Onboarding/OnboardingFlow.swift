import SwiftUI

/// Switches between the four first-run screens (design guide §8) based on
/// `OnboardingViewModel.step`. Steps 1 and 2 run before Moss knows the Mac; step 3 (the browser
/// approval screen) is a Moss web page, not part of this app.
struct OnboardingFlow: View {
    static let contentWidth = TrailMarkerTokens.Layout.firstRunWidth - BrandPanel.width

    @ObservedObject var viewModel: OnboardingViewModel
    @ObservedObject var permissions: PermissionsService

    var body: some View {
        HStack(spacing: 0) {
            BrandPanel()
            screens
        }
        .background(TrailMarkerTokens.Color.bone)
    }

    private var screens: some View {
        Group {
            switch viewModel.step {
            case .enteringURL:
                WelcomeView(viewModel: viewModel)
            case .waitingForApproval:
                WaitingForApprovalView(viewModel: viewModel)
            case .deviceSetup:
                DeviceSetupView(viewModel: viewModel, permissions: permissions)
            case .success:
                SuccessView(viewModel: viewModel)
            }
        }
    }
}
