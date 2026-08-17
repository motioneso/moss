# Relay handoff #4 — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` — all 3 tasks now built.
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules` present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator` (agent `coordinator-take25`), session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` — **resolve pane fresh via `herdr pane list` by label + session id, never a baked `…-N`**.
**Risk tier:** security.

## What's done — ALL 3 TASKS GREEN, nothing left to build

- Task 1 (`858d694cb`), Task 3 (`b303b2786`) — see relay2/relay3 docs for detail.
- **Task 2 committed green: `9a83990b6`** — `scripts/module-reconcile.ts` now has
  `assertReconcileTargetIdentity(client, env)`, called right after `client.connect()`, before the
  Phase 0 advisory lock. Implements the coordinator's 4 required changes verbatim: "un-provisioned
  target" (renamed from "fresh install") requires BOTH connected-role trust (superuser,
  `rolbypassrls`, or owner of `app.users`) AND `app.users` genuinely empty (`COUNT(*) = 0`).
  New test file `tests/integration/module-reconcile-target-guard.test.ts`, 6 cases, all green
  (verified in scratch gate DB `jarvis_gate_1468t2_build`, dropped after — `rc=0`, 6/6 pass).
  Includes the coordinator's required regression case (populated table, no flagged owner →
  refuse) plus one added case (untrusted role can't forge the exception even against an empty
  table).

## What's NOT done — resume here

1. **Pre-push trio + rebase** (not yet run this relay):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   (`pnpm typecheck` was already run clean after Task 2's edit, before commit — but re-run all
   three fresh since a relay boundary sits between.)

2. **Escalate the Task 2 deployment-env gap to the coordinator — hard requirement, not optional,
   per the coordinator's adjudicated verdict (carried from relay3, still not yet sent):**
   `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` isn't set in any deployment today. Merging Task 2 alone
   breaks module-install on Ben's next prod redeploy (non-zero exit — guard fails closed with no
   confirmation against a populated `app.users`). Message the coordinator (label `Coordinator`,
   confirm exactly one pane by that label + session id first) with this explicitly and **wait for
   it to loop in Ben on the companion compose/env change before opening the PR.**

3. **Invoke `coordinated-wrap-up`**: full gate DB run via `verify-gate` skill (fresh scratch DB,
   drop when done — do not reuse `jarvis_gate_1468t2_build`, already dropped), push, open PR.
   - Internal-only ops-tooling — no live-path/UAT proof needed; say so explicitly in the PR body,
     plus a one-sentence release-note line covering all 3 tasks (rewrap-secrets, restore-database,
     module-reconcile all now verify target identity before mutating/reading a target database).

4. **Report the PR + evidence + the Task 2 env-var deployment gap to the coordinator. Stop there**
   — merge, board update, issue close, Ben loop-in are the coordinator's job, not this lane's.

## Traps already avoided — don't re-trip these

- Root tests (`tests/integration/*`) run via root `pnpm vitest run <path>`, **never**
  `pnpm --filter <pkg> test`.
- Never pipe a verification command losing exit code — `2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"`
  form, or the `(cmd; echo rc=$?) &> log` form used this relay.
- Do not touch `packages/db/src/target-identity-guard.ts`, `admin-reset-password.ts`,
  `delete-user-data-cli.ts`, or `infra/docker-compose.prod.yml`.
- **Gate-DB isolation:** any live-DB test run needs its own scratch DB. Never run against the
  default/live dev DB. Check `herdr pane list` before starting one (stagger with other sessions).
- Shared checkout: before any commit here, `git diff <path>` and confirm every added line is
  yours, commit by explicit path (never `git add -A`/bare `git commit`), then
  `git show --name-only HEAD` to confirm the file list.
- Relay on the context-meter 70% warning or immediately on a compaction summary — don't invent a
  higher personal threshold.
