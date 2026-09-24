import SwiftUI

/// Design guide §8 step 1.
struct WelcomeView: View {
    @ObservedObject var viewModel: OnboardingViewModel
    @FocusState private var urlFieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.section) {
            VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.related) {
                Text("Connect your Mac to Moss")
                    .font(.title2.weight(.semibold))
                Text("A Moss companion")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.compact) {
                Text("Moss instance URL")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TextField("https://moss.example.com", text: $viewModel.urlText)
                    .textFieldStyle(.roundedBorder)
                    .focused($urlFieldFocused)
                    .onSubmit { viewModel.connectInBrowser() }
                    .accessibilityLabel("Moss instance URL")

                if let message = viewModel.bannerMessage {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(Color(nsColor: .systemRed))
                        .accessibilityLabel(message)
                }
            }

            Text(
                "The browser completes secure sign-in and lets you approve this Mac. "
                    + "Trail Marker connects one Mac to one Moss account at a time."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Button("Connect in Browser") {
                viewModel.connectInBrowser()
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.urlText.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(TrailMarkerTokens.Spacing.major)
        .frame(width: OnboardingFlow.contentWidth, alignment: .leading)
        .onAppear { urlFieldFocused = true }
    }
}
