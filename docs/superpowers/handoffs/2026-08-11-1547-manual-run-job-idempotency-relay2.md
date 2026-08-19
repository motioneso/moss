# Relay 2 — 1547-manual-run-job-idempotency

Successor to `2026-08-11-1547-manual-run-job-idempotency-relay.md` (that doc still has the full
architecture-decision grounding — read it if you need the "why", not repeated here). This doc
supersedes it for task state. Relaying on the context-meter 70% tripwire, mid-task — real progress
made this run, not a zero-progress relay.

**Worktree:** `/home/ben/Jarv1s/.claude/worktrees/build-1547-manual-run-job-idempotency`
**Branch:** `build/1547-manual-run-job-idempotency`, clean, HEAD `82cc0f083`
**Plan (Coordinator-approved, authoritative contract):**
`docs/superpowers/plans/2026-08-11-manual-run-job-idempotency.md`
**Coordinator:** resolve fresh via `herdr pane list`, label `Coordinator` — confirm exactly one
pane, confirm `agent_session.value == 0bb9f516-c026-454f-bc97-dc9faf43bd20`. Already notified of
this relay + the RED confirmation below — no reply needed to proceed.

## What's done (commit `82cc0f083`)

- Plan written and approved by Coordinator: `pg_advisory_xact_lock` + new time-bounded
  `hasRecentJob` check wrapping `boss.send()`, `rootDb` as an optional trailing param, zero changes
  to existing unit tests.
- Task #3 (red test) is **done and confirmed RED for the correct reason**:
  `tests/integration/external-modules-routes.test.ts` — new test `"#1547 dedupes two genuinely
  concurrent manual-run calls that straddle a singleton bucket boundary"` fails as expected:
  `secondRes.json()` returns a real `jobId` instead of `null` (both concurrent calls got a job —
  the documented bug). 5 pre-existing tests in that file still pass.
- **Resolved the prior blocker**: the isolated-DB run needs `dist/app-map.json`, which
  `pnpm test:integration` does NOT build (only the full `verify:foundation` pipeline runs
  `build:app-map` first). Fix: run `pnpm build:app-map` once before `pnpm test:integration` in
  this worktree. This is a generated/gitignored artifact — no repo change, nothing to commit for
  it, but the successor's shell needs it run again if the worktree was recreated or `dist/` was
  cleaned. One command, ~seconds.

Confirm command (expect exit 1, 1 failed / 5 passed, failure at the `secondRes.json()` assertion):
```bash
pnpm build:app-map > /tmp/x.log 2>&1; echo "EXIT=$?"   # expect EXIT=0, run once if dist/app-map.json missing
pnpm test:integration tests/integration/external-modules-routes.test.ts > /tmp/y.log 2>&1; echo "EXIT=$?"
grep -n "Tests \|AssertionError" /tmp/y.log   # expect "1 failed | 5 passed (6)"
```

## Next concrete steps (tasks #4-6, TDD, commit per task)

Task tracker has these as `pending` — claim/advance them in order. Full signatures and pseudocode
are in the plan doc; read it by section, not in full.

4. Add `hasRecentJob` to `packages/jobs/src/pg-boss.ts` — new time-bounded variant alongside the
   existing `hasInFlightJob` (`packages/jobs/src/pg-boss.ts:148-163`, do not modify that one —
   it's used elsewhere and its state-based semantics are intentional there).
5. Add `rootDb?: Kysely<MossDatabase>` trailing param + the locked path to `sendModuleJob`
   (`packages/jobs/src/module-jobs.ts`, currently lines 93-110) — `pg_advisory_xact_lock` keyed
   off the singleton key → `hasRecentJob` check inside that transaction → `boss.send()` if none
   found → commit (releases lock) only after `boss.send` resolves.
6. Thread `rootDb` through `apps/api/src/external-module-jobs.ts`
   (`registerExternalModuleJobRoutes`, deps at lines 66-82) and its registration in
   `apps/api/src/server.ts` (~line 386-393, pass `rootDb: appDb` matching the existing pattern at
   ~line 495). Re-run the race test — expect GREEN (`6 passed`), plus the full
   `external-modules-routes.test.ts` suite still green, plus existing `module-jobs`/`pg-boss` unit
   tests untouched per the plan's "zero changes to existing unit tests" commitment — verify that
   claim, don't just assume it.

Then task #7: pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on
`origin/main`, `coordinated-wrap-up` (isolated gate-DB run via `verify-gate` skill, push, open PR
stating explicitly "no live-path UAT required — backend-only job-dedupe logic, no UI surface" per
the spec, report to Coordinator).

## Standing constraint from Coordinator

"Flag me again only if the harness proves flaky in practice, not just in theory" — re the
DB-clock-polling boundary-forcing mechanism (`waitForBoundaryApproach`/`waitForDbEpochAtLeast` in
the test file). Already cleared as routine-tier, no Opus escalation. Only re-escalate if the race
test itself flakes across real runs, not for the residual-risk framing already discussed.

## Reminder for the build

`pnpm exec tsc --noEmit` on new/edited `.ts` files before the first full gate attempt — vitest's
transform doesn't do full `tsc` checking and will miss `noUncheckedIndexedAccess`/`TS2352` issues
that only show up at gate time otherwise.
