# Meetings mockups

Four states. Open `index.html` locally at **1440px**.

- `01-not-linked.html`: Download app; one line points to Trail Marker’s linking instructions.
- `02-ready.html`: connected Mac, ready for an explicit Start recording.
- `03-recording.html`: transcript, notes and the **200 × 64px** recording pill.
- `04-settings.html`: link status, audio source, automatic-summary switch and Unlink Mac.

Microphone + system audio is the default. Audio source can be changed in Settings.
Linking and permissions stay in the Mac app’s existing flow. Connecting never starts recording.
The native pill stays pure white in every theme, with exactly three red audio-level bars, a grey
Pause ring and a solid red Stop button with a filled white square. No visible text. The meter
is a static illustration; implementation must use actual captured audio and flatten on silence
or stale input. No decorative animation.

The Settings switch matches the built #3082 Settings form: “Summarize automatically after Stop”.
It is shown on, matching the product default, and its helper text matches the shipped component.
The original four states were approved in owner chat on 2026-10-06. These later owner-requested
corrections are not a claim of a fresh rendered visual review.

`build.tsx` renders shipped `@moss/ui` primitives. `moss-ui.css` retains the bundled repository
tokens, shared styles and embedded Archivo fonts; `FONT-LICENSE.txt` covers the font.
`screens.json` lists the four states. All assets are local; controls are illustrative and
Download app is inert until a supported release destination is wired in product code.

Design artifacts only. Ben renders locally; no PNGs, hosted renderer or visual-fit claims.

Regenerate from the repository root with:

    TSX_TSCONFIG_PATH=docs/superpowers/specs/meetings-setup-wizard/render-tsconfig.json node --import tsx docs/superpowers/specs/meetings-setup-wizard/build.tsx
    node node_modules/typescript/bin/tsc -p docs/superpowers/specs/meetings-setup-wizard/typecheck-tsconfig.json --noEmit

The two configurations separate runtime package entry points from declaration-file paths.
The existing CSS bundle and font license are unchanged; tokens.css contains the fixed native-overlay colours.
