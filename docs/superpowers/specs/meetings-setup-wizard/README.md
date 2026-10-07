# Meetings mockups

The approved pill is **222 × 32px**: three red audio-level bars, a microphone/menu control,
Pause, solid red Stop, and an always-visible far-right X. The close section is approximately
half its former width. X only means Hide recording pill; it is separate from Stop.

Open `index.html` locally, or use these views:

- `01-not-linked.html`: Download app and the Trail Marker linking instruction.
- `02-ready.html`: connected Mac, ready for an explicit Start.
- `03-recording.html`: closed source menu and the final compact pill.
- `03-recording-sources.html`: the source menu open for review.
- `04-settings.html`: link, audio, automatic-summary and Unlink controls.

There is no hover-only view now. Close and its divider remain visible in every pointer/focus state.
At the former 248px width, the divider-to-right-edge section measured about 52.5px using the
existing 0.8px border, 12px padding and distributed spacing. The new 24px divider/button group,
2px trailing padding and border total about 26.8px. Reducing the overall width to 222px preserves
the other controls and their spacing to within a fraction of a pixel.

Click the microphone/chevron to open the design-preview menu. It uses Moss menu styles and
matches the reference choices:

- Microphone: None or MacBook Air Microphone.
- System Audio: No computer audio or Record computer audio.

This is a capture-source picker, not a speaker output-device router. The checked device is an
illustration, not a live inventory. The preview script changes only local menu/check states and
uses no network, device, permission or capture APIs. Pause, Stop and Hide remain illustrations.
Closing the real pill only hides it; the red meeting menu item and menu Pause/Stop remain
available. Show recording pill restores it, and the next recording shows it automatically.

## Approval and implementation

The owner approved this direction with the always-visible X and narrower close-section changes.
The original four-state approval was recorded in owner chat on 2026-10-06; the later menu/pill
approval is distinct. This PR is the canonical mockup source. Native implementation and the spec
must follow separately; this design commit does not itself implement audio selection or capture.

Native adoption must support microphone-off plus computer audio explicitly. Both sources off
must be handled clearly without silently substituting a default. Live source changes require an
explicit, versioned source boundary while retaining owner/device/session/capability/expiry checks.
The prototype is not evidence of those runtime guarantees.

The Settings helper says “your default model”, matching the approved default-model follow-up.

## Build and checks

`build.tsx` renders shipped Moss primitives and existing menu classes. The original CSS/font
bundle and index stay unchanged; `pill.css` supplies source-menu layout only. All assets are local.
No PNGs, hosted renderer or production behavior is added by this mockup. No browser visual-fit
claim is made from static checks.

    TSX_TSCONFIG_PATH=docs/superpowers/specs/meetings-setup-wizard/render-tsconfig.json node --import tsx docs/superpowers/specs/meetings-setup-wizard/build.tsx
    node node_modules/typescript/bin/tsc -p docs/superpowers/specs/meetings-setup-wizard/typecheck-tsconfig.json --noEmit

Keyboard arrows move through source choices. Escape closes the preview menu and returns focus
to its trigger; clicking outside also closes it.
