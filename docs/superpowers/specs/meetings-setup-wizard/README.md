# Meetings setup and settings mockups

Design review only. No product code, workflow, connection, recording, permission or server changes.
Built on `feat/2981-meetings-mac-link` at `4892ab0f723ded3f7de69a25a0540ede4edb7ff5`.
Starting point: [the minimal Meetings spec](../2026-10-06-meetings-minimal-design.md),
expanded here into a first-time setup wizard.

## Open and render

Open `index.html` locally. All HTML, CSS, icons and font data are in this folder. No external
network, installation or running Moss instance is needed. Set the viewport to **1440 CSS pixels
wide**, with device scale factor 1, and take full-page PNG screenshots. The before/after settings
comparison is deliberately taller than the wizard frames. Screen names are in `screens.json`.

Per Ben's updated request, this PR contains **static HTML only**; Ben will render and inspect the
PNGs locally. No hosted render job or workflow was added. Chromium could not launch in the build
sandbox (`socket() failed: Operation not permitted`), so visual layout, screenshots, light/dark
and alternate-theme render checks are **not verified**. Source checks confirmed that referenced
classes, local assets and links exist, and that resource URLs are embedded.

## Screens

- `01-get-app.html`: download, install and open Trail Marker.
- `02-connect.html`: proposed one-click opening with the address filled in; copy/paste fallback.
- `03-approve.html`: browser approval for the named Mac and meeting recording permission.
- `04-waiting.html`: waiting for the Mac to check in; live transition is proposed product behavior.
- `05-linked.html`: linked Mac name and connection confirmation.
- `06-microphone.html`, `06-microphone-allowed.html`: microphone access before and after checking.
- `07-computer-audio.html`, `07-computer-audio-allowed.html`: computer audio before and after checking;
  microphone-only skip remains available.
- `08-listen-to.html`, `08-listen-to-one-app.html`: default source, including the conditional app choice.
- `09-choose-microphone.html`: remembered microphone.
- `10-summary.html`: automatic summary on Stop, on by default.
- `11-notice.html`: once-per-account recording notice; renewed only when the notice changes.
- `12-ready.html`: setup finishes on a ready meeting. The user presses Start; setup never starts audio.
- `13-mac-not-connected.html`: connection timeout with a recovery path.
- `14-approval-expired.html`: expired approval with a new-approval path.
- `15-permission-denied.html`: permission denied with System Settings and Check again.
- `16-settings-before-after.html`: current settings versus proposed everyday choices.
- `17-settings-advanced.html`: occasional settings revealed.
- `18-recording-pill.html`: current and smaller pill, sound present and no sound examples.

The static links advance between examples. Other controls are inert illustrations, not functioning
connections or settings. No deep link launches the Mac app from these mockups.

## Design decisions

The wizard has a progress strip and one decision per screen. Defaults are split into source,
microphone and summary screens. Microphone and computer audio permissions have separate screens.
Waiting becomes the named-Mac success state automatically when the real Mac checks in; the static
files show both ends of that proposed transition.

The working region uses the full horizontal space with 24px outer padding, not a narrow centered
card. The existing forest Masthead, numbered section heads, flat ruled rows and warm-paper tokens
follow Today. The minimum action gap is 12px; section gaps are 32px. The current settings comparison
is a **source-based reconstruction of a populated state**, not a screenshot of a running instance:
it preserves the current Mac details, permission switch, Unlink, source radio cards, readiness rows,
summary style and explanatory copy from `meeting-settings-form.tsx` and `meeting-settings-sections.tsx`.
Both columns use example data. The proposed column puts the choices someone normally changes first:
Listen to, Microphone and summary on Stop. Advanced contains Mac selection, summary style, permissions,
recording permission, Unlink and the acknowledged notice. Run setup again is always visible.

The proposed pill is **144 × 36px**, versus the current Swift view's **368 × 56px**: about 25% of
its area, rather than making each dimension one quarter as large and rendering the button unusable.
Its sole button is Stop. A small timer, red status dot and tiny captured-sound level remain. Pause
and Resume remain available in Moss and the Mac menu. Dragging the pill remains a proposed behavior.
The sound level examples are frozen drawings, not an animated or measured signal. Implementation
must use actual captured sound and draw a flat level when no fresh sound arrives. The menu-bar red
dot remains. No system notification is proposed. This smaller control is a design proposal only;
it does not change the currently approved Part B behavior.

## What needs code later

- **One-click connection is new code.** Trail Marker currently handles `moss-meeting://capture` in
  `MeetingCaptureContracts.swift`; it does not accept a setup address through a `connect` host.
  Proposed `moss-meeting://connect?instance=https%3A%2F%2Fmoss.example.com` would only prefill the
  existing connection flow. The Mac must validate the address, and normal browser approval must
  remain. Opening this link must never approve a Mac or begin recording.
- Copy/paste uses the current instance-address connection flow. The wizard's Copy button, step
  persistence and live waiting-to-linked transition still need browser UI wiring.
- System Settings buttons need the appropriate Mac handoff/deep-link wiring. The current web page
  gives instructions; this mockup does not assert that the proposed buttons already work.
- The download action needs the supported release artifact destination. It is intentionally inert
  here rather than inventing a release URL.
- Settings simplification, rerun-setup navigation and the smaller native pill all require later
  product implementation and approval. No credentials or permissions are granted by this PR.

## Primitives and reproducibility

`build.tsx` renders the shipped `@moss/ui` components with `renderToStaticMarkup`: Masthead,
SectionHead, Button, ButtonLink, IconButton, Badge, Card, Divider, Field, FormLabel, Select, Switch,
RadioCardGroup, RowIndex and Note. Icons are static SVG from the existing Lucide dependency.
There are no invented class names. Only document layout uses inline styles and existing semantic
tokens. `moss-ui.css` bundles the existing tokens/shared styles, the existing app form corrections
and the current meeting-settings layout. Archivo's original weights are embedded as font data;
`FONT-LICENSE.txt` is its license. No product stylesheet was edited.

To regenerate in an installed checkout, run the builder with the repository's TypeScript loader,
then format this folder with the repository's Prettier command. The generator is a design-only
source file and is not part of either app's build. Keep all screenshots beside these HTML files
when the visual review is complete.
