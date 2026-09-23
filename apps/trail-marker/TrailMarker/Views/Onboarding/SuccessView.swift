import SwiftUI

/// Design guide §8 step 5.
struct SuccessView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        VStack(spacing: TrailMarkerTokens.Spacing.section) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 40))
                .foregroundStyle(Color(nsColor: .systemGreen))
                .accessibilityHidden(true)

            VStack(spacing: TrailMarkerTokens.Spacing.compact) {
                Text("Connected")
                    .font(.title2.weight(.semibold))
                Text(viewModel.instanceDescription)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("\(viewModel.accountName) · \(viewModel.accountEmail)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(viewModel.deviceName)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)

            Button("Done") {
                viewModel.finish()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(TrailMarkerTokens.Spacing.major)
        .frame(width: OnboardingFlow.contentWidth)
    }
}
