#if DEBUG
import SwiftUI

/// What Backtrack has remembered, newest first: Phase 1's only way to see the text (plan §5
/// steps 3 and 5). It reads the in-memory Debug ring and nothing else, so it shows exactly what a
/// later phase would store, already sanitised. The text is not selectable, so nothing is copied
/// out of it by accident.
struct BacktrackTextView: View {
    @ObservedObject var ring: BacktrackDebugRing

    var body: some View {
        Group {
            if ring.segments.isEmpty {
                Text("Nothing remembered yet. Captured text appears here, newest first, and is cleared when "
                    + "Backtrack is turned off or Trail Marker quits.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(TrailMarkerTokens.Spacing.section)
            } else {
                List {
                    Section {
                        ForEach(Array(ring.segments.enumerated().reversed()), id: \.offset) { _, segment in
                            SegmentRow(segment: segment)
                        }
                    } header: {
                        Text("\(ring.segments.count) of the last \(BacktrackDebugRing.capacity) kept, in memory only")
                    }
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 360, idealHeight: 560)
    }
}

private struct SegmentRow: View {
    let segment: BacktrackSegment

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(segment.appName).font(.headline)
                Text(segment.windowTitle).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Text(segment.end, style: .time).font(.caption).foregroundStyle(.secondary)
            }
            if let address = segment.address {
                Text(address).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(segment.lines.joined(separator: "\n"))
                .font(.system(.callout, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }
}
#endif
