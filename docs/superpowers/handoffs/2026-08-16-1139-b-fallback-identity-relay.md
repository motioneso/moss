# Relay — 1139-b-fallback-identity (#1519)

**Worktree/branch:** `.claude/worktrees/1139-b-fallback-identity` / `1139-b-fallback-identity`
(off origin/main). **Coordinator label:** `Coordinator`, session id
`11cf8264-55a8-4fa4-b32b-c8d086469f74` — re-resolve pane fresh via `herdr pane list`, never a
cached number.

## Spec

`docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md` § "Child 1139-B" (lines
139-183). Handoff: `docs/coordination/handoff-1519-1139-b-fallback-identity.md`. Plan (committed):
`docs/superpowers/plans/2026-08-16-1139-b-fallback-identity.md`.

## Done (committed, on this branch)

- `c98a2d997` — test(#1519): identical-fallbacks e2e scenario (`tests/e2e/chat-drawer.spec.ts`) +
  plan doc. **Genuinely observed RED first** (see gotcha below), for the right reason: count
  dropped 2→1 after first matching SSE delivery under the old predicate.
- `79483461e` — fix(#1519): `sameTranscriptRecord` in `apps/web/src/chat/chat-drawer.tsx` now
  requires equal `messageId` when either side has one; falls back to kind+text only when neither
  side has an id.
- Verified GREEN: focused grep (`--grep "identical fallbacks"`), full `chat-drawer.spec.ts` (15/15
  pass), `pnpm --filter web typecheck`, and full-repo `pnpm typecheck` (tsc root +
  `@moss/web` + external-modules) — all exit 0.
- `git status` clean on this branch as of the last commit.

## Gotcha hit this lane (already fixed, note for future lanes)

My new test's SSE route used `**/api/chat/stream` (no trailing `*`); every other route in this
file uses `**/api/chat/stream*` to match the query string on the real request. Without the
wildcard the request goes unhandled and the page hangs (30s timeout on the composer locator, not a
useful RED). Fixed to `stream*`; if you add another SSE mock in this file, copy the wildcard.

Also hit and self-recovered: absolute `/home/ben/Jarv1s/...` paths in `Read`/`Edit`/`Write` calls
silently resolved to the **shared main tree**, not this worktree, early in the session. Diagnosed
via `git status`/`git diff` in both trees, cleanly reverted the accidental main-tree artifacts (a
test edit + a stray plan file — both purely additive, verified via diff before reverting, no other
session's work touched), and redid the work at the correct worktree-rooted paths. No further action
needed here, but worth flagging to the coordinator as a systemic risk for other parallel lanes using
the same absolute-path habit.

## Next steps (in order)

1. Pre-push trio: `pnpm format:check && pnpm lint` (typecheck already green above) — fix anything
   red.
2. `git fetch origin main && git rebase origin/main`.
3. Push branch.
4. `coordinated-wrap-up`: own gate on an isolated gate DB (`verify-gate` skill — never improvise),
   open PR (`Part of #1519`), post live-path proof per spec's Live-path artifact section (UAT on a
   live dev instance — exercise sending two identical messages and confirm no flicker/drop through
   the real UI), report PR + evidence to the coordinator.
5. Message coordinator with plan-ready-equivalent status is already done (plan was pre-approved);
   this relay itself is the next status ping — say "resumed 1519 build, Tasks 1+2 committed+green,
   proceeding to pre-push checks and wrap-up."

## Do NOT

- Re-run `pnpm install` (node_modules already present).
- Re-read the full spec — section only, already captured above.
- Touch `docs/coordination/`, the board, milestones, or merge.
