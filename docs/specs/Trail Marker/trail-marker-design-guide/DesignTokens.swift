import SwiftUI

enum TrailMarkerTokens {
    enum Color {
        static let forest = SwiftUI.Color(red: 23.0 / 255.0, green: 62.0 / 255.0, blue: 43.0 / 255.0)
        static let forestDeep = SwiftUI.Color(red: 14.0 / 255.0, green: 45.0 / 255.0, blue: 30.0 / 255.0)
        static let bone = SwiftUI.Color(red: 243.0 / 255.0, green: 238.0 / 255.0, blue: 223.0 / 255.0)
        static let boneRaised = SwiftUI.Color(red: 251.0 / 255.0, green: 248.0 / 255.0, blue: 239.0 / 255.0)
        static let gold = SwiftUI.Color(red: 199.0 / 255.0, green: 155.0 / 255.0, blue: 69.0 / 255.0)
        static let charcoal = SwiftUI.Color(red: 38.0 / 255.0, green: 42.0 / 255.0, blue: 39.0 / 255.0)
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
    }
}
