# Rust phase 5, Wellness part 17 (Today, History, Trends screen) report

Task JS-329. The package screen reproduces the current web screen for Today, History and
Trends. No redesign. Mockup approved 2026-11-17.

## Delivered

- Package screen at `/wellness` (`modules/wellness/ui/`), served by the Rust server.
- New route `GET /wellness/local-day` (the person's date and time zone, for the screen's date maths).
- App-map entries: screen, navigation entry (HeartPulse, order 40), feature text.
- Medication management (list, add, edit, remove, all schedule choices with validation).
- Part 18 mount points (`#wl-export-slot`, `section#wl-insights`, `section#wl-notes`) left for the other part.

## Checks run

| Check                                                     | Result |
| --------------------------------------------------------- | ------ |
| Screen logic tests (16, node)                             | Pass   |
| Wellness module tests, including the new local-day test   | Pass   |
| Package test: every file the page loads is in the package | Pass   |
| Component build and package build                         | Pass   |

## Live proof

Real Rust server over HTTPS with the signed Wellness package installed through the module host,
throwaway database, real sign-up. A real Chromium drove the screen (desktop 1280x900, phone
390x844). No response was intercepted or rewritten.

- Empty state: no medicines, no check-ins, empty trend chart.
- Added a medicine in Manage medications, took its dose, reloaded: dose still shows taken.
- Saved a check-in (Happy, Joy, note): shows on Today and in the History list.
- Phone width: no sideways overflow.

Fixture: `modules/wellness/tools/ui-gate.sh` (run through the gate; `pnpm test:rust-wellness-ui`).

## Not proven

- A real phone or another device on the home network. Only a phone-sized window on the same computer.
- Broken and slow states in a browser. The logic tests cover them, but no failure was caused live.
- The schedule sentence and "Next:" doses in the medicine form are not ported (a fixed line shows instead).
- 12/24-hour display: stored times show as written.
- History paging, editing an old check-in, 30-day trends and removing a medicine were not clicked live.
- On the phone, the right-most date label under the chart is clipped and the Settings button sits mid-row. Not compared with the web screen.
- Part 18 pieces (insights, notes, export, settings) are not in this change. Their files fail to load here and the screen ignores that.
- The manifest's settings entry still points at the old path.
