# Relay — fix-1452-safe-seed

**Issue:** #1452 (part of #1440). **Risk tier:** `routine`. **No code written yet, no commits.**

**Worktree (the REAL one — handoff doc's literal path is a stale decoy, still on `main`):**
`/home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/fix-1452-safe-seed`
**Branch:** `fix-1452-safe-seed`. `node_modules` already installed — do NOT re-run `pnpm install`.

**Coordinator:** label `Coordinator`, session `0bb9f516-c026-454f-bc97-dc9faf43bd20` — verify via
fresh `herdr pane list` before messaging (never a cached pane id). Already notified of this relay
and of the decoy-path finding.

## What #1452 requires (already read in full — do not re-read issue)

Design decision is LOCKED by Ben (2026-08-12, issue comment) — do not re-litigate. Build:
1. UAT spec: throwaway account → trigger real briefing generation via the actual worker path (not
   a fixture insert) → poll/wait for the row → live walk of Today page showing ≥1 briefing card
   **rendered** (not empty `ALL CLEARTODAY` frame) → screenshot → confirm zero old-product-name
   occurrences in rendered content → clean up everything created. **No destructive seed/reset of
   the shared dev DB — this is the entire point of #1452, non-negotiable.**
2. Rejected alternatives (don't reconsider): dedicated non-shared instance; insert-by-recorded-id
   fixtures.

## Done
- Correctly located in the real worktree (see above), confirmed clean tree.
- Read boot file, handoff doc, #1452 issue + Ben's design-decision comment in full.
- Pulled 4 relevant UAT-trap memories (locator.count() no auto-wait; poll for "scored" not just
  present; psql prints command tag on line after RETURNING row; Postgres UPDATE has no ORDER BY;
  UAT container can't reach host — fixture must run as a container on the compose network).

## Not done — next steps in order
1. **Confirm UAT harness DB isolation model** — read `tests/uat/provisioner.ts`. Working hypothesis
   (unverified): `pnpm test:uat` provisions its own ephemeral per-run Postgres via Compose, so the
   chosen approach is safe by construction and never touches the shared dev DB at all — the
   "shared DB" risk in the issue may instead concern a manual/persistent live-walk step. Verify
   before finalizing the plan; this determines how the "leave DB as found" exit criterion is
   actually satisfied/proven.
2. **Locate the real briefing-generation worker path** — `packages/briefings` exists (found via
   `find`, unopened) and `packages/shared/src/briefings-api.ts` (shared contract, unopened). Find
   the function/queue job that a UAT spec should invoke to trigger generation for a throwaway user
   (not a direct row insert).
3. Read one exemplar UAT spec for the `signIn`/onboarding-skip helper pattern and `uatLevel` export
   convention (e.g. `real-chat-onboarding.uat.spec.ts` or `runtime-context.uat.spec.ts`).
4. **Step ½ of `coordinated-build`**: verify spec premises still hold on this branch — in
   particular check whether PR #1429 (`fix-1429-briefing-css`, same `briefing-action-rows.tsx`) has
   merged; if not, use durable role/text selectors, not its CSS classes (per handoff collision
   note).
5. Plan via `plan-build` → `docs/superpowers/plans/2026-08-12-fix-1452-safe-seed.md` (seams check
   w/ file:line citations; UAT spec path `tests/uat/specs/<slug>.uat.spec.ts`; row in
   `.claude/skills/coordinate/uat-trigger-map.tsv`).
6. Message coordinator for plan approval — **STOP and wait**, do not write code first.
7. TDD build, one task per commit, `Co-Authored-By: Claude` trailer, `git add` explicit paths only.
8. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main` before every push.
9. `coordinated-wrap-up`: own isolated-DB gate run, push, PR rebased on `origin/main`, live-path
   proof via `gh pr comment` (rendered-card screenshot + shared-DB-left-as-found evidence), report
   to coordinator. Never merge, never touch board/milestones/`docs/coordination/`.

Read the issue/plan by SECTION only for your current step — full-reads bloat a fresh context and
force a premature relay with no progress. BUILD and commit; that's what counts as progress.
