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

        // Native equivalents of the approved Moss surface, border and danger tokens.
        static let recordingSurface = adaptive(light: 0xFAF8F1, dark: 0x232019)
        static let recordingBorder = adaptive(light: 0xC6CBBC, dark: 0x35322B)
        static let recordingControlBorder = adaptive(light: 0x9BA591, dark: 0x46443E)
        static let recordingForeground = adaptive(light: 0x676C60, dark: 0xB7B1A2)
        static let recordingDanger = adaptive(light: 0xB23C2E, dark: 0xD4685A)
        static let recordingOnDanger = adaptive(light: 0xFFFFFF, dark: 0x1C1A16)

        private static func adaptive(light: UInt32, dark: UInt32) -> SwiftUI.Color {
            SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in
                let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
                return NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
                    green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
            })
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
        static let recordingControlDiameter: CGFloat = 54
    }
}
