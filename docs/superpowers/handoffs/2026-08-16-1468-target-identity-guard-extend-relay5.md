# Relay handoff #5 — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` — all 3 tasks built.
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules` present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator`, agent name `coordinator-take25`, session id
`11cf8264-55a8-4fa4-b32b-c8d086469f74` — **resolve pane fresh via `herdr pane list` by label +
session id, never a baked `…-N`**.
**Risk tier:** security.

## What's done this relay

1. **Pre-push trio green.** `format:check` initially failed on 3 files (stale formatting from
   before the relay boundary) — fixed with `prettier --write`, all changes cosmetic-only
   (confirmed via diff before commit), committed as `c8196d999`. `lint` and `typecheck` both green
   on first try.
2. **Rebase:** `git fetch origin main && git rebase origin/main` → already up to date, no-op.
3. **Escalated Task 2 deployment-env gap to the coordinator** (label `Coordinator`, confirmed
   exactly one pane by that label + session id via fresh `herdr pane list` first, per protocol) via
   `herdr agent prompt`. **Ben's answer came back** (relayed into this session): add
   `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` to `infra/docker-compose.prod.yml` **as part of this PR**
   — his words: "a PR must never break prod." Value = his email `bendlove@gmail.com` (no more
   appropriate existing "confirmed owner" convention found in that file — grepped for
   `OWNER_EMAIL`/`ADMIN_EMAIL`/bootstrap-owner patterns, none exist).
   - **This supersedes the earlier "don't touch `infra/docker-compose.prod.yml`" restriction** from
     relay1-4 handoffs — that restriction predates Ben's explicit go-ahead. Don't re-block on it.
   - Implemented in the `module-install` service's `environment:` block, using the
     `${VAR:-default}` pattern already used elsewhere in this file for non-secret overridable
     settings. **Caught a real trap before committing:** my first-draft comment said "override via
     `JARVIS_ENV_FILE`" — wrong. Per existing memory `deploy-compose-env-trap`, a service's
     `env_file:` does NOT feed Compose `${...}` interpolation; only shell env / `--env-file` does.
     Corrected the comment to match the existing `POSTGRES_PASSWORD` pattern in the same file
     (compose-time interpolation, override by exporting the var or `--env-file`, not by editing
     `env.production.local`). Verified with
     `docker compose -f docker-compose.prod.yml --profile ops config` — resolves to
     `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL: bendlove@gmail.com` correctly.
   - Committed as `7c350344a`. `format:check` re-verified green after this edit (YAML wasn't
     touched by lint/typecheck).
4. **Started `coordinated-wrap-up`.** Confirmed clean tree, no other session gating concurrently
   (`herdr pane list` — all other panes idle/done). Kicked off the gate:
   ```
   scripts/run-gate.sh start
   → db=jarvis_gate_1468_target_identity_guard_extend
   → LOG=/tmp/jarv1s-gate/1468_target_identity_guard_extend-20260816-140210.log
   ```
   Last checked: `RUNNING`, alive, at the `format:check` stage (early). **Not yet complete — resume
   by polling, don't restart it.**

## What's NOT done — resume here

1. **Poll the gate to completion, do not restart it:**
   ```bash
   scripts/run-gate.sh wait      # blocks up to 540s, call again if it returns 3 (still running)
   scripts/run-gate.sh status    # 0=green, 1=gate failed, 2=died, 3=still running
   ```
   Give Bash a 600000ms timeout on `wait`. If green, move on. If red, debug
   (`superpowers:systematic-debugging`) — full suite, not just this lane's files, since a
   shared-table change can break other suites. Drop the gate DB when fully done (script may do this
   automatically on completion — check script output/header).

2. **Pre-push fast checks once more right before push** (per `coordinated-wrap-up` step 3 — cheap,
   catches drift from the compose commit):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```

3. **Push + open PR:**
   ```bash
   git push -u origin 1468-target-identity-guard-extend
   gh pr create --base main --head 1468-target-identity-guard-extend \
     --title "feat(#1468): extend target-identity guard to restore-database and module-reconcile" \
     --body "…"
   ```
   PR body must cover:
   - Scope: 3 tasks — rewrap-secrets (`858d694cb`), restore-database (`b303b2786`),
     module-reconcile (`9a83990b6`), plus this relay's prod-compose companion change (`7c350344a`)
     that sets `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` so Task 2 doesn't break prod on next
     redeploy.
   - Spec link: `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`
   - Gate evidence: exit codes from step 1 above (gate DB name + rc).
   - Release-note line: "rewrap-secrets, restore-database, and module-reconcile all now verify
     target identity before mutating/reading a target database; prod's module-install now confirms
     against Ben's email so the guard doesn't break the next redeploy."
   - **No live-path/UAT proof needed** — internal-only ops-tooling, say so explicitly.
   - Nothing deferred — Ben's env-var request was folded into this PR per his explicit instruction.

4. **Report to the coordinator via `herdr-pane-message`, then STOP.** Re-resolve the Coordinator
   pane fresh (label `Coordinator` + session id `11cf8264-55a8-4fa4-b32b-c8d086469f74`) — do not
   reuse a stale pane id. Include: PR link, gate exit codes + gate DB name, confirmation that Ben's
   env-var request is folded into this PR (not deferred), rebase SHA. **Merge, board update, issue
   close are the coordinator's job — do not do them.**

## Traps already avoided — don't re-trip these

- Root tests (`tests/integration/*`) run via root `pnpm vitest run <path>`, **never**
  `pnpm --filter <pkg> test`.
- Never pipe a verification/gate command losing exit code — use `scripts/run-gate.sh`, or the
  `( cmd > log 2>&1; echo "### FINAL rc=$?" >> log ) &` form for anything else.
- Shared checkout: before any commit here, `git diff <path>` and confirm every added line is
  yours, commit by explicit path (never `git add -A`/bare `git commit`), then
  `git show --name-only HEAD` to confirm the file list. Bitten once this relay by a concurrent
  edit race on the plan doc during `prettier --write` — re-ran format:check until stable before
  committing.
- Compose `${...}` interpolation ≠ `env_file:` contents — see `deploy-compose-env-trap` memory
  before touching any other var in `infra/docker-compose.prod.yml`.
- Gate-DB isolation: any live-DB test/gate run needs its own scratch DB (`run-gate.sh` handles
  this). Check `herdr pane list` before starting one (stagger with other sessions).
- Relay on the context-meter 70% warning or immediately on a compaction summary — don't invent a
  higher personal threshold. (This handoff was triggered by that exact warning, right after
  `scripts/run-gate.sh start` returned — the gate keeps running in the background across the
  relay, it's a detached process independent of this session.)
