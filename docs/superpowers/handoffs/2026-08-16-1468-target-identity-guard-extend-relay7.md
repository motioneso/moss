# Relay handoff #7 — #1468 target-identity-guard-extend

**PR:** #1647 (already open, pushed at head `9da89a992`). This relay is fixing QA RED, not
opening a new PR — push to the same branch.
**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules`
present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator`, session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` — resolve
pane fresh via `herdr pane list` by label + session id, never a baked `…-N`.
**Risk tier:** security.

## Why this relay exists

Security-tier QA came back RED on PR #1647 (full verdict:
`gh api repos/motioneso/moss/issues/comments/5309995233 --jq .body` — the PR's only issue comment;
the URL fragment `#issuecomment-5309916419` in the original report does not resolve, use the
comment id above instead). Three blocking findings (B1/B2/B3), five non-blocking (N1-N5).

## What's done this relay — committed, NOT yet gate-verified or pushed

1. **B1 (critical, fixed).** `infra/docker-compose.prod.yml`: the `jarv1s` app service
   (`container_name: moss`, runs `scripts/start-jarv1s.ts` → mandatory boot one-shot
   `module-reconcile.ts`) had no `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL`, only the ops-profile
   `module-install` service did — next prod deploy against a target with a bootstrap owner would
   crash-loop. Fixed: added the var to the `jarv1s` service's `environment:` block, same
   `${VAR:-}` empty-default pattern as `JARVIS_UAT_SEED_CONFIRM` (real enforcement happens at
   runtime in `assertReconcileTargetIdentity`, not at compose-parse time — a `:?` required
   default would break first-run/fresh-install boots). Removed the hardcoded
   `:-bendlove@gmail.com` fallback on the ops-profile line too (public repo). Documented the new
   var in `infra/env.production.example`. Commit `1bee2bdc5`.
2. **N1 (folded in, cheap).** Renamed `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` →
   `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` everywhere EXCEPT the `resolveMossEnv(env, "JARVIS_...")`
   call site in `scripts/module-reconcile.ts` (confirmed convention: callers always pass the
   `JARVIS_`-prefixed canonical name — see `packages/db/src/env.ts` and every other
   `resolveMossEnv` call site — the function checks `MOSS_*` first, `JARVIS_*` is the free
   deprecated alias). Renamed in: `infra/docker-compose.prod.yml`, `infra/env.production.example`,
   `docs/module-developer-guide.md`, `docs/DEVELOPMENT_STANDARDS.md`,
   `tests/integration/module-reconcile-target-guard.test.ts`,
   `tests/integration/module-distribution.e2e.test.ts`. Did NOT touch historical
   `docs/superpowers/handoffs/*relay{,2,3,4,5,6}.md` or the plan doc — dead history, not living
   docs. Part of commit `1bee2bdc5`.
3. **N4 (resolved as a byproduct of B1).** The hardcoded `bendlove@gmail.com` compose default QA
   flagged is gone — see B1 above.
4. **B3 (fixed).** One-line notes added at the exact lines QA cited (line numbers matched HEAD
   exactly): `docs/module-developer-guide.md:408`, `docs/DEVELOPMENT_STANDARDS.md:65`,
   `docs/operations/release-hardening.md` (after the restore command block),
   `docs/operations/secret-key-rotation.md` (both `rewrap-secrets.ts` invocations, lines 64/109).
   `scripts/restore-database.ts`'s own dry-run console.log now documents `--allow-empty-target`
   (previously undocumented anywhere). Commit `00979d25c`.

**Not folded in — explicit decision, note as follow-up in the PR body, do NOT silently drop:**
- **N2** (`restore-database.ts` `--allow-empty-target` also swallows the "populated but no flagged
  owner" case, looser than the doc comment claims) — behavior change, needs its own judgment call,
  out of scope for a QA-RED fix cycle.
- **N3** (`restore-database.ts` proves identity against the connection-string host while
  `pg_restore` always targets the fixed local `jarv1s-postgres` container — pre-existing shape,
  not introduced by this PR).
- **N5** (nits: `readFlag`/`readOptionalFlag` duplication, `assertRewrapTargetIdentity` passthrough,
  redundant `endsWith` check in `isThisModuleEntry`).
- The adversarial "what's NOT tested" list (7 items in the QA comment) — mostly new-test asks
  (boot-path source-assertion test, guard-ordering proof, fresh-empty-table coverage). Real gaps,
  but out of scope for this relay; note in the PR body as acknowledged, not silently ignored.

## What's NOT done — resume here, in order

1. **B2 (blocking, real fix needed — QA's paraphrase that it "self-resolves once B1 lands" was
   wrong, read the full verdict)**: `tests/uat/specs/module-install.uat.spec.ts` fails because the
   **UAT harness itself never sets `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL`** for its compose
   invocation, independent of B1. `tests/uat/seed/admin.ts` seeds `UAT_ADMIN_EMAIL =
   "uat-admin@jarv1s.local"` with `isBootstrapOwner: true` — the spec's restart-boot step then
   hits the exact refusal B1 fixed for prod, but the UAT provisioner never supplies the
   confirmation. I was mid-investigation of `tests/uat/provisioner.ts` when this relay triggered —
   found so far:
   - `UAT_COMPOSE_FILE = "infra/docker-compose.prod.yml"` (`tests/uat/provisioner.ts:445`) — UAT
     runs the SAME prod compose file I just edited, via `--env-file` (needs confirming exactly
     where/how — grep `writeUatEnvFile` and the `--env-file` invocation around
     `tests/uat/provisioner.ts:170-266`).
   - The `JARVIS_UAT_SEED_CONFIRM` and `JARVIS_UAT_REAL_CHAT_ENV_FILE` vars are precedent for
     "provisioner writes a var into the UAT env file that compose then interpolates" — follow the
     same mechanism for `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL=uat-admin@jarv1s.local`.
   - Read `tests/uat/provisioner.ts` in full around the env-file-writing function(s) (search
     `writeUatEnvFile`) before editing — do not guess the write site.
   - After the fix, this spec needs a REAL run to confirm (not just a read-through) — check
     `uat-spec-gotchas`/`uat-reload-poll-and-psql-seed-traps`/`uat-moss-container-name-collision`
     memories first; `docker ps -a | grep -x moss` before running (prod container name collision
     trap).
2. **Full gate re-run** after the B2 fix (and after re-checking B1/B3/N1 still typecheck/lint/
   format clean — they were NOT locally verified this relay before the context checkpoint hit,
   only committed):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck   # quick sanity on the 9 changed files first
   scripts/run-gate.sh start
   scripts/run-gate.sh wait      # blocks up to 540s, call again on exit 3; 600000ms Bash timeout
   scripts/run-gate.sh status    # 0=green, 1=failed, 2=died, 3=running
   ```
   If red, debug — check `git diff main..HEAD -- <failing file>` before assuming pre-existing/flaky
   (every failure this branch has hit so far has been real, caused by this branch's own diff).
3. **Pre-push trio + rebase once more right before push:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
4. **Push (same branch, no new PR):**
   ```bash
   git push origin 1468-target-identity-guard-extend
   ```
5. **Re-request QA.** Either spawn a fresh scoped `coordinated-qa` agent against PR #1647, or ping
   Ben — his own words: "or ping me and I will." Post a PR comment summarizing what changed
   (B1/B2/B3 fixed, N1/N4 folded in, N2/N3/N5 + the adversarial test-gap list acknowledged as
   follow-up, not forgotten) before requesting re-review.
6. **Report to the Coordinator, then STOP.** Re-resolve the pane fresh (label `Coordinator` +
   session id `11cf8264-55a8-4fa4-b32b-c8d086469f74`). Merge/board/issue-close are the
   coordinator's job, not this relay's.

## Traps already avoided — don't re-trip these

- `resolveMossEnv` callers always pass the `JARVIS_`-prefixed name as the canonical parameter —
  do NOT change the `scripts/module-reconcile.ts:128` call site to `MOSS_...`, it's already
  correct as-is (the function does the MOSS-first lookup internally).
- A `:?` required compose default on `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` would break first-run —
  Compose interpolates `${...}` for every service before profile filtering, and the guard itself
  exempts a genuinely fresh install at the application layer. Keep the empty-default pattern.
- Root tests (`tests/integration/*`) run via root `pnpm vitest run <path>`, never
  `pnpm --filter <pkg> test`. `test:unit` runs BEFORE `db:migrate` in `verify:foundation` — any
  real-DB test must live under `tests/integration/`, never `tests/unit/`.
- Shared checkout: `git commit <path>` aborts the WHOLE commit on any untracked path — `git add`
  new files first. Diff-check before staging, `git show --name-only HEAD` after.
- Gate-DB isolation: check `herdr pane list` before `run-gate.sh start`, stagger with other
  sessions. UAT runs: check `docker ps -a | grep -x moss` first (prod container-name collision,
  issue #1618).
- Relay on the context-meter warning (this handoff was triggered by exactly that, at 73%) — don't
  invent a higher personal threshold, and don't let "almost done" talk you past it.
