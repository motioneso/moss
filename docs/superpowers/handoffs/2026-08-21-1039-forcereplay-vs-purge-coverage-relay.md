# Relay — 1039-forcereplay-vs-purge-coverage

**Issue:** GitHub #1039 ("test: forceReplay vs purge behavior on private chat history"), part of #984.
**Branch/worktree:** `1039-forcereplay-vs-purge-coverage`, same-named worktree. No new branch/worktree needed.
**Coordinator:** pane label "Coordinator" (session `9674b6c7-87b1-4612-afad-361c7f9070fa`), resolve pane fresh by label + session id, never by a `…-N` number.

## What's done (both build tasks complete, both committed and verified green)

- Commit `28757b460` — test(#1039): forceReplay does not override incognito purge. Added test "T2-e" to `tests/integration/chat-private-mode.test.ts`: an incognito thread with rows inserted directly, called with `{ forceReplay: true }`, still returns nothing — proves forceReplay never overrides the incognito guard.
- Commit `8af58b14e` — test(#1039): distinguish forceReplay from purge in ChatSessionManager. New file `tests/unit/chat-force-replay-vs-purge.test.ts` (3 tests): a normal-thread forceReplay relaunch carries retained history into the replay content; an incognito relaunch renders no replay content even with forceReplay true; an incognito relaunch without purge support refuses to launch regardless of forceReplay.
- Both verified individually against an isolated gate database (now dropped) — all tests passed (5/5 in the integration file, 3/3 in the unit file).
- No production code was touched. Working tree was clean before this doc was added.

Note: the plan document this build used
(`docs/superpowers/plans/2026-08-21-1039-forcereplay-vs-purge-coverage.md`) went missing from disk
before it could be committed — likely lost to an environment/filesystem issue in the prior session,
not to any git operation (git history shows no trace of it ever being committed, and nothing else in
the tree was disturbed). The reasoning it captured is preserved below since the actual test code
(which is what matters) is safely committed:
- forceReplay and purge are different mechanisms over different substrates: forceReplay rebuilds a
  database-backed replay window for a freshly launched engine process; purge deletes an engine's own
  on-disk transcript files for a private/incognito session. The issue's "history removed" half maps to
  the incognito database-read guard, since that is the piece the function under test (`listPriorTurns`)
  actually controls.
- The gap this build closed: no existing test had called `listPriorTurns` with `forceReplay: true`
  against an incognito thread with real stored rows, and no test exercised the full session-manager
  launch path to confirm what content actually reaches the freshly launched engine differs between a
  forceReplay relaunch of a normal thread (has content) and an incognito thread (never has content),
  including when forceReplay is explicitly requested on the incognito case.
- If you want the full seams-check citations and file:line evidence again, they're recoverable from the
  git-tracked source files themselves (`packages/chat/src/live/persistence.ts` lines ~179-183 for the
  incognito guard, `packages/chat/src/live/chat-session-manager.ts` lines ~252-263 for the launch guard,
  and lines ~702-713 for `switchProvider` always passing `{ forceReplay: true }`) — no need to
  reconstruct a plan doc before finishing the remaining steps below.

## What's left (in order)

1. Full local gate: `pnpm verify:foundation` under the `verify-gate` skill's exact recipe — create a
   new uniquely-named gate database, `export JARVIS_PGDATABASE=...` (never inline), unpiped command
   with an `echo "### FINAL rc=$?"` sentinel written to a log file, drop the database when done.
2. Pre-push checks: `pnpm format:check && pnpm lint && pnpm typecheck`.
3. `git fetch origin main && git rebase origin/main`.
4. Push the branch, open a pull request against `main`.
5. Fill in the pull request template's "Release note" section: this is a test-only, non-user-facing
   change, so use `Category: N/A` and do not run the release-note append script.
6. Invoke the `coordinated-wrap-up` skill for close-out (it re-checks the tree is clean, re-runs the
   gate check, pushes, opens the pull request if not already open, and reports to the coordinator). No
   live-path UI proof is needed since this is test-only — stated in the original handoff doc's exit
   criteria.
7. Report the pull request link and verification evidence to the coordinator. The coordinator owns
   QA, merge, the project board, and closing the issue — not this lane.

## Kill gate (unchanged, still applies)

If the full gate run reveals that current production code genuinely lets forceReplay leak purged
content (a real bug, not just a coverage gap), stop and escalate to the coordinator before writing any
production-code fix. Do not fix it unilaterally — that would take this lane outside test-only scope.
So far no such bug was found; both new tests passed against the existing code as-is.

## Notes

- Follow the box-wide plain-English rule in all status/handoff/chat messages to the coordinator and
  any other agent — no jargon, name things by what they do.
