# Build Handoff — 1547-manual-run-job-idempotency

**Spec (approved):** docs/superpowers/specs/2026-08-11-1547-job-idempotency-race.md (merged via PR #1568 as `3c5845a44`)
**GitHub issue:** #1547
**Risk tier:** `routine` — payload shape and UX contract are explicitly locked unchanged by the spec (no new table/migration, no RLS, no user-facing feature), so the "job-payload shape changes" sensitive-tier trigger does not fire. Standard QA (CI gate + `/code-review` + exit-criteria); auto-merge after green.
**Worktree:** `/home/ben/Jarv1s/.claude/worktrees/build-1547-manual-run-job-idempotency` **Branch:** `build/1547-manual-run-job-idempotency` (off `origin/main` at `02951d46b`)
**Build skill path (absolute):** `/home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh (never a cached pane number).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20` (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context → message the coordinator, then use the `relay` skill immediately.

## Bug summary (from the approved spec)

`POST /api/modules/:moduleId/queues/:queueName/run` (`apps/api/src/external-module-jobs.ts` → `sendModuleJob` in `packages/jobs/src/module-jobs.ts:93`) relies entirely on pg-boss's native `singletonKey`/`singletonSeconds` as the idempotency boundary — nothing else checks for an in-flight duplicate before `boss.send`. pg-boss buckets singleton dedupe on a **fixed epoch grid** (`singleton_on`), not a sliding window — two "simultaneous" double-click sends that straddle a bucket edge both get real, distinct job ids instead of deduping. Response is always HTTP 202 with `{ jobId }` or `{ jobId: null }` on pg-boss-detected duplicate.

Fix must land at the shared idempotency boundary ahead of `boss.send` — candidates per the spec: `pg_advisory_xact_lock`/an explicit `hasInFlightJob` check, or check whether `pg-boss` (confirm installed version) offers a native sliding-window option before hand-rolling one. No new table/migration. Payload shape and UX contract (202 + `{jobId}`/`{jobId:null}`) stay exactly as-is. Needs a DB-forced (not wall-clock-timed) deterministic red-then-green reproduction test — a flaky wall-clock race test is not acceptable proof.

Read the full spec's "Dedupe enforcement", "The defect", "The flaking test is collateral, not proof", and "Same shape elsewhere, out of scope" sections yourself for exact acceptance criteria — this doc only summarizes.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify spec against branch → plan with **`plan-build`** → coordinator approval (no code before it) → TDD build → **`coordinated-wrap-up`**.

## Exit criteria

- Spec Exit Criteria met, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Live-path proof: this is backend job-dedupe logic with no UI surface — if truly no user-facing surface, state that explicitly in the PR per Live-Path Gate rules rather than silently omitting it.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known. `#1352` (CLI-runner liveness accounting) is separately blocked behind #1557/Fable and does not touch this path.
