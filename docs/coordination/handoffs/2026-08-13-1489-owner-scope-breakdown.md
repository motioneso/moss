# Build Handoff — 1489-owner-scope-breakdown

**GitHub issue:** #1489 — no separate spec doc; this is a scoped security fix, build directly off
the issue text. Read `gh issue view 1489` first.
**Risk tier:** `security` — RLS/owner-scope gap. This PR gets adversarial Opus QA + **Ben's
explicit merge sign-off** (no delegated sign-off assumed tonight — ask the coordinator if unsure
why). Build to that bar: reproduce the missing-filter case as a red test before fixing it.
**Scope (from Phase-0 analysis):** `packages/tasks/src/breakdown.ts` — parent-task lookup is
missing an owner filter; mirror the guard already present in `repository.ts`'s `create()`. Expect
~10 lines + a test. Verify the actual current code before trusting this pointer — Phase-0 read it
once, you're reading it live.
**Worktree:** `.claude/worktrees/1489-owner-scope-breakdown` **Branch:** `1489-owner-scope-breakdown` (off `origin/main`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`, exactly one pane with
this label, never a cached pane number.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1489` for the full scope — this is your spec.
3. **Plan-authorship rule (standing, non-negotiable tonight):** you do NOT approve your own plan.
   Write a short plan per the `plan-build` skill (decisions, not code bodies), then message the
   `Coordinator` label with the plan pointer and STOP — do not start building. The coordinator
   routes every lane's plan to Fable (design/plan authority) for review. Wait for an explicit
   "approved" relayed back before writing any code. This applies even though the fix is small —
   it's a standing rule, not a judgment call you make per-lane.
4. Once approved: TDD build, commit per logical step, follow `coordinated-build`/`coordinated-wrap-up`
   for the PR + report back to the coordinator.

## Exit criteria

- Red test reproducing the owner-scope gap, then green after the fix.
- Full gate green on an isolated gate DB (use the `verify-gate` skill — never run
  `pnpm verify:foundation` unscoped).
- PR open, rebased on `origin/main`, tagged `[SECURITY]` in its description.
- This is backend-only (no UI surface) — live-path proof is not required, but note that
  explicitly in the PR so QA doesn't chase a UAT screenshot that doesn't apply.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None — Phase-0 confirmed zero file/contract overlap with #1556, #1248, or the other 6 lanes
  spawning tonight.
