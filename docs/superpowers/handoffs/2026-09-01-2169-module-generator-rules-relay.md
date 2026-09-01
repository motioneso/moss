# Relay handoff — #2169 module generator manifest rules

**Plan (coordinator-approved, no fork):** `docs/superpowers/specs/2026-09-01-2169-module-generator-rules-plan.md`
**Issue:** #2169. **Branch/worktree:** `build/2169-module-generator-rules` in this worktree.
**Coordinator:** registered agent name `coordinator` (resolve fresh from `herdr agent list` —
do not reuse a pane number from this doc).
**Risk tier:** sensitive. **Relay depth:** this is relay 1 (context-meter 70% warning fired
with the plan already built and green — not a mis-scope; only wrap-up is left).

## Done (all three commits already on this branch, rebased onto current origin/main, tree clean)

- `45133136f` — guide section 11 + module-build-live-agent persona now state the tool-name
  prefix rule and the non-empty fetchHosts rule.
- `af533ba81` — one regression test in `tests/unit/external-validate.test.ts` asserting both
  diagnostics independently in one manifest (validator does not short-circuit between them —
  confirmed by reading `packages/module-registry/src/external/validate.ts:722-742`).
- `6469903fd` — the plan doc itself.
- No changes to `validate.ts` or `policy.ts` (both rules were already enforced there — this
  issue is a docs/persona gap only, per the Fable ruling).
- Verified green just before this relay, all unpiped:
  - `pnpm vitest run tests/unit/external-validate.test.ts` → 53 passed, `EXIT=0`.
  - `pnpm format:check` → `EXIT=0`. `pnpm lint` → `EXIT=0`. `pnpm typecheck` → `EXIT=0`.
  - `git fetch origin main && git rebase origin/main` → already up to date, no conflicts.

## What's left (in order)

1. Run the full local gate through the **`verify-gate` skill** (never `pnpm verify:foundation`
   directly, never piped). This is the only DB-touching step left.
2. Push the branch, open the PR against `main`. Fill in the PR template's Release note section —
   this is an internal generator-pipeline fix, not user-visible, so `Category: N/A`.
3. **Live-path proof:** per the plan's "Live-path note" section, this change has no user-facing
   UI — it only affects the module-build live-agent's persona text and a doc. The real proof that
   the persona change works is PR #2101's own owed re-proof (out of scope for this issue — do not
   touch PR #2101 or its worktree/branch). Post the PR comment stating this plainly and report
   status as **code-complete, unverified** for the live-path gate specifically (the regression
   test is the automated proof that ships with this PR). Do not attempt to fabricate a live
   module-build run here.
4. Report the PR link + green evidence + the live-path note to the coordinator (agent name
   `coordinator`, resolved fresh). Do not merge, do not touch the board/milestones — that's the
   coordinator's job. Then stop; that is this lane's finish line.

## Standing constraints (unchanged from the original brief)

- Never touch PR #2101's worktree/branch. Never touch `docs/coordination/`. Never broad-add
  (`git add -A`/`.`); this worktree is otherwise exclusive to this lane, but keep explicit-path
  commits anyway. Never run repo-wide formatting (only touched files were reformatted above).
  Never merge. All waits event-driven, never polled.
- This is relay 1 — one relay is the budget for this lane. If a *second* 70% warning fires with
  no PR open yet, do not relay again: push what's there, report to the coordinator that the slice
  needs re-scoping.

## Reference (already resolved, no need to re-derive)

- Guide section 11 location: `docs/module-developer-guide.md:332` (now `332-345` after the
  edit).
- Persona array: `apps/worker/src/module-build-live-agent.ts:39-51`.
- New test: `tests/unit/external-validate.test.ts`, right after the "rejects unprefixed and
  duplicate worker tools" case, inside `describe("validateExternalModuleManifest (#917)", ...)`.
- Validator rules (unchanged, for citing in the PR body if useful):
  prefix at `packages/module-registry/src/external/validate.ts:648-656`; fetchHosts at
  `packages/module-registry/src/external/validate.ts:729-742` calling
  `assertValidFetchHosts` in `packages/host-fetch/src/policy.ts:6-14`.
