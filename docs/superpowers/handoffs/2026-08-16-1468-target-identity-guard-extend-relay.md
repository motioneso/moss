# Relay handoff — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` (committed `8e9f4e71b`)
**Handoff doc:** `docs/coordination/handoff-1468-target-identity-guard-extend.md`
**Worktree/branch:** `~/Jarv1s/.claude/worktrees/1468-target-identity-guard-extend`, branch `1468-target-identity-guard-extend` (off `origin/main @ bcb3c2765`)
**Coordinator:** label `Coordinator`, session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` (resolve pane fresh via `herdr pane list` — never a baked `…-N` number)
**Risk tier:** security (adversarial Opus QA + Ben merge sign-off before merge)

## What's done

- `pnpm install` complete (`node_modules` present — do NOT re-run).
- Spec verified against branch (step ½ of `coordinated-build`) — all three target scripts confirmed in the state the spec describes (no guard wiring yet).
- Full seams check done with `file:line` citations — in the plan.
- Plan written per `plan-build` and committed: `8e9f4e71b`.
- Plan-approval + relay notice sent to the Coordinator pane via `herdr agent prompt` (queued — coordinator was `working` at send time). **Not yet confirmed approved as of this handoff.**

## What's NOT done — resume here

1. **Check for the coordinator's reply first.** Look for a response in this session's inbox / re-check with the coordinator (`herdr-pane-message` skill — resolve pane fresh by label `Coordinator` + session id above). The message asked for:
   - Approval of the plan as a whole, OR a redirect.
   - Specific sign-off on the **module-reconcile.ts design fork** (see plan's "Open question" section): env-var confirmation (`JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL`) + a "fresh-install exception" (proceed without confirmation when no bootstrap owner exists yet, since that's normal on first boot) instead of a CLI flag — because module-reconcile.ts runs unattended at every container boot (`infra/docker-compose.prod.yml:58-71`, zero args) and has no dry-run/execute split, unlike the other two scripts.
   - **Do not write any code until this approval lands.** No code has been written yet — the plan is the only artifact.

2. **Once approved (or once told to proceed with Task 1/3 while Task 2's fork is still pending — the plan's kill gate allows this since Task 1/3 share no code with Task 2):**
   - **Task 1 first** — `scripts/rewrap-secrets.ts`. Full task spec (exact call site, flag shape, new exported `assertRewrapTargetIdentity` seam, test file `tests/unit/rewrap-secrets-guard.test.ts`, test case, verification command) is written out in full in the plan under "## Task 1" — follow it exactly via TDD (`superpowers:test-driven-development`). Commit green with `Co-Authored-By: Claude` trailer, `git add` by explicit path only.
   - **Task 3 next** — `scripts/restore-database.ts`. Full spec under "## Task 2" — wait, actually **"## Task 3"** in the plan (module-reconcile is Task 2). New `assertRestoreTargetIdentity` function, new `--confirm-owner-email`/`--allow-empty-target` flags, tests extend `tests/integration/release-hardening.test.ts`. TDD, commit.
   - **Task 2 last** (only after the fork is resolved) — `scripts/module-reconcile.ts`. Full spec under "## Task 2" in the plan: new exported `assertReconcileTargetIdentity(client)`, called right after `client.connect()`, new test file `tests/integration/module-reconcile-target-guard.test.ts`. TDD, commit. **If the coordinator rejects the recommended design, get the redirect in writing before building — do not improvise a different design.**

3. **After all three tasks are green:**
   - Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (unpiped, check exit codes) then `git fetch origin main && git rebase origin/main`.
   - Invoke `coordinated-wrap-up`: gate DB run via the `verify-gate` skill (never ad hoc — an unscoped `pnpm verify:foundation` hits the live dev DB), push, open PR.
   - This is **internal-only ops-tooling** — no live-path/UAT proof needed; say so explicitly in the PR body per the handoff doc's exit criteria, plus a one-sentence release-note line.
   - Report the PR + evidence to the coordinator. **Stop there** — merge, board update, issue close are the coordinator's, not this lane's.

## Traps already avoided — don't re-trip these

- **The plan file was first accidentally written to the shared main tree (`/home/ben/Jarv1s/docs/...`) instead of this worktree.** It has been moved into this worktree and committed here (`8e9f4e71b`); the stray untracked copy in the main tree was deleted. **Double-check `pwd`/`git rev-parse --show-toplevel` before every `Write` call** — this worktree's root is `/home/ben/Jarv1s/.claude/worktrees/1468-target-identity-guard-extend`, not `/home/ben/Jarv1s`.
- Read the spec/plan **by section**, not in full — full-reads on prior lanes in this run bloated context to ~71% before any code was written and forced content-free relays.
- `module-reconcile.ts` uses a raw `pg.Client`, not Kysely — do NOT add a `@moss/db` Kysely connection to it; the plan's Task 2 design reuses the existing raw client and imports only the `TargetIdentityMismatchError` type/class from `@moss/db`.
- Root-tests-never-run-via-package-filter: `tests/integration/*` and `tests/unit/*` run via root `pnpm vitest run <path>`, never `pnpm --filter <pkg> test`.
- Never pipe a verification command in a way that loses the exit code — always `2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"` or equivalent.
- Do not touch `packages/db/src/target-identity-guard.ts` or the two existing guarded CLIs (`admin-reset-password.ts`, `delete-user-data-cli.ts`) — wiring three new callers only.
- Do not touch `infra/docker-compose.prod.yml` — the plan explicitly documents the env-var requirement as a PR-body follow-up note, not a code change in this lane.

## Relay trigger for you too

Same rule: relay on the context-meter 70% warning or immediately on seeing a compaction summary — don't invent a higher personal threshold. If you relay before finishing, update this doc (or write a new dated one) with fresh state before spawning your own successor.
