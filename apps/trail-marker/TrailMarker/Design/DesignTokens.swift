import AppKit
import SwiftUI

enum TrailMarkerTokens {
    enum Color {
        static let forest = SwiftUI.Color(red: 23.0 / 255.0, green: 62.0 / 255.0, blue: 43.0 / 255.0)
        static let forestDeep = SwiftUI.Color(red: 14.0 / 255.0, green: 45.0 / 255.0, blue: 30.0 / 255.0)
        static let bone = SwiftUI.Color(red: 243.0 / 255.0, green: 238.0 / 255.0, blue: 223.0 / 255.0)
        static let boneRaised = SwiftUI.Color(red: 251.0 / 255.0, green: 248.0 / 255.0, blue: 239.0 / 255.0)
        static let gold = SwiftUI.Color(red: 199.0 / 255.0, green: 155.0 / 255.0, blue: 69.0 / 255.0)
        static let charcoal = SwiftUI.Color(red: 38.0 / 255.0, green: 42.0 / 255.0, blue: 39.0 / 255.0)

        // The approved recording-pill reference stays white, grey and red in every appearance.
        // These recording-only colors deliberately do not follow the app's warm/dark surfaces.
        static let recordingSurface = SwiftUI.Color.white
        static let recordingBorder = fixed(0xD8D8D2)
        static let recordingControlBorder = fixed(0xCBD0D6)
        static let recordingForeground = fixed(0x6B7280)
        static let recordingDanger = fixed(0xDB3D38)
        static let recordingOnDanger = SwiftUI.Color.white

        private static func fixed(_ value: UInt32) -> SwiftUI.Color {
            SwiftUI.Color(.sRGB, red: Double((value >> 16) & 0xFF) / 255,
                green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255, opacity: 1)
        }
    }

    enum Spacing {
        static let compact: CGFloat = 4
        static let related: CGFloat = 8
        static let row: CGFloat = 12
        static let group: CGFloat = 16
        static let section: CGFloat = 24
        static let major: CGFloat = 32
    }

    enum Layout {
        static let firstRunWidth: CGFloat = 680
        static let settingsWidth: CGFloat = 780
        static let settingsHeight: CGFloat = 560
        static let settingsSidebarWidth: CGFloat = 196
        static let menuPopoverWidth: CGFloat = 320
        static let brandPanelRadius: CGFloat = 12
        static let recordingPillWidth: CGFloat = 250
        static let recordingPillHeight: CGFloat = 80
        static let recordingPillHorizontalInset: CGFloat = 30
        static let recordingPillBorderWidth: CGFloat = 2
        static let recordingControlDiameter: CGFloat = 54
        static let recordingControlIconSize: CGFloat = 20
        static let recordingControlBorderWidth: CGFloat = 3
        static let recordingMeterWidth: CGFloat = 32
        static let recordingMeterHeight: CGFloat = 24
        static let recordingMeterBarWidth: CGFloat = 6
        static let recordingMeterBarSpacing: CGFloat = 7
        static let recordingMeterBarCornerRadius: CGFloat = 1
        static let recordingMeterSilentHeight: CGFloat = 2
    }
}
