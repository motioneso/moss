# Rust phase 5, Scratchpad part 3 (screen) report

Task JS-355, Card 610. Scope: the package screen and its persistent shell slot.
Source of truth: the six Scratchpad frames approved on 2026-11-18 in
`docs/superpowers/specs/mockups/scratchpad-commitments/`, served as their README describes.
The pad sits beside chat, and its header cog opens settings.

## Built

- Signed package editor and settings screens; both use the shipped Park Press stylesheet and fonts. No TypeScript screen existed to copy.
- Pencil beside Chat, a persistent draft across shell navigation and hiding, saved shortcut, desktop panel and exclusive phone sheet.
- Plain Markdown textarea, list continuation, indentation, inline formatting, serialized autosave, save status, count and size limit, explicit conflict Reload, and failed-save retry.
- Clean external append refresh with the appended text highlighted. Dirty drafts pause on conflict and keep their text until Reload.
- Header cog settings: record/reset a shortcut; copying to notes is disabled when no folder is connected, with a Connections action.
- Manifest screens, settings, features and error/remediation declarations updated together. UI files are included in the signed package and checked by the package test.

## Verification

- `test:rust-scratchpad` through `scripts/run-gate.sh`: **30 Rust tests passed**, no failures (16 guest, one host conformance, six package, four installed, three chat). Its initial UI run passed all 11 tests; the final UI suite passes **12 tests**.
- Added a regression check for a transient read failure: **11/12 before, 12/12 after** clearing the stale error on a successful unchanged refresh.
- `verify:static`: **passed, exit code 0** (un-piped).
- Scoped ESLint and Prettier checks: passed after the final UI changes.
- Final signed package installed on the real Rust HTTPS server in this worktree, using the safe gate's disposable database and a claimed dev port bound to the home network. No intercepted or faked network replies.

## Live proof

The final recorded browser run passed all of these checks:

| Approved frame / state | Observed result                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pad-open`             | Empty editor then a real typed note, Saved; retained across shell navigation and a full reload. Desktop panel 340 × 420, 24 px from viewport right/bottom.                                                                   |
| `pad-with-chat`        | Actual Rust chat drawer beside the pad: 404 px drawer, 12 px gap, both 18 px from the bottom. No overlap. Approval-card limitation below.                                                                                    |
| `pad-appended`         | Real approved append returned 200; the clean editor refreshed and highlighted the appended line with Added to your scratchpad.                                                                                               |
| `pad-settings`         | Header cog opens settings; shortcut changed and reset through the controls; no-folder switch disabled.                                                                                                                       |
| `pad-phone`            | Actual 390 × 844 viewport is filled by the sheet, with the back chevron and header cog.                                                                                                                                      |
| `pad-phone-conflict`   | First tab kept an offline draft, second tab saved through its editor, and restoring the first tab's connection showed Changed elsewhere without replacing its draft. Explicit Reload then loaded the stored second-tab text. |
| Broken save            | Real offline failure showed Not saved and recovery guidance; draft survived closing and reopening the pad.                                                                                                                   |
| Shortcut               | Saved default opened from the shell and closed from the focused Scratchpad guest.                                                                                                                                            |

Initial loading/unavailable behavior and failed-read retry are also covered by the editor model tests.

The browser uses this task's Herdr session. Real note text is entered through the editor's input handling, and settings are changed through their controls. The held live fixture grants an exact persisted one-use approval and calls the real HTTPS append route; it does not replace or intercept the server response.

The live check found a fixed-position panel trapped by the topbar backdrop filter. Moving the persistent panel into a body portal restored its viewport position. The isolated guest's narrow viewport also triggered the shared phone control minimums on desktop; desktop layout now retains the authored small buttons while the actual phone layout keeps its phone controls.

## Independent review corrections

The first read-only Claude review found two major issues. Both were reproduced in the actual installed package: Ctrl+M followed by Tab stayed in the textarea, and a long note's appended line was clipped below a non-scrolling preview.

- Ctrl+M now switches Tab between indentation and moving among controls. A visible keyboard hint appears when Tab indentation is used, and the textarea also describes the shortcut to assistive technology. Escape still closes the pad.
- Appended text wraps and scrolls into view. Subsequent refreshes preserve the reader's scroll position, and returning to the textarea keeps the preview's position.

Round two found an additional major case: an append received while the pad was closed. The live reproduction confirmed zero layout height while hidden, an off-screen append after reopening, and focus left outside the pad. The correction keeps the scroll pending until the preview has layout and focuses the visible preview when opening. The same live case now passes with the appended line visible and focus in the preview; all six frames and the earlier keyboard/scroll checks passed again. Both allowed review rounds have been used; this last correction requires another independent review before the task can be marked ready.

The following review findings remain below the required major/blocker fix threshold:

- Connections is the canonical destination required by the approved mockup, but its full Rust screen is not ported yet. The link currently reaches the shell's not-ported placeholder; building Connections is outside this part.
- With copying already enabled and the notes folder later disconnected, the missing-folder switch remains disabled until a folder is connected again. The default no-folder state matches the approved mockup.
- The persistent hidden guest still checks for changes every two seconds.
- Shortcuts in another package's focused iframe remain unverified, as noted below.
- The package source/test changes include the repository formatter's surrounding Rust layout changes.
- A saved Ctrl+M shortcut conflicts with the editor's Tab-mode toggle; Ctrl+Shift+M also triggers the toggle.
- Formatting controls operate on the textarea's selection while the appended-text preview is shown.

## Repeating the live setup

From `~/Jarv1s`, set `CARGO_HOME`, `RUSTUP_HOME` and `CARGO_TARGET_DIR`, then run the live gate through `scripts/run-gate.sh start --gate test:rust-scratchpad-live`. Optional screen-proof variables:

- `MOSS_SCRATCHPAD_SCREEN_WEB`: scratch output directory for the actual Rust shell build.
- `MOSS_SCRATCHPAD_HOLD`: existing scratch directory; the fixture writes `url.txt` after its assertions and holds its disposable database/server until `finished` exists there.
- `MOSS_SCRATCHPAD_HOST`: home-network host address; the test listener binds every interface and trusts that origin.
- While held, writing an append to `append.txt` in the hold directory asks the trusted fixture to grant the exact one-use approval and execute the real route. `appended.txt` records its status. This mechanism exists only in the ignored integration test.

The fixture waits for server readiness with a bounded timeout; it never waits on the server job itself. Finish the hold to let the gate remove its server, port claim and disposable database.

## Not proven

- The Rust chat drawer does not yet render tool approval cards. The `pad-with-chat` frame was checked for the pad beside the real drawer; the approved append path was exercised through the trusted fixture, rather than a rendered Approve button or a model conversation. No model pass was run.
- A physical phone or a second physical device was not used; the browser uses the home-network address at a phone-sized viewport.
- A connected notes folder and actual notes-file copying were not exercised; the missing-folder setting state was checked.
- Saved shortcuts were checked in the shell and Scratchpad guest, not while another opaque package guest owns keyboard focus.
