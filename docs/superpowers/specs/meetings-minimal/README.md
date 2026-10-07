# Meetings approved mockups

Open `index.html` locally. These are the current screens for the
[Meetings spec](../2026-10-06-meetings-minimal-design.md), with all required assets in this folder.

## Owner approval and provenance

Ben approved #3087 and #3089 in owner chat on **2026-10-06** (owner-local date), and reaffirmed
that approval when requesting the corrections to [#3077 review 6034226446](https://github.com/motioneso/moss/pull/3077#issuecomment-6034226446).
This is the owner-chat approval record; neither source PR has a GitHub approval review.

- The four Meetings states, renderer, CSS bundle and font license were copied from
  [#3087](https://github.com/motioneso/moss/pull/3087), head
  `5bca8dfb88cc6f436f599345fdf66e0150b89fac`. All ten source files were checked against their
  GitHub blob hashes before copying. That source PR is open; this spec no longer depends on it
  being merged to carry its screens.
- The three unchanged approval presentation references and their local CSS/font license were
  copied from merged [#3089](https://github.com/motioneso/moss/pull/3089), head
  `259c12703776033cbf1e72dcf9767d42566dc693`, merged as
  `dd0aacd232b6fdaacfbc544ac7f0b9f2db0ec7de`. All six copied source files were checked against
  that head's GitHub blob hashes. See [approval-card/README.md](approval-card/README.md).

The source date is distinct from the GitHub UTC timestamps. The copied Meetings screens include
the owner's review corrections: a red three-bar meter, pure white native capsule in light and
dark appearances, and a grey Pause ring. Settings also retains #3079's
“Summarize automatically after Stop” switch. The folder name describes Meetings, not a setup flow.

## Four Meetings states

- `01-not-linked.html`: “Link your Mac”, Trail Marker's linking instruction and an inert Download app
  button without an href. No Moss address or copy button.
- `02-ready.html`: connected Mac, ready for an explicit Start recording.
- `03-recording.html`: transcript, notes and the **250 × 80px** native recording capsule.
- `04-settings.html`: link status, audio source, automatic-summary switch and Unlink Mac.

Microphone + system audio is the default. Audio source changes only in Settings. The one initial
browser linking approval grants recording capability for the exact Mac. There is no second
recording-approval card or disclosure paragraph. OS permissions and explicit Start remain required;
linking never starts capture. Legacy devices without authoritative recording consent must use the
normal explicit relink flow; a legacy connection token alone is insufficient. Retired attempt/decide
mutations return authenticated 410. OS and independent Backtrack consent remain unchanged. The
native first-screen address input is outside this browser design change.

The capsule has exactly three red level bars, two 54px controls and no visible text. The Pause
control has a grey ring; Stop is solid semantic red with a filled white square. Pure white and neutral
grey overlay tokens are in `tokens.css`; page surfaces still follow the Moss theme. The bars are a
static illustration. Product levels must come from actual captured audio and flatten on silence,
absent/stale audio, Pause and terminal states. No decorative animation is provided. The paused
native pill’s play control resumes only the same paused, claimed grant after an explicit click,
retaining exact sources and owner/device/session/capability/expiry bounds. Newer Pause/Stop and
known rejection cancel queued Resume; uncertain same-request retries add no authority. Hardware
and uploads remain paused until authoritative acknowledgment and status application. There is no
initial native Start; browser Resume remains available.

`build.tsx` renders shipped `@moss/ui` primitives; `screens.json` lists the four Meetings states.
`moss-ui.css` is the unchanged #3087 bundle of repository tokens, shared styles and embedded Archivo
fonts. `FONT-LICENSE.txt` covers those fonts. All controls are illustrative and no release URL is
invented for Download app.

## Regeneration and verification

From a checkout with dependencies installed:

    TSX_TSCONFIG_PATH=docs/superpowers/specs/meetings-minimal/render-tsconfig.json node --import tsx docs/superpowers/specs/meetings-minimal/build.tsx
    pnpm exec tsc -p docs/superpowers/specs/meetings-minimal/typecheck-tsconfig.json --noEmit
    pnpm exec prettier --write docs/superpowers/specs/meetings-minimal
    node docs/superpowers/specs/meetings-minimal/verify.mjs

`verify.mjs` checks local links, source/markup invariants, shipped classes, token references and the
unchanged approval-reference blob hashes. With Playwright and Chromium installed, add `--layout`
for local browser DOM assertions at desktop and phone widths in light, dark and a park theme.
Chromium could not start in the authoring workspace because its local browser socket was blocked;
no browser layout pass or rendered visual-fit claim is made. These static checks are not proof of live capture,
OS permission, server authorization or actual audio behavior; the spec retains its live-path gate.

The renderer uses explicit runtime package entry points; its separate typecheck config uses the corresponding declaration files. This avoids the root project’s type-only React aliases when generating HTML.
