# Meetings mockups

Open `index.html` locally. The current pill proposal is **248 × 32px**, with three red audio-level
bars, a microphone/menu control, Pause, solid red Stop, and a separate far-right X. The X is
revealed on hover or keyboard focus and only means Hide recording pill.

- `01-not-linked.html`: Download app and the Trail Marker linking instruction.
- `02-ready.html`: connected Mac, ready for an explicit Start.
- `03-recording.html`: closed source menu and the compact pill.
- `03-recording-hover.html`: the same pill with its close X exposed.
- `03-recording-sources.html`: the source menu open for review.
- `04-settings.html`: existing link, audio, automatic-summary and Unlink controls.

Click the microphone/chevron to open the design-preview menu. It uses Moss menu styles and
matches the visible reference choices:

- Microphone: None or MacBook Air Microphone.
- System Audio: No computer audio or Record computer audio.

The menu is a capture-source picker, not a speaker output-device router. The checked device is an
illustration, not a live device inventory. The small preview script changes only local menu/check
states and uses no network, device, permission or capture APIs. Pause, Stop and Hide remain inert
illustrations. Closing the real pill must only hide it; the red meeting menu item, Pause and Stop
remain available, Show recording pill restores it, and the next recording shows it automatically.

## Proposal status and implementation gaps

This shorter pill and source menu are a new proposal pending owner approval. The visible menu
reference supplies the option layout. The owner later specified approximately
half the prior 64px pill height, so this proposal is **32px high and 248px wide**. The extra width
accommodates the source menu and inline X. Native code and the spec have not adopted this proposal.

The built recorder currently requires a microphone source. Selecting None with Record computer
audio would require an explicit system-audio-only mode, plus source validation, permissions and
recording-epoch handling. The prototype does not implement that mode or silently hide the option.
A both-off selection also needs a defined product behavior before implementation. Changing sources
in an active recording must retain its owner/device/session/capability bounds and explicit intent.

The Settings summary switch and helper text still match current product behavior; the separate
planned default-model change is not included. Original four-state approval was recorded in owner
chat on 2026-10-06; that date does not approve this later source-menu proposal.

## Build and checks

`build.tsx` renders shipped Moss primitives and existing menu classes. The original CSS/font
bundle and index stay unchanged; `pill.css` adds layout and hover/focus behavior only.
All assets are local. No PNGs, hosted renderer, production feature, or visual-fit claim is included.

    TSX_TSCONFIG_PATH=docs/superpowers/specs/meetings-setup-wizard/render-tsconfig.json node --import tsx docs/superpowers/specs/meetings-setup-wizard/build.tsx
    node node_modules/typescript/bin/tsc -p docs/superpowers/specs/meetings-setup-wizard/typecheck-tsconfig.json --noEmit

Open the explicit menu and hover previews for visual review. Keyboard Escape closes the preview
menu and returns focus to its trigger; clicking outside also closes it.
