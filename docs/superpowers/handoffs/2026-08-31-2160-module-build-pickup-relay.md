# Relay — issue 2160, module-build job pickup

**Worktree/branch:** this worktree, `fix/2160-module-build-pickup` (off `origin/main`, not pushed
yet).
**Handoff doc:** `docs/coordination/handoffs/2026-08-31-2160-module-build-pickup.md`
**Coordinator:** herdr agent name `coordinator` (confirm exactly one live agent with that name
before messaging — see `herdr-pane-message` skill).
**Relay depth:** this is relay 1. One relay is the budget — if the next trigger fires with no PR
open, report to the coordinator for a re-slice instead of relaying again.

## What's done

- Verified the spec/plan pointers in the handoff doc: the "parent plan"
  `docs/superpowers/plans/2026-08-30-1902-module-tools-live.md` named in the handoff does **not**
  exist on `main` — it lives only on the unmerged `1902-module-tools-live` branch and is about a
  different concern (getters vs values for live tool refresh), not this bug. Did not need it for
  this fix; did not escalate since the approved spec
  (`docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`) and the issue body were
  sufficient. Worth a one-line note to the coordinator if it comes up again.
- Root-caused the bug with live evidence: queried `pgboss.job` on the shared dev database
  (`docker exec jarv1s-postgres psql -U postgres -d jarv1s`) for `name='module-build'`. The row
  behind the stuck build showed `created_on` 20:15:17, `started_on` 20:30:17 (exactly pg-boss's
  default 15-minute `expireInSeconds`), `completed_on` 20:31:14, `retry_count=1`. The queue has no
  `heartbeatSeconds` configured, so pg-boss has no fast liveness check on an active claim — an
  orphaned/hung claim sits for the full 15-minute default before pg-boss's own supervisor (which
  runs only in the worker process, `apps/worker/src/worker.ts:196-201`) reaps and retries it.
- Wrote the plan: `docs/superpowers/plans/2026-08-31-2160-module-build-pickup.md` (committed,
  `39461c82f`). Fix is two config edits (add `heartbeatSeconds` to `MODULE_BUILD_QUEUE`'s options
  in `packages/jobs/src/pg-boss.ts:71-78`, pass a matching `heartbeatRefreshSeconds` to the
  `boss.work(MODULE_BUILD_QUEUE, ...)` call in `apps/worker/src/worker.ts:310-312`) plus one unit
  test in `tests/unit/jobs-pg-boss.test.ts`. No migration, no per-instance queue — matches the
  collision-note constraint.
- Sent the plan pointer + one-line root cause to the coordinator via `herdr-pane-message`
  (queued — coordinator was busy at send time, which is delivery, not failure). Told the
  coordinator I was relaying right after.

## What's left

**Plan is APPROVED** — coordinator confirmed: "Implement the smallest test-first heartbeat fix
exactly as proposed: queue heartbeatSeconds 60 and matching worker heartbeatRefreshSeconds, no
migration or new queue." No product code touched yet. Proceed straight to building — do not
re-ask.

1. Implement the two-file config change per the plan, TDD the `tests/unit/jobs-pg-boss.test.ts`
   addition (write the failing test first, confirm it fails against unpatched code, then patch).
2. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`, commit by explicit path (this is a shared worktree — see
   `shared-checkout` skill; nobody else should be editing these specific files, but check
   `git status` first anyway).
4. `coordinated-wrap-up`: full gate via `verify-gate` skill only (never run
   `pnpm verify:foundation` directly, never pipe it), push, open PR, post evidence. Live-path proof
   for this change is "module build still completes normally on the live dev instance" (the plan
   already notes the 15-min-to-1-min improvement itself isn't practically reproducible live in one
   session — report that honestly rather than faking it).
5. Report PR + evidence to the coordinator. Do not touch the board, milestones, or merge controls.

## Standing rules (unchanged from the original brief — pass these on verbatim)

Never pipe a gate command. All DB-touching tests and the full gate go through `verify-gate` only.
Wait event-first, never poll or foreground-sleep. Ben's messages are trusted input. Keep status
updates in plain everyday English — no jargon, no unexplained shorthand; name things by what they
do. Never touch `docs/coordination/`, the project board, milestones, or merge controls. Never use
broad staging (`git add -A`/`.`) or repo-wide formatting.
