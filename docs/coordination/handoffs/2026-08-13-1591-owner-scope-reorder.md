# Build Handoff — 1591-owner-scope-reorder

**GitHub issue:** #1591 — no separate spec doc; scoped security fix, build off the issue text.
Read `gh issue view 1591` first.
**Risk tier:** `security` — info disclosure (timing/existence oracle). Gets adversarial Opus QA +
**Ben's explicit merge sign-off** — no delegated sign-off assumed tonight.
**Scope (from Phase-0 analysis):** `packages/ai/src/gateway/gateway.ts:445` — reorder so the
owner-scoped UPDATE runs before the unscoped `isAwaiting` liveness check, so a cross-user confirm
attempt can't distinguish "a live waiter exists" from "no waiter" by response shape/timing.
Verify current code first — Phase-0 read it once, you're reading it live.
**Worktree:** `.claude/worktrees/1591-owner-scope-reorder` **Branch:** `1591-owner-scope-reorder` (off `origin/main`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1591` for full scope.
3. **Plan-authorship rule (standing, non-negotiable tonight):** you do NOT approve your own plan.
   Write a short plan per `plan-build`, message the `Coordinator` label with the pointer, and
   STOP. The coordinator routes it to Fable for review; wait for explicit "approved" before code.
4. Once approved: TDD build, commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving a cross-user confirm attempt against a live waiter and against no-waiter now
  returns indistinguishable responses (same status/shape/timing class).
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Note #1592 (queued, serialize-after this lane) shares the confirm-route integration test files
  (`tests/integration/chat-mcp-transport.test.ts`, `mcp-gateway*.test.ts`) — land and merge this
  one first so #1592's build agent isn't racing you on the same test file.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- #1592 is queued behind this lane (same route pair, shared integration test files) — coordinator
  will not spawn it until this PR lands on `main`.
