# Relay: #1412 masthead title/accent space (build phase, at wrap-up)

Branch/worktree: `fix-1412-masthead-space` (this worktree — stay here, `node_modules` present,
skip `pnpm install`). Coordinator label `Coordinator` — re-resolve pane fresh by label + session
id via `herdr pane list`, do not reuse a `…-N` number from this doc.

## Approved plan

`docs/superpowers/plans/2026-08-08-1412-masthead-title-accent-space.md`. Coordinator approved it,
then tightened scope further mid-build (verbal correction, not yet reflected in the plan file
text): reuse the **existing** `1112-today-masthead-oneline.uat.spec.ts` seam instead of a new UAT
spec file. That correction is already implemented (see commits below) — the plan file's Task 2
section (new spec file) is stale/superseded; ignore it, the actual live-path test lives in the
1112 spec.

## Done — all committed on this branch, in order

1. `95e1097a9` — compact plan doc
2. `085d1a633` — **the fix**: `packages/ui/src/masthead.tsx` `{" "}` whitespace node (only when
   `accent` present) + `tests/unit/masthead-ui.test.tsx` (red pre-fix confirmed, green post-fix
   confirmed, ran directly with `pnpm exec vitest run tests/unit/masthead-ui.test.tsx`)
3. `d0974208b` — live-path proof: added one mode-agnostic assertion to the **existing**
   `tests/uat/specs/1112-today-masthead-oneline.uat.spec.ts` (checks `.jds-masthead__title`
   full text equals `topText + " " + accentText`, skips if no accent branch is active) + one new
   row in `.claude/skills/coordinate/uat-trigger-map.tsv` mapping `packages/ui/src/masthead.tsx`
   to that same spec file
4. `40a9ab6e5` — prettier-formatted the plan doc (was the only non-clean file at `format:check`
   time; the shared wave-1 spec's formatting was NOT touched — that fix came from upstream)
5. Rebased onto `origin/main` at `00ec6d5f5` (picks up the shared spec's Prettier fix) — rebase
   was clean, no conflicts.
6. Pre-push trio all green *before* this relay: `pnpm format:check` EXIT=0, `pnpm lint` EXIT=0,
   `pnpm typecheck` EXIT=0 (full workspace, `apps/web`, external-modules — all three subcommands
   in the typecheck chain passed).

Working tree is clean (`git status --porcelain` empty) at relay time.

## Not done — successor's job, from here

**`coordinated-wrap-up` step 2 onward.** The gate (`scripts/run-gate.sh start`) was **NOT
started** — the tool call was interrupted for this mandatory relay before it ran. No gate log
exists yet.

1. `scripts/run-gate.sh start` (defaults to `pnpm verify:foundation`, isolated gate DB — do not
   hand-roll this or you risk the live dev DB) → `scripts/run-gate.sh wait` (give Bash a 600000ms
   timeout, it blocks up to 540s per call — call again if it returns 3) → `scripts/run-gate.sh
   status` for the real exit code (0 green / 1 failed / 2 died / 3 still running). If red, fix
   before proceeding — full suite must be green, not just this component.
2. Push: `git push -u origin fix-1412-masthead-space`.
3. Open PR: `gh pr create --base main --head fix-1412-masthead-space --title
   "fix(#1412): real space between masthead title and accent" --body "<scope, spec link, gate
   exit codes, live-path plan>"`. Reference issue #1412 and the spec
   `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md`.
4. Live-path proof (**required — this is user-facing text**): run the UAT spec —
   `pnpm test:uat -- 1112-today-masthead-oneline > /tmp/masthead-uat.log 2>&1; echo "EXIT=$?"` —
   both tests in that file should pass (the pre-existing greeting/dateline check plus the new
   space-assertion test). Post the run output as a `gh pr comment` on the opened PR.
5. Report to Coordinator via `herdr-pane-message` (re-resolve the `Coordinator` pane fresh):
   PR link, VF_EXIT, live-path proof status, branch/sha, "worktree reapable" (no dev instance or
   seed rows were created in this lane — nothing else to tear down).
6. Then stop — do not move the board, close the issue, or merge. That's the Coordinator's.

## Context for the successor

- No dev instance was started, no DB rows seeded by this lane — teardown line in the final report
  is "none started / none seeded".
- Task list state at relay: #1–4 completed, #5 (live-path/wrap-up) in_progress, #6 pending.
