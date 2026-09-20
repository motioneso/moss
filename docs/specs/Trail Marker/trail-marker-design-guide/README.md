# Trail Marker design handoff

Trail Marker is the native macOS companion for Moss. This package translates the approved Trail Marker visual direction into implementation guidance for design and engineering.

## Start here

- `DESIGN_GUIDE.md` — complete visual, interaction, content, and accessibility guidance.
- `tokens.json` — platform-neutral design tokens.
- `DesignTokens.swift` — starter SwiftUI/AppKit color and spacing constants.
- `assets/moss-mark.svg` — canonical themeable three-line Moss mark.
- `assets/moss-mark-color.svg` — forest-and-gold presentation variant.
- `assets/moss-mark-monochrome.svg` — monochrome menu-bar and template-image variant.
- `assets/moss-mark-color.png` and `assets/moss-mark-monochrome.png` — 256 px raster previews.
- `reference/trail-marker-approved.png` — approved visual-direction board.

## Product naming

- Product name: **Trail Marker**
- Descriptor: **A Moss companion**
- Menu-bar label where text is shown: **Trail Marker**
- Account/session label in Moss: **Trail Marker for Mac**
- Logo: the supplied three-line Moss mark; do not create a separate Trail Marker symbol.

## Implementation priority

1. Match native macOS behavior and accessibility.
2. Match connection-state semantics and recovery actions.
3. Apply the forest, bone, and gold brand palette.
4. Add the field-guide presentation layer to onboarding and empty states.

The reference board is directional rather than a pixel specification. Generated text and control geometry should be replaced with native components and the approved copy in the guide.
