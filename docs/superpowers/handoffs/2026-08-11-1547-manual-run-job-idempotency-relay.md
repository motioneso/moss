# Relay — 1547-manual-run-job-idempotency

Successor to `docs/superpowers/handoffs/2026-08-11-1547-manual-run-job-idempotency-build.md`.
Relaying on the compaction-summary tripwire (coordinated-build step 3) — no code written yet, no
commits. Read the original handoff doc too; this only adds what changed.

**Worktree:** `/home/ben/Jarv1s/.claude/worktrees/build-1547-manual-run-job-idempotency`
**Branch:** `build/1547-manual-run-job-idempotency` (clean, nothing to commit)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`, confirm exactly one
pane, confirm `agent_session.value == 0bb9f516-c026-454f-bc97-dc9faf43bd20` before messaging.
Already notified once this run (relay-in-progress ping) — no reply needed to proceed, just don't
re-notify redundantly.

## Grounding already done (don't redo)

Confirmed from installed `pg-boss@12.18.2` source (`node_modules/.pnpm/pg-boss@12.18.2/...`, read
via `node -e "fs.readFileSync(...)"` / `require(...)` — direct `Read`/`Bash cat` on `node_modules`
paths is denied in this environment, the `node -e` route is not):

- `singleton_on` is computed as a fixed epoch-anchored grid
  (`'epoch'::timestamp + '1s'::interval * (singletonSeconds * floor((epoch_now + offset) / singletonSeconds))`,
  `plans.js` ~line 948), enforced by unique index `job_i4` — confirms the spec's bug account.
- No native sliding-window singleton option exists. `sendThrottled`/`sendDebounced` use the same
  fixed grid; `sendDebounced` only delays the retry to the next grid slot. **Rules out spec
  candidate (b).**
- `manager.js` `createJob` accepts an undocumented `options.db` wrapper to redirect the INSERT onto
  an external connection — **rejected**, too undocumented/risky to depend on.

Full detail saved to agentmemory: `mem_msoxx1uf_a5527177db61` (project `jarv1s`, type
`architecture`) — recall it, don't re-derive.

## Design decision (locked, not yet built)

Fix candidate **(a)**: `pg_advisory_xact_lock` + a **new time-bounded** existence check, wrapping
the existing `boss.send()` call, landing in `packages/jobs/src/module-jobs.ts` →
`sendModuleJob` (currently lines 93-110, read in full already — no db param today).

- **Not** the existing `hasInFlightJob` (`packages/jobs/src/pg-boss.ts:148-163`) unmodified — it's
  state-based with no time bound, so reusing it as-is would block a legitimate manual rerun past
  the 5s window, violating the #965 "don't block a deliberate rerun" intent the spec locks in.
  Need a **new** variant/query: `created_on >= now() - singletonSeconds interval` (seconds bound,
  not just state).
- `sendModuleJob` will need a new `Kysely<MossDatabase>` param (likely `appDb`, sourced the same
  way `apps/api/src/server.ts` already passes `rootDb: appDb` at line ~495) to run the
  advisory-lock-guarded transaction. Call site `apps/api/src/external-module-jobs.ts:66-82`
  (`registerExternalModuleJobRoutes`, `deps` currently has no db handle — will need one threaded
  in) and its registration at `apps/api/src/server.ts:386-393` will both need edits.
  `apps/api/src/external-module-jobs.ts` (96 lines) and `packages/jobs/src/module-jobs.ts` (111
  lines) are both on the spec's "Exclusive owned surface" list.
- Sequencing: acquire `pg_advisory_xact_lock` keyed off the singleton key → run the time-bounded
  existence check inside that same transaction → if none found, call `boss.send()` → let the
  transaction commit (releasing the lock) only after `boss.send` resolves. This guarantees a
  second concurrent caller's post-unblock read sees the first caller's already-committed job row —
  sidesteps the actual defect (competing epoch buckets) rather than trying to force both inserts
  into the same bucket.
- Preserve exactly: singleton key composition `manual:<moduleId>:<queueName>:<actorUserId>`, the
  202 / `{jobId}` / `{jobId:null}` UX contract, metadata-only payload invariant (no new payload
  fields — this fix is pure control-flow, doesn't touch `ExternalModuleJobPayload`), the 5s
  double-click-catches / deliberate-rerun-doesn't-block intent from #965. No new table/migration.

## Not yet done — the actual next steps

1. **Test harness design (open, not started).** The spec locks a "Boundary-forcing technique"
   requirement: the reproduction test must deterministically pin two concurrent
   `server.inject`-style manual-run calls' pg-boss inserts onto opposite sides of a real 5-second
   epoch boundary tick, via a controlled DB-side barrier (not client-side wall-clock timing alone).
   Needs a concrete mechanism — e.g. an explicit held-open transaction or a `pg_advisory_lock`
   keyed to the test that pins timing — worked out before writing the plan. Re-read the spec's
   "Boundary-forcing technique" and "The flaking test is collateral, not proof" sections
   (`docs/superpowers/specs/2026-08-11-1547-job-idempotency-race.md`) for the exact locked
   contract (7 numbered criteria) — read BY SECTION, not the whole file again.
2. Write the `plan-build` plan (`docs/superpowers/plans/2026-08-11-<slug>.md`) — decisions only
   (signatures, DDL if any, test cases as behavior+why-they'd-fail, verification commands with
   exit codes), no function bodies. Seams check already mostly done above; cite `file:line`.
3. Escalate the plan to the Coordinator, **STOP and wait for approval** — no code before it.
4. Build via TDD (`superpowers:test-driven-development`), commit per task.
5. Before every push: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
6. Close out via `coordinated-wrap-up`: isolated gate-DB run, PR open + rebased, and **the PR must
   explicitly state no live-path UAT is required** — this is backend-only job-dedupe logic, no UI
   surface, per the spec's own text. Don't silently omit the live-path statement.

## Reminder for the build itself

`pnpm exec tsc --noEmit` on new/edited `.ts` files before the first full gate attempt — vitest's
transform doesn't do full `tsc` checking and will miss `noUncheckedIndexedAccess` /
`TS2352` cast issues that only show up at gate time otherwise.
