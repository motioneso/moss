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

## Added after review

- The shell now reports whether the signed-in person is an instance admin, and the screen reads it through
  the host bridge. Admins see "Check your AI settings in Settings → AI providers." and members see "Ask an
  admin to check the AI settings." The default-model recovery line is worded the same way.
- History hides when there are no meetings, no search, no type filter and no linked Mac, as the old screen did.
- Manifest declares a 30 second call limit, as the other model-using modules do. Without it a real model
  call ended as a server error.
- Real model: the test server's router points at the Codex sign-in through the local model proxy on
  gpt-5.6-luna. A pasted transcript produced a real stored summary, shown on the Summary tab in a browser. The
  key never reached the server log. The earlier automatic attempt, made before a model was set up, still shows
  its failure notice above the new summary.

## Not proven

- Mac-link card, New meeting and capture gaps (part 12).
- Locale-based dates. The browser's own formatting is used.
- A URL-driven transcript evidence reference. The frame gives no address parameters.
- Admin wording of the AI-settings hint in a browser. The test server has no signed-in shell, so the
  browser pass shows the member wording. The admin wording is the same code with the role flag set.
- Mac linked case. Device pairing is parked, so the device list answers 401 and the screen treats the Mac
  as not linked.
- A second physical device. The phone-size pass is a narrow desktop window.
