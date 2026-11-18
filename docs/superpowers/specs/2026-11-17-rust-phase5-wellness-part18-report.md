# Wellness part 18 report (JS-330, 2026-11-17)

Screens for insights, therapy notes, settings and export, as package screens served by the Rust
server. The main Wellness page belongs to part 17 (JS-329), which mounts the three sections and
the export button. This part ships them as separate files so the two parts do not collide.

## What was built

| Screen        | Where it lives                      | Notes                                                                        |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Settings      | `/settings/wellness` (own screen)   | AI access switch, "Inherited" badge, load, save and refresh failure states   |
| Insights      | `insights.mjs` (mounted by part 17) | Loading, empty, broken, and the review-notes link                            |
| Therapy notes | `notes.mjs` (mounted by part 17)    | Add, delete, empty, loading, broken, delete failure; text kept if save fails |
| Export dialog | `export.mjs` (opened by part 17)    | Form, building, ready, expired, start/status/download failure                |

A new `save` message on the module bridge lets a sandboxed screen hand a finished file to the page,
which downloads it. The sandbox is unchanged. The host accepts only a file name of letters, digits,
dot, dash and underscore, the type `text/html; charset=utf-8`, and at most 8 MB.

## Deviations from the TypeScript screens

- The export dialog lists two categories (check-ins, therapy notes). The Rust route refuses
  medications and insights.
- The export range is UTC days. The default end date is the later of the local day and the UTC day,
  because a note written on a US evening is filed under the next UTC day.
- The "UTC days, up to 366" note has no gold left border (the left-border ban overrides the shared
  note style here).
- The unsent export draft lives in page memory, not session storage, which a sandboxed screen cannot use.

## Live proof

Real Rust server over HTTPS (`pnpm test:rust-wellness-live` with a hold-open option), real login,
real database, no responses intercepted or rewritten. Driven with Chromium at 1280x900 and 390x844 (touch).

| Check                                                              | Desktop                       | Phone  |
| ------------------------------------------------------------------ | ----------------------------- | ------ |
| Settings loads; switch off then on saves each time                 | Passed                        | Passed |
| Notes empty state, add, add with Ctrl+Enter, delete                | Passed                        | Passed |
| Insights empty state (fewer than 7 check-ins)                      | Passed                        | Passed |
| Export: acknowledge, generate, download file saved                 | Passed                        | Passed |
| Downloaded file contains the therapy notes written in the same run | Passed                        | Passed |
| Therapy-note text absent from the server log after the run         | Passed (live test asserts it) |        |

The run found and fixed three defects: the settings screen printed "null" under the card, the export
missed notes written after UTC midnight, and the note kept a gold left border.

## Not proven

- Insights with data. Check-in dates cannot be set through the routes, so the live run never had a
  week of history. Covered only by reading the rendering code.
- The broken states (a failing server), which would need the server to fail on demand.
- The three sections inside the real Wellness page. Part 17 had not merged. The live run used a
  throwaway page that mounted them, which is not in this change.
- Medication and insight export, which the Rust route does not accept.
