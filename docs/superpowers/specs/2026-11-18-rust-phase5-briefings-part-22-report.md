# Rust phase 5, Briefings part 22 (screens) report

Task JS-336. Mockups approved 2026-11-17: the Rust screens reproduce the TypeScript screens.

## Built

- Settings screen (`/settings/briefings`): morning time, evening switch and time, read-tools note, morning news and sports switches. Opens from the header cog.
- Briefing reader (`/briefing`): morning and evening tabs, report, schedule rail, "What informed this briefing", earlier reports, retry, in-progress polling, "Back to Today".
- Today hero link "Read your briefing" in the shell, shown when the briefings package is installed.
- Empty, loading, failed and in-progress states in the reader. Safe markdown (http/https links only, no HTML, no images).
- Manifest `screens` and settings entries updated (app map). Package test asserts every declared screen is packaged.
- Node tests for the pure helpers (`modules/briefings/ui/view.test.mjs`), wired into `tools/check.sh`.

## Checks

- Package gate `test:rust-briefings`: pass.
- Live run against the real Rust server with real data (no faked responses): `test:rust-briefings-live` held open, shell web assets copied in, screens loaded in a browser at desktop and phone widths. Today link, morning and evening reader, and settings render.
- Live proof found and fixed one defect: tab labels were dark on the dark header.
- `verify:static`: pass.

## Not built (frame limits)

- Accept and dismiss on action rows, catch-up add task and dismiss, plan review, day-plan accept. These act on other modules and cannot run from a module frame, so rows are read-only. Reply goes through the chat bridge.
- Email and calendar signal switches. Owned by the Calendar and Email settings.

## Not proven

- Real configured model: the live run uses a stand-in model that returns fixed text. A pass with one real model needs Ben.
- Upgrade check on a copy of dev data: not run.
- Settings toggle write was not exercised in the browser; the API write is covered by the package gate.
- Today hero text still says "switched off" in the sample-data shell even when a briefing exists. The shell owns that text.
