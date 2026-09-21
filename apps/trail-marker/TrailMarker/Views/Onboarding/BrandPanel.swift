import SwiftUI

/// The forest side panel from the approved board. The mark uses the on-forest treatment from the
/// design guide (bone top and bottom bars, gold middle), drawn from the official geometry
/// (24 x 24 box) rather than redrawn.
struct BrandPanel: View {
    static let width: CGFloat = 200

    var body: some View {
        ZStack(alignment: .bottom) {
            TrailMarkerTokens.Color.forest

            Hills()
                .fill(TrailMarkerTokens.Color.forestDeep)
                .frame(height: 150)
                .accessibilityHidden(true)

            VStack(spacing: TrailMarkerTokens.Spacing.group) {
                MarkOnForest()
                    .frame(width: 72, height: 72)
                    .accessibilityHidden(true)

                Text("TRAIL MARKER")
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .tracking(3)
                    .foregroundStyle(TrailMarkerTokens.Color.bone)

                Text("A MOSS COMPANION")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2)
                    .foregroundStyle(TrailMarkerTokens.Color.gold)
            }
            .padding(.bottom, 200)
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .frame(width: Self.width)
    }
}

private struct MarkOnForest: View {
    var body: some View {
        Canvas { context, size in
            let scale = size.width / 24
            let bars: [(CGRect, Color)] = [
                (CGRect(x: 4, y: 5.5, width: 13, height: 3), TrailMarkerTokens.Color.bone),
                (CGRect(x: 4, y: 10.5, width: 16, height: 3), TrailMarkerTokens.Color.gold),
                (CGRect(x: 4, y: 15.5, width: 9, height: 3), TrailMarkerTokens.Color.bone)
            ]
            for (rect, color) in bars {
                let scaled = CGRect(
                    x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale
                )
                context.fill(Path(roundedRect: scaled, cornerRadius: 1.5 * scale), with: .color(color))
            }
        }
    }
}

/// Two soft ridges. Scenery only: kept low-contrast and behind nothing interactive.
private struct Hills: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: rect.maxY))
        path.addLine(to: CGPoint(x: 0, y: rect.height * 0.55))
        path.addCurve(
            to: CGPoint(x: rect.width * 0.55, y: rect.height * 0.35),
            control1: CGPoint(x: rect.width * 0.2, y: rect.height * 0.2),
            control2: CGPoint(x: rect.width * 0.35, y: rect.height * 0.5)
        )
        path.addCurve(
            to: CGPoint(x: rect.width, y: rect.height * 0.15),
            control1: CGPoint(x: rect.width * 0.75, y: rect.height * 0.2),
            control2: CGPoint(x: rect.width * 0.9, y: rect.height * 0.3)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
