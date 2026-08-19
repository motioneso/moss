# Relay handoff #2 — 1279-external-module-gateway-validator

Relaying at context-meter 70% warning (coordinated-build step 3). Build is DONE and green — only
`coordinated-wrap-up` remains (full gate + push + PR + report).

## Task

GitHub issue **#1279**. Plan (approved by coordinator, no fork): `docs/superpowers/plans/2026-08-16-1279-external-module-gateway-validator.md`.
Risk tier: **security** — adversarial Opus QA + Ben's explicit merge sign-off required before
merge (that's coordinator/QA's job, not yours). Internal-only (module-registry validator + test,
no UI surface) — **no live-path/UAT proof needed**, state that explicitly in the PR.

Coordinator label `Coordinator`, agent name `coordinator-take25` as of this writing — **re-resolve
via `herdr pane list` before messaging, do not trust either value**. Already messaged twice this
run (plan approval request + none since); it has NOT yet seen the "build complete" report — send
that fresh.

## What's done (3 commits, tree clean, all on this branch)

1. `09531d07f` — `packages/ai/src/gateway/input-validation.ts`: `validateToolInput` now takes
   `{ readonly external: boolean; readonly toolName: string }`, wraps its body in one try/catch
   that re-throws `ToolInputValidationError` with `` `Tool ${toolName}: ${original.message}` ``.
   Updated the 3 production call sites: `packages/ai/src/gateway/gateway.ts:184` (`callTool`),
   `packages/ai/src/gateway/gateway.ts:425` (`runReadToolForActor`, now passes `toolName`),
   `packages/ai/src/routes.ts:713` (passes `toolName: selectedTool.name`). Also fixed 17 call sites
   in `tests/unit/mcp-gateway-validation.test.ts` that call `validateToolInput` directly and needed
   a `toolName` fixture value to typecheck (mechanical `"test-tool"` — none of those tests assert
   on message content, only `ToolInputValidationError` class, confirmed by reading the file before
   editing).
2. `9af8e0624` — new test in `tests/integration/external-module-gateway.test.ts`: drives a
   read-risk external tool (`acme.read`, `pattern: "[a-z]+"`) with a pattern-violating input
   through `AssistantToolGateway.runReadToolForActor`, asserts `{ ok: false }`, the handler was
   never called, and `error` contains both `"acme.read"` and `"has an invalid format"`. Confirmed
   RED against pre-fix code (`Field value has an invalid format`, no tool name) before implementing
   the fix — real TDD, not retrofitted.
3. `8348172c1` — the plan-build plan doc itself, committed.

**Verified green this session** (isolated gate DB `jarvis_gate_1279a`, `JARVIS_PGDATABASE`
exported not inlined):
- `pnpm --filter @moss/ai typecheck` → exit 0.
- `pnpm vitest run tests/integration/external-module-gateway.test.ts tests/unit/mcp-gateway-validation.test.ts`
  → **29 passed, 0 failed**, exit 0.

**Not yet run this session:** `pnpm --filter @moss/module-registry typecheck` (plan's second
verification command) — do this first, it's cheap. Full `verify:foundation` gate not run at all
(that's wrap-up's job, on a *fresh* DROP+CREATE gate DB, not the reused `jarvis_gate_1279a` — drop
that one first, it's stale/scoped to this relay's ad-hoc runs).

## Next steps for successor

1. `[ -d node_modules ] || pnpm install` (should already exist — skip).
2. Drop the ad-hoc gate DB from this session: `docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1279a;"`.
3. Quick sanity only if you want extra confidence: `pnpm --filter @moss/module-registry typecheck`
   (expect exit 0 — this package wasn't touched, should be a no-op check).
4. Invoke `coordinated-wrap-up`: fresh isolated gate DB (`verify-gate` skill recipe — DROP+CREATE,
   never reuse), pre-push trio (`format:check && lint && typecheck`) + `git fetch origin main &&
   git rebase origin/main`, push, open PR against `main` referencing `#1279`. PR body must state
   this is internal-only with no live-path/UAT proof needed (module-registry validator, no UI
   surface) — per the original grounding handoff, doc drift note: issue #1279 cites
   `server.ts:415` which doesn't exist in this tree; the real merge point is
   `createExternalToolManifests()` in `packages/module-registry/src/external/tool-manifests.ts`.
5. Message the coordinator (re-resolve pane fresh, label `Coordinator`) with the PR link + verified
   evidence (typecheck + test counts above, gate result once run). Do NOT merge, close the issue,
   or touch the board — that's the coordinator's.
6. Message the coordinator "relayed to <this pane>, safe to reap the prior gateway-validator pane"
   — but only after confirming this successor is actually driving.

## Run-specific bans (still in force)

Work only in this worktree/branch. `git add` by explicit path only (never `-A`). Never touch
`docs/coordination/`, the board, milestones, or merge. No secrets anywhere.
