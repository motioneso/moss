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

## Follow-up checks (done)

- Upgrade check: rows copied from the dev database (the dev owner, 2 definitions, 44 runs) were loaded into a throwaway database and read back through the real routes as that owner. Both definitions listed, run counts matched (30 morning, 14 evening), the newest run of each read as ready, and the reader opened with its earlier-reports list. Dev and prod were only read. The copy is deleted.
- Switch toggle: the Morning news switch was clicked in a real browser and stayed off after a reload in a fresh browser session.
- Real model: the router was pointed at the Codex sign-in through the local model proxy, on the cheapest Codex model it lists (gpt-5.6-luna). One morning briefing ran end to end through the real worker and router and came back ready in 5 seconds with model-written text. The test account has no calendar, tasks or mail, so the text says the day is open.

## Follow-up work, not built

These act on other modules, so a module frame cannot do them. Each needs a cross-module call from the owner named here.

| Control                            | Owning module                                    |
| ---------------------------------- | ------------------------------------------------ |
| Accept and dismiss on action rows  | Tasks (for task rows) and Email (for reply rows) |
| Catch-up add task and dismiss      | Tasks                                            |
| Plan review and day-plan accept    | Tasks (the plan lives there), shown from Today   |
| Email and calendar signal switches | Email and Calendar settings                      |

## Not proven

- Today hero text still says "switched off" in the sample-data shell even when a briefing exists. The shell owns that text.
- The model pass used a test account with no sources, so source-grounded wording was not judged.
