# Meetings mockups

Four states. Open `index.html` locally at **1440px**.

- `01-not-linked.html`: Download app; one line points to Trail Marker’s linking instructions.
- `02-ready.html`: connected Mac, ready for an explicit Start recording.
- `03-recording.html`: transcript, notes and the **250 × 80px** recording pill.
- `04-settings.html`: link status, audio source and Unlink Mac.

Microphone + system audio is the default. Audio source can be changed in Settings.
Linking and permissions stay in the Mac app’s existing flow. Connecting never starts recording.
The warm-surface pill has rounded ends, a light border, soft shadow, a small red waveform, a round
Pause button and a solid red Stop button. No visible text. Its arrangement follows the supplied reference, styled with Moss tokens. The waveform is a static illustration;
implementation must use actual captured audio and go flat when no fresh audio arrives.
No decorative animation.

`build.tsx` renders shipped `@moss/ui` primitives. `moss-ui.css` retains the bundled repository
tokens, shared styles and embedded Archivo fonts; `FONT-LICENSE.txt` covers the font.
`screens.json` lists the four states. All assets are local; controls are illustrative and
Download app is inert until a supported release destination is wired in product code.

Design artifacts only. Ben renders locally; no PNGs, hosted renderer or visual-fit claims.
