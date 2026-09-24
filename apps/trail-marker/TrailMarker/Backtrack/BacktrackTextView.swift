#if DEBUG
import SwiftUI

/// What Backtrack has remembered, newest first: Phase 1's only way to see the text (plan §5
/// steps 3 and 5). It reads the in-memory Debug ring and nothing else, so it shows exactly what a
/// later phase would store, already sanitised. The text is not selectable, so nothing is copied
/// out of it by accident. ⌘F searches it: the app, title, address and every line.
struct BacktrackTextView: View {
    @ObservedObject var ring: BacktrackDebugRing

    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    private var shown: [(offset: Int, element: BacktrackSegment)] {
        let newestFirst = Array(ring.segments.enumerated().reversed())
        guard !trimmedQuery.isEmpty else { return newestFirst }
        return newestFirst.filter { $0.element.contains(trimmedQuery) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search remembered text", text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onExitCommand { query = "" }
                    .accessibilityIdentifier("backtrack.search")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(TrailMarkerTokens.Spacing.row)
            // ⌘F from anywhere in the window.
            .background(
                Button("") { searchFocused = true }
                    .keyboardShortcut("f", modifiers: .command)
                    .hidden()
            )
            Divider()
            content
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 360, idealHeight: 560)
        .onAppear { searchFocused = true }
    }

    @ViewBuilder private var content: some View {
        if ring.segments.isEmpty {
            placeholder(
                "Nothing remembered yet. Captured text appears here, newest first, and is cleared when "
                    + "Backtrack is turned off or Trail Marker quits."
            )
        } else if shown.isEmpty {
            placeholder("Nothing remembered matches \u{201C}\(trimmedQuery)\u{201D}.")
        } else {
            List {
                Section {
                    ForEach(shown, id: \.offset) { _, segment in
                        SegmentRow(segment: segment, query: trimmedQuery)
                    }
                } header: {
                    Text(header)
                }
            }
        }
    }

    private var header: String {
        let kept = "\(ring.segments.count) of the last \(BacktrackDebugRing.capacity) kept, in memory only"
        return trimmedQuery.isEmpty ? kept : "\(shown.count) matching · \(kept)"
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(TrailMarkerTokens.Spacing.section)
    }
}

extension BacktrackSegment {
    /// Case- and accent-insensitive, across everything the viewer shows.
    func contains(_ query: String) -> Bool {
        ([appName, windowTitle, address ?? ""] + lines).contains {
            $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }
}

private struct SegmentRow: View {
    let segment: BacktrackSegment
    let query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(highlighted(segment.appName)).font(.headline)
                Text(highlighted(segment.windowTitle)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Text(segment.end, style: .time).font(.caption).foregroundStyle(.secondary)
            }
            if let address = segment.address {
                Text(highlighted(address)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(highlighted(segment.lines.joined(separator: "\n")))
                .font(.system(.callout, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    /// Every match of the query marked, the way Find marks them.
    private func highlighted(_ text: String) -> AttributedString {
        var result = AttributedString(text)
        guard !query.isEmpty else { return result }
        var searchStart = text.startIndex
        while let range = text.range(
            of: query, options: [.caseInsensitive, .diacriticInsensitive], range: searchStart..<text.endIndex
        ) {
            if let lower = AttributedString.Index(range.lowerBound, within: result),
               let upper = AttributedString.Index(range.upperBound, within: result) {
                result[lower..<upper].backgroundColor = .yellow.opacity(0.5)
                result[lower..<upper].foregroundColor = .primary
            }
            searchStart = range.upperBound
        }
        return result
    }
}
#endif
