# Rust port phase 5, Meetings part 12 (screen) report

Task JS-338. Follows part 11. Reproduces the current TypeScript screens with no redesign.

## Built

- Settings screen at `/settings/meetings` (package screen, opens from the Meetings header cog).
  - Linked Macs from the device list, audio source, transcript language, vocabulary (Save, Clear, same
    limits as the server), automatic summary switch, Saving and error with Retry.
- Recording panel on the meeting page: Ready, status and recording badges, Record, Pause, Resume, Stop,
  cancel while starting, gaps list, hints, "New meeting" after Stop. Polls every 1.5 s while live.
  Rewrite summary and Delete are off while recording.
- Meetings home: New meeting button when a Mac is linked, and the Checking, denied, unavailable and
  Link your Mac states.
- Chat read API, provided by Meetings: availability, a transcript snapshot (8 segments, 12,000 characters,
  with personal notes and notes revision), and evidence for a citation. Owner only.
- Deletion callback: deleting a meeting first asks Chat to delete that meeting's threads. A missing Chat is
  ignored. The host reduces every module-call failure to one fixed message, so a Chat that refuses cannot be told
  apart from a missing one, and the delete goes ahead either way.
- Manifest 0.2.0: settings screen, Chat in the allowed module calls (optional), three provided calls, and
  updated app-map feature text. Changelog entry added.

## Proof

| Proof                                                                                                  | Where                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 22 pure-function tests (settings rules, capture status and wording)                                    | `modules/meetings/ui/*.test.mjs`                |
| 7 tests replaying the old Chat caller shapes, plus the deletion call and a failing Chat                | `modules/meetings/tests/chat_read.rs`           |
| Full Meetings gate: native, real component build, package tests, real database                         | `pnpm test:rust-meetings` (exit 0)              |
| Real server over HTTPS, browser at 1280 and 390 wide: home, settings (change and reload), meeting page | `modules/meetings/tools/screen-live-part12.mjs` |
| `pnpm verify:static`                                                                                   | exit 0                                          |

The browser pass ran 14 checks, all passing. No response was intercepted or rewritten.

Two older things were repaired on the way. The Meetings host test did not compile on main (a new field on the
server settings), and a manifest test still expected no screens.

## Not built

- Coming up and the calendar link. The current TypeScript screen has neither, so nothing was ported.
- The strip that follows you across other screens while recording. A package screen cannot draw outside its frame.
- A working Download app button. The old screen's button also does nothing, so the port matches it.
- Unlink for a Mac and the linked-session list. They need device pairing, which has no Rust side yet.

## Not proven

- Linked-Mac states, Start recording, Pause, Stop and gaps against a real Mac. The live server has no device
  pairing, so every Mac check is refused and the screens show the "could not be verified" state.
- The cog in the Meetings header opening the settings screen. The screen was opened by its address.
- Chat calling these APIs. Chat has not been ported. The shapes are replayed from the old caller.
- Chat threads left behind when Chat is installed but fails. The old screen stopped the delete in that case.
  A real server run showed a missing Chat made delete fail with a 500, so the delete no longer waits on Chat.
- The name of the deletion call is unconfirmed. Chat is not ported, so nothing checks it against Chat's own list.
- Chat threads left behind hold private meeting content, with no record left to retry from.
- Chat picks transcript lines by the question. The Rust ledger has no relevance search, so the snapshot returns
  the first 8 segments and ignores the question.
