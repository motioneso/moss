import SwiftUI

/// Design guide §8 step 2. Never implies the app is frozen — visible progress, and two
/// explicit ways out: Cancel returns to the editable URL state, Open Browser Again re-opens
/// the same approval link.
struct WaitingForApprovalView: View {
    @ObservedObject var viewModel: OnboardingViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: TrailMarkerTokens.Spacing.section) {
            if reduceMotion {
                Image(systemName: "hourglass")
                    .font(.system(size: 32))
                    .foregroundStyle(TrailMarkerTokens.Color.forest)
            } else {
                ProgressView()
                    .controlSize(.large)
                    .accessibilityLabel("Waiting for browser approval")
            }

            VStack(spacing: TrailMarkerTokens.Spacing.compact) {
                Text("Waiting for browser approval")
                    .font(.title2.weight(.semibold))
                Text("Approve \(viewModel.deviceName) in the browser window Trail Marker just opened.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: TrailMarkerTokens.Spacing.group) {
                Button("Cancel") {
                    viewModel.cancelWaiting()
                }
                Button("Open Browser Again") {
                    viewModel.openApprovalPage()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(TrailMarkerTokens.Spacing.major)
        .frame(width: TrailMarkerTokens.Layout.firstRunWidth)
    }
}
