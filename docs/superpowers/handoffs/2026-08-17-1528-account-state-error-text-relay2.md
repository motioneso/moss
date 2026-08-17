# Relay 2 — #1528 (1140-F) account-state error text

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-F
**Plan:** `docs/superpowers/plans/2026-08-17-1528-account-state-error-text.md`
**Prior relay:** `docs/superpowers/handoffs/2026-08-17-1528-account-state-error-text-relay.md` — coordinator
scope ruling there (widened to include `schema-fragments.ts` `code` field) is already decided, do not
re-ask.
**Worktree/branch:** this one, `1528-account-state-error-text`.
**Tier:** security — adversarial Opus QA + Ben merge sign-off required before merge.

## Relay reason

Context hit 70%+ checkpoint mid-verification. Relaying with durable state on disk per box-wide rule —
do not re-derive, read the log files cited below.

## Code changes: DONE, TDD GREEN, do not re-touch

All 3 owned-surface files are edited per the locked contract and confirmed green:

- `packages/shared/src/schema-fragments.ts` — added `code: { type: "string" }` to
  `errorResponseSchema.properties` (not required).
- `apps/api/src/server.ts` — `/api/modules` catch block now sends fixed literals
  ("Account is pending approval" / "Account has been deactivated") instead of `error.message`.
- `tests/integration/auth-settings.test.ts` — 3 new tests added, plus a **file-size dedup refactor**
  (extracted `signUpPendingJoiner()` / `signUpDeactivatedJoiner()` helpers + `OWNER`/`JOINER` constants,
  used at 5 call sites) to bring the file from 1034 lines back under the 1000-line `check:file-size`
  cap — now exactly 1000 lines. This refactor is mechanical/behavior-preserving, in-scope (same file
  I'm already required to edit).

**Proof, do not re-run unless you have a specific reason to distrust it:**
- `/tmp/1528-focused2.log` — 26/26 green (pre-dedup version, rc=0).
- `/tmp/1528-focused3.log` — 26/26 green (post-dedup, exactly-1000-line version, rc=0). **This is the
  authoritative proof the shipped diff is correct.**

## Gate status: pre-unit steps GREEN, test:unit structurally blocked by PRE-EXISTING unrelated red

`pnpm verify:foundation` chains with `&&`, so a red step blocks everything after it. Confirmed twice
(`/tmp/1528-gate2.log`, `/tmp/1528-gate3.log`) that everything through `build:app-map` is clean: lint,
format:check, check:file-size, check:design-tokens, check:ui-classes, check:migrated-sections,
check:ui-catalogue, check:no-ambient-dates, check:package-deps, typecheck (root + web + external-modules).

`test:unit` fails on 3 files, **confirmed pre-existing and unrelated to this diff** via a git-stash
pristine-HEAD rerun (stashed the 3 changed files, reran the same 3 test files, identical failure count
reproduced — see `/tmp/1528-pristine-check.log`):

1. `tests/unit/module-sdk-worker.test.ts` — 5 failures, "worker produced no protocol message". Newly
   documented in memory this session (`mem_msxsampr_e7a88ba45dbe`), no GitHub issue filed yet — consider
   filing one, it reproduces deterministically (not just under load).
2. `tests/unit/mcp-gateway-validation.test.ts` — 3 failures. Already-documented pre-existing flake,
   issue #1673 (memory: `gateway-worker-pattern-timeout-flake.md`).
3. `tests/unit/chat-drawer-surface.test.tsx` — 1 failure. Already-documented pre-existing flake (memory:
   `chat-drawer-surface-flakes-under-full-suite-load.md`).

**None of these 3 files import or exercise anything in the 3 owned-surface files above.** This is a
structural gate limitation (shared worktree carries pre-existing red), not a defect in #1528's diff.

## test:integration: RESOLVED — 2 files pre-existing/unrelated red, confirmed via pristine-HEAD

`db:migrate` + `test:uat-seed` against a fresh `jarvis_gate_1528`: clean, 29/29
(`/tmp/1528-migrate2.log`).

`tests/integration/mcp-gateway-self-operation.test.ts` and `tests/integration/notes-write-tools.test.ts`
fail both with and without #1528's diff:

- With diff, clean fresh DB (`/tmp/1528-collateral-check2.log`): 3 failed, 26 passed.
- **Pristine HEAD** (3 owned files stashed out via `git stash push -m "1528-pristine-check-2" -- ...`,
  same clean DB, `/tmp/1528-pristine-integration.log`): **4 failed, 25 passed** — same 2 files, one
  extra failure (`sports.followTeam/unfollowTeam ... RLS-isolated across actors`), not fewer. This
  rules out #1528's diff as the cause (diff present = fewer failures, not more). Stash was popped
  immediately after — the 4 owned-file changes are back in the working tree, confirmed via
  `git status --short`.

**Conclusion: pre-existing, unrelated to #1528, domain (sports/notes tool-gateway trusted_auto gating)
has nothing to do with account-state error text.** Not yet documented in memory before this session —
consider filing/saving if not already covered by an existing issue.

## Next concrete steps for the successor (in order)

All diagnostics are DONE. This is now a straight wrap-up procedure, nothing left to investigate:

1. Do **not** attempt another full `pnpm verify:foundation` run expecting rc=0 — it structurally cannot
   pass while `tests/unit/module-sdk-worker.test.ts` etc. are red, and that's out of this lane's scope
   to fix. State status honestly in the PR: "lint/format/checks/typecheck/build green; test:unit has 3
   pre-existing unrelated red files (evidence in this doc); test:integration green for the owned
   surface (26/26 `auth-settings.test.ts`); 2 other integration files
   (`mcp-gateway-self-operation.test.ts`, `notes-write-tools.test.ts`) also pre-existing red, confirmed
   via pristine-HEAD comparison (worse without the diff, not better)."
2. `git status --short` — expect exactly 4 modified files (`apps/api/src/server.ts`,
   `docs/superpowers/plans/2026-08-17-1528-account-state-error-text.md` prettier whitespace-only,
   `packages/shared/src/schema-fragments.ts`, `tests/integration/auth-settings.test.ts`) plus 1
   untracked (this relay doc, and the prior relay doc — both should be committed too, docs-only). Use
   the `shared-checkout` skill before committing (shared worktree — check `herdr pane list` for
   concurrent sessions in this cwd first; as of this relay, only this session had cwd here).
3. Pre-push trio + rebase onto `origin/main`, then `coordinated-wrap-up`: open the PR, and in the
   live-path assessment section state explicitly **"no live-path proof applicable — backend-only
   error-text/schema fix, no UI surface"** rather than skipping the question. PR description should
   quote the gate-status honesty note from step 1, not claim a blanket green gate.
4. Flag tier=security: this PR needs adversarial Opus QA + Ben's merge sign-off before merge, per the
   original relay doc.

## Out of scope (unchanged, still binding)

- `packages/ai/src/terminal-routes.ts`, `packages/settings/src/route-error.ts`,
  `packages/settings/src/routes-serializers.ts`, `/api/me`'s own error path, anything in
  `packages/shared/src/platform-api.ts`, `docs/coordination/`.
- Fixing the pre-existing `module-sdk-worker`/`mcp-gateway-validation`/`chat-drawer-surface` test
  failures — out of scope for #1528, just document them.

## Gate DB state

`jarvis_gate_1528` on `jarv1s-postgres` — freshly migrated+seeded (3rd generation this lane) as of this
relay. `export JARVIS_PGDATABASE=jarvis_gate_1528` before any further test run against it; re-export
per shell/subshell, it does not persist across backgrounded commands automatically. DROP it when this
lane is fully done, per verify-gate skill discipline.
