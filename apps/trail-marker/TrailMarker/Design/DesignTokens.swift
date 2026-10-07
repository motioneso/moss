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
        static let recordingPillWidth: CGFloat = 222
        static let recordingPillHeight: CGFloat = 32
        // Match the mockup's 12/2-point padding inside its 0.8-point border.
        static let recordingPillLeadingInset: CGFloat = 12.8
        static let recordingPillTrailingInset: CGFloat = 2.8
        static let recordingPillBorderWidth: CGFloat = 0.8
        static let recordingControlDiameter: CGFloat = 24
        static let recordingControlMinimumGap: CGFloat = 8
        static let recordingControlIconSize: CGFloat = 10
        static let recordingControlBorderWidth: CGFloat = 0.8
        static let recordingSourceMenuWidth: CGFloat = 36
        static let recordingSourceIconSize: CGFloat = 14
        static let recordingSourceChevronSize: CGFloat = 9
        static let recordingCloseDiameter: CGFloat = 20
        static let recordingCloseIconSize: CGFloat = 10
        static let recordingCloseSectionWidth: CGFloat = 24
        static let recordingCloseSectionSpacing: CGFloat = 3
        static let recordingCloseDividerWidth: CGFloat = 1
        static let recordingCloseDividerHeight: CGFloat = 16
        static let recordingMeterWidth: CGFloat = 24
        static let recordingMeterHeight: CGFloat = 18
        static let recordingMeterBarWidth: CGFloat = 4.5
        static let recordingMeterBarSpacing: CGFloat = 5.25
        static let recordingMeterBarCornerRadius: CGFloat = 2.25
        static let recordingMeterSilentHeight: CGFloat = 1.5
    }
}
