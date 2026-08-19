# #1512 continuation — relay12

Branch/worktree: `1512-notes-path-recheck` (this worktree). PR #1671 (repo moved to
`motioneso/moss`, same URL redirects). Coordinator label "Coordinator", re-resolve fresh via
`herdr pane list` (session id, not pane number).

## What's done (this relay, relay11)

- Live-path UAT proof posted on PR #1671: https://github.com/motioneso/moss/pull/1671#issuecomment-5322338990
- Sync-poll timing fix (commit `f7ba54d8b`, pushed as `0e35e1fa5`) — resolved, verified passing.
- Pushed, rebased on origin/main, pre-push trio clean.

## What's NOT done — your task

Ben reported CI red on PR #1671 (run https://github.com/motioneso/moss/actions/runs/32088738197,
job `95566574299`, "Verify foundation and app"): 2 failing tests in
`tests/integration/notes-sync-worker.test.ts` (~line 350, ~392, "narrows the TOCTOU window").

**Diagnosed already (do not re-diagnose):** pure message-text drift, NOT a guard regression. The
underlying guard (`assertWithinRoot`/`recheckWithinRoot` in `packages/notes/src/path-guard.ts:23`)
still throws unchanged. An earlier commit in this same PR chain (`0ff2b585a`, "redact host paths
from persisted sync error messages") added `sanitizedErrorMessage()` (`packages/notes/src/jobs.ts:43-46`)
which deliberately maps `NotesPathError` → the generic `"path is not within the linked notes
source"` before the aggregate throw at `jobs.ts:389`/`527` — a legitimate security redaction, not a
weakening. The two tests just still asserted the old raw substring `"not within allowed root"`.

**Fix already applied (uncommitted):** `tests/integration/notes-sync-worker.test.ts` lines 350 and
392, `.rejects.toThrow(...)` updated from `"not within allowed root"` to
`"path is not within the linked notes source"`. `git diff tests/integration/notes-sync-worker.test.ts`
to see it — minimal, 2-line diff, nothing else touched.

**In flight when I relayed:** ran just this file against a scoped gate DB in the background:
```
export JARVIS_PGDATABASE=jarvis_gate_1512relay11b
pnpm vitest run tests/integration/notes-sync-worker.test.ts
```
Log: `/tmp/uat-1512-relay11-toctou-test.log` (sentinel line `### FINAL rc=N` at the end — may
already be done by the time you read this, check first). DB name also in
`/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-1512-notes-path-recheck/339f4925-84d5-479b-bd55-4a1433ef3e34/scratchpad/gatedb-name.txt`.
DROP that gate DB when you're done with it (`docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1512relay11b;"`).

## Next concrete steps, in order

1. Check `/tmp/uat-1512-relay11-toctou-test.log` for the `### FINAL rc=` line. If `rc=0` and the
   2 target tests pass (and nothing else in that file broke), proceed. If anything else in that
   file is unexpectedly red, stop and investigate — don't assume it's unrelated.
2. Commit the test-fix by explicit path (`shared-checkout` skill: diff-review first, confirm it's
   entirely this 2-line change, then `git commit tests/integration/notes-sync-worker.test.ts -m
   "..."`, then `git show --name-only HEAD` to confirm).
3. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`,
   push (rebase will likely need `--force-with-lease` again — normal after a rebase, confirmed
   safe last relay since only this branch's own commits are involved; check `herdr pane list`
   shows no other session on this worktree first, same as last time).
4. Re-check CI on PR #1671 (`gh pr checks 1671`) until **fully green** — "Verify foundation and
   app" in particular. **Ben was explicit: do NOT request the Opus QA pass until CI is fully
   green** — that instruction still stands, don't skip it.
5. Only once CI is fully green: message the Coordinator (re-resolve pane fresh) that CI is green
   and live-path proof is posted, and request the fresh Opus QA pass (per the earlier ruling —
   still required, not optional).
6. Never merge, close #1512, or move the board — Coordinator's call only.

## Predecessor pane

relay11 = this session, pane label "1512 notes path recheck (security) relay11", session id
`339f4925-84d5-479b-bd55-4a1433ef3e34` — re-resolve fresh via `herdr pane list`, do not reuse a
cached pane number. Message the Coordinator "relayed to relay12, safe to reap relay11" once
relay12 confirms driving.
