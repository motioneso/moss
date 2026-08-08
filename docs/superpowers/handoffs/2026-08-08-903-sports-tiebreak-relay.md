# Relay — #903 sports primary-follow tie-break

- Issue: #903. Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` (#903 row).
- Plan (approved by Coordinator): `docs/superpowers/plans/2026-08-08-903-sports-primary-follow-tiebreak.md`
- Worktree/branch: this worktree, `fix-903-sports-tiebreak`.
- Coordinator: Herdr label `Coordinator` — resolve pane fresh by label + session id
  (`019fe31f-18ba-7342-b5dd-83db98923b31`), never a baked `…-N`.

## Done (committed, rebased clean on origin/main)

- `02fff920c` — `fix(#903): break sports primary-follow ties by ascending id`
  (`packages/sports/src/followed-groups.ts`, `packages/sports/src/repository.ts`,
  `tests/unit/sports-followed-groups.test.ts`)
- `b53c94fd8` — `docs(#903): add build plan ...`
- Rebased onto `origin/main` at `00ec6d5f5` (picked up the shared spec's Prettier fix — do NOT
  re-patch that spec file).
- New regression test confirmed **failing pre-fix** (order-dependent result), **passing post-fix**.
- Pre-push trio all green: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — EXIT=0 each.
- Working tree clean.

## Left to do

1. Full gate via the `verify-gate` skill (never run `pnpm verify:foundation` directly — DB
   isolation required).
2. Live-path UAT proof: follow two competitions on the live dev Sports surface with equal
   `created_at` (or verify tie-break stability across reloads), screenshot + note per
   `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate. Plan doc has the exact scenario under
   "Live-path proof".
3. `coordinated-wrap-up`: push, open PR, post live-path proof comment, report PR + evidence to
   Coordinator. Do not merge/close/move board — Coordinator's job.

## Notes

- Read the plan doc's "Verification" section for exact commands — don't re-derive.
- Don't re-run `pnpm install` — `node_modules` already present in this worktree.
