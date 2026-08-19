# Relay 4 — 1591-owner-scope-reorder

**Issue:** #1591. **Risk tier:** security. **Worktree/branch:** this worktree,
`1591-owner-scope-reorder`. Worktree confirmed single-occupant (re-verified via `herdr pane list`
— stale relay3 pane is gone).

## Plan approval

Fable APPROVED (relay2 doc). **PR body must state known behavioral delta**: confirming an
already-resolved action-request row now 404s `not_found` instead of 409 `expired` (full wording in
commit `42b9bd053`'s body — copy it into the PR description).

## Done (commits, in order, all before this leg)

- `42b9bd053` Task 1+2, `78775299f` Task 3, `885883191` prettier fix, `542f05df4` relay3 doc.
  Working tree is clean; nothing to commit from those.

## This leg (relay4)

- Re-verified worktree single-occupancy.
- Gate retry #5 (this leg's 1st): ran clean, but `pnpm db:migrate` failed with Postgres
  `tuple concurrently updated` (XX000) — same contention class relay3 already saw. `test:unit`
  passed 556/556 files, 4477/4479 tests (incl. new `gateway-resolve-owner-scope.test.ts`).
  lint/format/typecheck all green. Full log: `/tmp/1591-gate.log` (may be overwritten by later
  attempts — check mtime).
- Gate retry #6 (before that, discarded): hung — 0% CPU across the whole process tree for 10+ min,
  **and zero active queries** against its own gate DB in `pg_stat_activity` (confirmed hung, not
  slow). Killed cleanly, DB dropped/recreated, re-ran (became retry #5 above... numbering is fuzzy,
  point is: 6 total gate attempts across both relays, 0/6 clean, every single failure/hang
  unrelated to this branch's diff).
- Ben (the actual user) intervened directly mid-session: "coordinator is compacting, use
  /codex:rescue for this." Dispatched `codex:codex-rescue` subagent with full context (contention
  theory, diff scope, gate recipe, ask: root-cause + attempt one more clean run). It kicked off an
  async Codex companion task: **`task-mss2osdw-3eysxx`** — check `/codex:status task-mss2osdw-3eysxx`
  for its result. Not yet checked as of this doc.

## Not done — pick up from here

1. Check `/codex:status task-mss2osdw-3eysxx`. If it got a clean green `pnpm verify:foundation`
   run, use that as gate evidence. If it only confirms the contention diagnosis without a clean
   run, that's sufficient per relay3's own guidance below — don't retry-loop further.
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (already green in gate retry
   #5 above, but re-confirm after any rebase), then `git fetch origin main && git rebase
   origin/main` (origin/main has moved — currently 8 commits ahead of this branch's merge-base;
   re-check before rebasing).
3. `coordinated-wrap-up`: clean tree, push, open PR tagged `[SECURITY]`, rebased on `origin/main`.
   **PR body must state the known 404-vs-409 behavioral delta** (see commit `42b9bd053` body) AND,
   if no clean full gate run was obtained, must honestly state: typecheck/lint/unit tests green on
   every attempt; this branch's specific integration test
   (`tests/integration/ai-assistant-action-resolve.test.ts`) passed standalone 5/5 (relay3); full
   `verify:foundation` blocked end-to-end by repeated cross-lane Postgres contention on this shared
   dev box (6 attempts, 0 failures ever touching this branch's diff — root cause per Codex if it
   reported one). Report PR + evidence to Ben directly (coordinator was compacting this leg).
   **Do not merge, close, or touch the board** — needs Ben's explicit merge sign-off.

## Run-specific bans (unchanged from relay3)

- Work only in this worktree/branch; `git add`/`git commit` by explicit path only (shared-checkout
  skill).
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets in any doc/payload/log/prompt.
- #1592 is queued behind this lane.

## Relay trigger

Context-meter 70% warning, right after dispatching the Codex rescue agent for gate contention
diagnosis. Successor: read this doc in full (short by design), check the Codex task status first,
then resume at "Not done" above.
