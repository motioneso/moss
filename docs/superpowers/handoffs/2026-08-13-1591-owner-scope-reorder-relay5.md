# Relay 5 — 1591-owner-scope-reorder

**Issue:** #1591. **Risk tier:** security. **Worktree/branch:** this worktree,
`1591-owner-scope-reorder`. Single-occupant confirmed via `herdr pane list` (only
`1591-owner-scope-relay4`/this session's agent, session `0a6ce4a3-d384-4393-88dc-a599db2adf37`, at
this cwd — the several `1591 gate shell A-F` panes are leftover raw terminal panes from background
bash runs this session, not other agents).

## Plan approval

Fable APPROVED. **PR body must state known behavioral delta**: confirming an already-resolved
action-request row now 404s `not_found` instead of 409 `expired` — full wording is in commit
`42b9bd053`'s body, copy it into the PR description verbatim.

## Done (commits, all before this leg)

`42b9bd053` Task1+2, `78775299f` Task3, `885883191` prettier fix, `542f05df4` relay3 doc,
`9501e567d` relay4 doc. Working tree clean.

## THIS LEG — GATE IS FULLY GREEN (first clean run, after 6 prior contention failures)

Ran the isolated gate recipe (`GATEDB=jarvis_gate_1591t3`, DROP/CREATE, `JARVIS_PGDATABASE`
exported) with a subshell sentinel this time (`( pnpm verify:foundation > log 2>&1; echo "### FINAL
rc=$?" >> log ) &`) so the exit code is reliably captured (a bare top-level `echo "EXIT=$?"` on the
attempt before this one never printed — the wrapper's own "completed" task-notification is NOT the
gate's real exit code, do not trust it, always wait for a real sentinel line in the log).

**Result: `### FINAL rc=0`. 191/191 test files passed, 1894 tests passed, 2 skipped (1896 total).**
Full log was at `/tmp/1591-gate-retry2.log` (gate DB already dropped/cleaned up — do not recreate
it, the run is done and evidence is captured here and in this doc).

Pre-push trio also independently confirmed green (run directly, not through the gate):
`format:check=0`, `lint=0`, `typecheck=0`.

`git fetch origin main` done (read-only, safe mid-run). As of this doc: `ahead 8, behind 12` on
origin/main — moving fast, re-fetch immediately before rebasing.

## Not done — pick up from here

1. `git fetch origin main` again (branch moves fast on this box), then `git rebase origin/main`.
   Re-verify single-occupancy first (`herdr pane list`) per shared-checkout skill — a rebase
   rewrites the working tree, unsafe if another session is mid-build here.
2. Re-run the pre-push trio after rebase to reconfirm (`pnpm format:check && pnpm lint && pnpm
   typecheck`) — cheap, do it even though it was green pre-rebase.
3. `coordinated-wrap-up`: push branch, open PR tagged `[SECURITY]`, rebased on `origin/main`. PR
   body must state the known 404-vs-409 behavioral delta (commit `42b9bd053`) AND the gate evidence:
   full `pnpm verify:foundation` green (191/191 files, 1894 passed/2 skipped, rc=0) — first clean run
   after 6 prior attempts blocked by cross-lane Postgres contention on this shared dev box (all
   contention failures landed on files unrelated to this branch's diff — documented in relay3/4
   docs, same dir, if more detail is wanted).
4. Report the PR + gate evidence to Coordinator (resolve pane fresh via `herdr pane list` — last
   known label `Coordinator successor`, agent session `019ffed3-094a-7032-842e-3a1f6c5ca9d0`, but
   re-resolve, don't trust this). **Do not merge, close, or touch the board** — needs Ben's explicit
   sign-off, security tier.

## Run-specific bans (unchanged)

Explicit-path commits only (shared-checkout skill). Never touch `docs/coordination/`, the board, or
merge anything. No secrets in any doc/payload/log. No screenshots for this issue's proof (Coordinator
instruction this leg — functional/gate evidence only). #1592 queued behind this lane.

## Relay trigger

Context-meter 70% warning, immediately after the gate went fully green for the first time.
Successor: read this doc in full, then go straight to "Not done" above — no need to re-run the gate,
it's already clean.
