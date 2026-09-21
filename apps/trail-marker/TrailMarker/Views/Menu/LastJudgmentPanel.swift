import SwiftUI

/// Opened from the menu's Last Judgment row: what Trail Marker last saw, what Moss's model said,
/// and Wrong / Right. It is how the person checks that the whole chain works. The judgment is
/// kept in memory only, and the label is presented as the model's note, not as a verdict.
struct LastJudgmentPanel: View {
    @ObservedObject var focus: FocusRuntime
    @State private var answered: FocusVerdict?

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.group) {
            Text("Last judgment")
                .font(.title2.weight(.semibold))

            if let remembered = focus.lastJudgment {
                content(remembered)
            } else {
                Text("Nothing has been judged yet. Choose Judge Now in the menu while a Moss block is on.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(TrailMarkerTokens.Spacing.section)
        .frame(width: 420, alignment: .leading)
        .onChange(of: focus.lastJudgment) { _, _ in answered = nil }
    }

    @ViewBuilder
    private func content(_ remembered: RememberedJudgment) -> some View {
        Form {
            LabeledContent("When", value: remembered.at.formatted(date: .omitted, time: .standard))
            LabeledContent("Block", value: remembered.blockTitle)
            LabeledContent("App sent", value: remembered.appName)
            LabeledContent("Window title sent", value: remembered.windowTitle.isEmpty ? "None" : remembered.windowTitle)
            LabeledContent("Moss's model said", value: remembered.judgment.label.displayName)
            LabeledContent("Its note", value: remembered.judgment.reason.isEmpty ? "No note" : remembered.judgment.reason)
        }
        .formStyle(.grouped)

        Text("Shown as sent, after shortening. Kept only in memory on this Mac.")
            .font(.caption)
            .foregroundStyle(.secondary)

        if let answered {
            Label(
                answered == .right ? "Marked right. Thanks." : "Marked wrong. Thanks.",
                systemImage: "checkmark.circle"
            )
            .font(.callout)
        } else {
            HStack {
                Text("Was that right?")
                Spacer()
                Button("Wrong") {
                    answered = .wrong
                    focus.correct(.wrong)
                }
                Button("Right") {
                    answered = .right
                    focus.correct(.right)
                }
            }
        }
    }
}
