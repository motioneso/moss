# Relay 4 → 5 — #1141 credential-env isolation

**Issue:** #1141. **Risk tier:** security. **Branch/worktree:** this one,
`1141-credential-env-isolation`. **PR:** https://github.com/motioneso/moss/pull/1601.

## Status: all 3 QA-RED blocking items + the fast-follow are DONE. Only step left: re-request QA.

Relay3's doc (`2026-08-13-1141-credential-env-isolation-relay3.md`, same dir) has full background —
don't re-read it, everything needed is below.

### Done this relay (verified, not just claimed):
1. **CI** — resolved pre-window: issue #1607 (pre-existing flake), evidence at
   https://github.com/motioneso/moss/pull/1601#issuecomment-5287343919
2. **3 blocking UAT specs** — all run live, all passed (only pre-existing `test.fixme`s for
   unrelated #1121). Proof posted:
   https://github.com/motioneso/moss/pull/1601#issuecomment-5287457289. Advisory spec
   (`1089-1090-chat-drawer-private`) explicitly not run — justified in the comment (PR touches no
   chat-drawer files).
3. **PR body reworded** — defence-in-depth framing, corrected Live-path gate section, new
   "Deferred / follow-up" section linking #1612. Applied via `gh api PATCH` (jq-built JSON payload —
   `gh pr edit --body-file` no-op'd twice, known trap, see memory `gh-pr-edit-body-silently-fails.md`).
   **Full body re-verified** via `gh pr view 1601 --json body -q .body` — all sections present and
   correct (Summary, Verification, Deferred/follow-up, Release note).
4. **Fast-follow filed** — issue #1612 ("chat-multiplexer: real-tmux spawns inherit full
   process.env (ambient HOME) — same bug class as #1141"), filing only, no fix built.

## Only remaining task: re-request QA-1141

1. Re-resolve the coordinator fresh via `herdr agent list` — confirm by label "Coordinator" or name
   containing "coord". **Do not trust any name/pane/session id baked into any prior relay doc** —
   panes reflow between sessions.
2. Send: "PR #1601 updated after QA-1141 RED verdict. CI: pre-existing flake #1607, evidence
   linked. 3 blocking UAT specs run live with proof:
   https://github.com/motioneso/moss/pull/1601#issuecomment-5287457289. Security framing reworded
   to defence-in-depth (verified via `gh pr view --json body`). Fast-follow issue #1612 filed for
   the chat-multiplexer ambient-HOME gap (not fixed, out of scope). Ready for QA re-run."
3. Standing constraints (unchanged): never merge #1601, never touch the project board, never close
   #1141 — Ben's explicit sign-off tier on this security work.

## After QA responds
- If GREEN: report to Ben that #1141 is ready for his merge sign-off. Do not merge yourself.
- If RED again: read the new verdict, triage findings, repeat the fix/reword/UAT cycle as needed —
  spin up a fresh relay doc rather than continuing in a long-running context.
