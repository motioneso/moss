# Relay handoff #6 — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` — all 3 tasks built.
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules`
present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator`, session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` — **resolve
pane fresh via `herdr pane list` by label + session id, never a baked `…-N`**.
**Risk tier:** security.

## What's done this relay

Relay5's gate run (`db=jarvis_gate_1468_target_identity_guard_extend`) came back **red**, twice, on
real defects introduced by this branch's own commits (not pre-existing/flaky — both confirmed via
`git diff main..HEAD -- <file>`). Both are fixed and committed:

1. **`check:file-size` failure.** `tests/integration/release-hardening.test.ts` was already at the
   1000-line cap on `main` (exactly 1000); Task 2's restore-database tests pushed it to 1059.
   Fixed by extracting those 3 tests into a new sibling file
   `tests/integration/restore-database-target-guard.test.ts`, following the same split-file
   convention Task 3 already established (`module-reconcile-target-guard.test.ts`). Committed
   `1402d57be`.
2. **Real test failure**, not file-size related: `tests/unit/rewrap-secrets-guard.test.ts`
   (Task 1) opened a real Postgres connection and hit `relation "app.users" does not exist`.
   Root cause: `verify:foundation` runs `test:unit` **before** `db:migrate` — a real-DB test
   under `tests/unit/` is guaranteed to fail there since the schema doesn't exist yet. Confirmed
   by checking every other `tests/unit/*` file that references `getMossDatabaseUrls` — none of
   them open a real connection, only this one did. Relocated to
   `tests/integration/rewrap-secrets-target-guard.test.ts`, adopting the same
   `connectionStrings`/`resetEmptyFoundationDatabase` isolation helpers the other two target-guard
   integration tests use (instead of a raw `getMossDatabaseUrls().migration` connection).
   Committed `0e986072b`.

Both fixes verified locally green before commit: `pnpm format:check && pnpm lint && pnpm typecheck
&& pnpm check:file-size` (all exit 0). Both commits made per `shared-checkout` skill protocol —
diffed before staging, committed by explicit path (new files needed `git add <path>` first, since
`git commit <path>` errors — doesn't stage — on an untracked path), confirmed file list after with
`git show --name-only HEAD`.

**Not yet re-verified:** whether the full gate (including `test:integration`, `test:uat-seed`) is
green after these two fixes — the gate was NOT restarted after the second fix (relay boundary hit
right after committing `0e986072b`).

## What's NOT done — resume here

1. **Start a fresh gate run** (source changed since the last run, must restart, not poll a stale
   one):
   ```bash
   scripts/run-gate.sh start
   ```
   Check `herdr pane list` first per `shared-checkout`/`gate-db-isolation` — confirmed clean at the
   time this handoff was written (only this worktree's own pane "working" against this tree).
2. **Poll to completion:**
   ```bash
   scripts/run-gate.sh wait      # blocks up to 540s, call again if it returns 3 (still running)
   scripts/run-gate.sh status    # 0=green, 1=gate failed, 2=died, 3=still running
   ```
   Give Bash a 600000ms timeout on `wait`. If green, move on. If red, debug
   (`superpowers:systematic-debugging`) — full suite, not just this lane's files. Don't assume the
   next failure is unrelated to this branch — both failures so far were real, caused by this
   branch's own diff; check `git diff main..HEAD -- <failing file>` before calling anything
   pre-existing/flaky.
3. **Pre-push fast checks once more right before push:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
4. **Push + open PR:**
   ```bash
   git push -u origin 1468-target-identity-guard-extend
   gh pr create --base main --head 1468-target-identity-guard-extend \
     --title "feat(#1468): extend target-identity guard to restore-database and module-reconcile" \
     --body "…"
   ```
   PR body must cover:
   - Scope: 3 tasks — rewrap-secrets (`858d694cb`), restore-database (`b303b2786`),
     module-reconcile (`9a83990b6`), plus the prod-compose companion change (`7c350344a`) that
     sets `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` so Task 2 doesn't break prod on next redeploy,
     plus this relay's two gate-driven test-location fixes (`1402d57be`, `0e986072b`).
   - Spec link: `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`
   - Gate evidence: exit codes from step 2 above (gate DB name + rc).
   - Release-note line: "rewrap-secrets, restore-database, and module-reconcile all now verify
     target identity before mutating/reading a target database; prod's module-install now confirms
     against Ben's email so the guard doesn't break the next redeploy."
   - **No live-path/UAT proof needed** — internal-only ops-tooling, say so explicitly.
   - Nothing deferred — Ben's env-var request was folded into this PR per his explicit instruction.
5. **Report to the coordinator via `herdr-pane-message`, then STOP.** Re-resolve the Coordinator
   pane fresh (label `Coordinator` + session id `11cf8264-55a8-4fa4-b32b-c8d086469f74`) — do not
   reuse a stale pane id. Include: PR link, gate exit codes + gate DB name, confirmation that Ben's
   env-var request is folded into this PR (not deferred), rebase SHA, and a one-line note that two
   gate-driven fixes were needed this relay (file-size split + test relocation) — both are real
   defects the gate caught, not gate flakiness. **Merge, board update, issue close are the
   coordinator's job — do not do them.**

## Traps already avoided — don't re-trip these

- Root tests (`tests/integration/*`) run via root `pnpm vitest run <path>`, **never**
  `pnpm --filter <pkg> test`.
- Never pipe a verification/gate command losing exit code — use `scripts/run-gate.sh`, or the
  `( cmd > log 2>&1; echo "### FINAL rc=$?" >> log ) &` form for anything else.
- `verify:foundation` order is `... test:unit ... db:migrate ... test:uat-seed test:integration`
  — **any test that touches a real Postgres connection must live under `tests/integration/`, never
  `tests/unit/`**, or it fails deterministically (schema doesn't exist yet). Grep any new
  `tests/unit/*.test.ts` for `createDatabase`/`new Client(`/`getMossDatabaseUrls().migration` with
  a real connection (not just pure URL-shape assertions) before trusting it belongs there.
- Shared checkout: `git commit <path>` silently aborts the **whole** commit if any path is
  untracked — `git add <new-path>` first, then commit by explicit path. Before committing, `git
  diff`/`git status` the paths and confirm every line is yours; after, `git show --name-only HEAD`
  to confirm the file list.
- Compose `${...}` interpolation ≠ `env_file:` contents — see `deploy-compose-env-trap` memory
  before touching any other var in `infra/docker-compose.prod.yml`.
- Gate-DB isolation: any live-DB test/gate run needs its own scratch DB (`run-gate.sh` handles
  this). Check `herdr pane list` before starting one (stagger with other sessions).
- Relay on the context-meter 70% warning — don't invent a higher personal threshold. (This handoff
  was triggered by that exact warning, right after committing `0e986072b`.)
