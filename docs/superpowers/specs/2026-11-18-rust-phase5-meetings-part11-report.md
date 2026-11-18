# Rust port phase 5, Meetings part 11 (screens) report

Task JS-337. Part 12 (settings, recording panel, calendar link, Coming up, Mac link, New meeting) is separate.

## Built

- One package screen at `/meetings` with in-frame routing between three views.
  - Home: search, type filter, history table, load more, loading, failed, denied and empty states.
  - Add recording: paste a transcript, optional title and type, locked while saving or retrying.
  - Meeting page: title edit, notes autosave with conflict handling, type chip, header menu, delete dialog,
    transcript, summary (rewrite, versions, compare, edit, suggested tasks, vault export, copy as Markdown).
- Manifest: version 0.1.1, `screens`, and a Meetings navigation entry (mic icon, order 36).
- 14 UI files served by the host package; the package test asserts each one.
- CSS carries the TS screen classes plus a phone breakpoint. No coloured left borders.

## Proof

| Proof                                                                                                           | Where                                                    |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 9 pure-function tests (formatting, validation, summary resolution)                                              | `modules/meetings/ui/format.test.mjs`                    |
| Package serves all 14 screen files and the manifest declares screen and navigation                              | `host/tests/package.rs`                                  |
| Real Rust server over HTTPS, two people, real database                                                          | `pnpm test:rust-meetings-live` with `MOSS_MEETINGS_HOLD` |
| Browser pass at 1280 and 390 wide, keyboard open of a meeting, notes autosave, empty search, paste a transcript | `modules/meetings/tools/screen-live.mjs`                 |

The browser pass ran 15 checks, all passing, on the held server. No network response was intercepted or
rewritten. It found one real defect (Add recording stayed disabled while typing), fixed in the same PR and
re-run green.

## Not proven

- Mac-link card, New meeting and capture gaps (part 12).
- Locale-based dates. The browser's own formatting is used.
- Admin-only versus member wording of the AI-settings hint. Everyone sees the same hint.
- History hiding when no Mac is linked.
- A URL-driven transcript evidence reference. The frame gives no address parameters.
- Summary generation with a real model. No model is configured on the test server, so a request ends as a
  stored failure and the failure remediation text is what shows.
- A second physical device. The phone-size pass is a narrow desktop window.
