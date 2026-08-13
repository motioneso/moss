# Relay — #943 role-reset-storage-rpc

**Issue:** #943 (spec = issue body, no separate spec doc). **Risk tier:** security.
**Branch/worktree:** `943-role-reset-storage-rpc`, same path (this worktree).
**Coordinator:** label `Coordinator`, agent name `coord-successor`, session id
`caef4e32-df22-4310-a42d-866771a0ba6c` — re-resolve fresh via `herdr pane list`, don't trust this
id blind if it's been a while.

## Done

- Verified spec premise against branch (coordinated-build step ½): `packages/db/src/module-storage-rpc.ts:89`
  still has `SET LOCAL ROLE` with no matching `RESET ROLE` anywhere in the 124-line file. Still real.
- Plan written and **committed**: `docs/superpowers/plans/2026-08-13-943-role-reset-storage-rpc.md`.
  Read it in full — it's short (2 tasks, one file + one test). Covers: seams check with file:line
  citations, Task 1 (add `RESET ROLE` in the existing `finally` block, same try/catch pattern as the
  existing `statement_timeout` reset), Task 2 (new regression test in the pre-existing
  `tests/integration/module-storage-rpc.test.ts`, reusing its fixture — no new setup needed), kill
  gate, exit criteria.
- Escalation **sent** to `coord-successor` via `herdr agent prompt`: plan pointer + explicit note
  that I'm relaying now per coordinated-build step 3 (context-meter 70% warning), zero code written
  yet, successor will resume at "await plan approval."

## Not done — successor picks up here

1. **Wait for explicit "approved"** from the coordinator (routed through Fable) before writing any
   code — this is the handoff's non-negotiable standing rule. Do not self-approve.
2. Once approved: TDD build per the plan —
   - Task 2 first (new `it()` in `tests/integration/module-storage-rpc.test.ts`), confirm it fails
     against the current (unfixed) file.
   - Task 1 (`RESET ROLE` in `module-storage-rpc.ts`'s `finally` block), confirm Task 2 now passes.
   - Commit each task separately with `Co-Authored-By: Claude` trailer, `git add` by explicit path.
3. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main` (branch was 1 commit behind `origin/main` @ `513672aa5` as of last check —
   re-check, it's been a while).
4. `verify-gate` skill for the isolated-DB integration test run (`pnpm test:integration
   tests/integration/module-storage-rpc.test.ts`), then full gate at wrap-up.
5. `coordinated-wrap-up`: push, open PR tagged `[SECURITY]`, note in the PR that live-path UI proof
   doesn't apply (backend-only), report to coordinator. Adversarial Opus QA + Ben's explicit merge
   sign-off required — no delegated sign-off tonight.

## Why relay landed before any commits of substance

Heavy up-front reading was required to write an accurate, cited plan for a security-tier fix:
`module-storage-rpc.ts`, `module-role-broker.ts`, `data-context.ts`, `urls.ts`, the pre-existing
275-line integration test file, and `package.json` scripts. That's expected per plan-build's seams
check, not over-reading — but it used most of the budget before code started. Successor has a full
fresh budget: build and commit per task, don't re-read what's already cited in the plan.

Relay trigger was the meter's 70% warning — same threshold as everyone, not a personal one.
