# Build Handoff — 943-role-reset-storage-rpc

**GitHub issue:** #943 — no separate spec doc; scoped security fix, build directly off the issue
text. Read `gh issue view 943` first.
**Risk tier:** `security` — role-scope hazard (not an active exploit; the path is currently
unwired, so no runtime blast radius today, but it's a footgun for whoever wires it next). Still
gets adversarial Opus QA + **Ben's explicit merge sign-off** — no delegated sign-off assumed
tonight.
**Scope (from Phase-0 analysis):** `packages/db/src/module-storage-rpc.ts:89` — `SET LOCAL ROLE`
is set but never `RESET ROLE`'d. Add the reset (or a terminal-RPC guard), plus a test proving the
role actually binds inside the transaction and is reset after. Verify current code before trusting
this pointer.
**Worktree:** `.claude/worktrees/943-role-reset-storage-rpc` **Branch:** `943-role-reset-storage-rpc` (off `origin/main`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 943` for full scope — this is your spec.
3. **Plan-authorship rule (standing, non-negotiable tonight):** you do NOT approve your own plan.
   Write a short plan per the `plan-build` skill, message the `Coordinator` label with the plan
   pointer, and STOP. The coordinator routes it to Fable (design/plan authority) for review. Wait
   for explicit "approved" before writing code.
4. Once approved: TDD build, commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving role binds in-txn and resets after (or terminal-RPC guard, whichever the plan
  settles on).
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Backend-only, no UI surface — note in the PR that live-path proof doesn't apply.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None — Phase-0 confirmed zero overlap with #1556, #1248, or the other 6 lanes tonight.
