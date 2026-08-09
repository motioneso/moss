# w5d-chat-surface relay #3 — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md`, lane D.
**Plan:** `docs/superpowers/plans/2026-08-09-fix-1255-1451-chat-drawer-availability-persona-prefetch.md`
— read in full if you need task detail, but both tasks are already DONE (see below); you shouldn't
need it except for the Evidence section (§Task 2 live-path proof) and Verification commands.
**Issues:** #1255, #1451. Worktree/branch: this worktree, `w5d-chat-surface`.
**Coordinator:** agent name `coord-waves36-r4`, session `82ef9cf0-c359-4df5-9d66-590312be2549` —
re-resolve fresh via `herdr agent list`/`herdr pane list` before trusting this, it may have
relayed forward again. Plan approval was confirmed by the coordinator this relay (message
received mid-build); no outstanding approval gate remains.

## Status: both tasks built and committed. Verification gate + PR + live-path proof still needed.

Commits on this branch (top of `git log`):
1. `286fe1837` — Task 1 (#1255): `chat-drawer.tsx` availability gate swap + new test
   `tests/unit/chat-drawer-availability.test.ts`.
2. `5ef6f3352` — Task 2 (#1451): `client.ts` `getPersonaSettings` 4s timeout + `app.tsx`
   `personaQuery` boot gate.

Already verified clean:
- `pnpm test:unit tests/unit/chat-drawer-availability.test.ts tests/unit/chat-drawer-activity.test.tsx tests/unit/onboarding-chat-availability.test.ts` → EXIT=0, 16 tests passed.
- `pnpm --filter @moss/web typecheck` → EXIT=0 (clean).
- `pnpm typecheck` (root, all three sub-checks) → EXIT=2, but **13 pre-existing errors, all in
  `chat-drawer.tsx`**, confirmed present on the branch tip BEFORE any of my edits (verified via
  `git stash` + rerun) — root `tsconfig.json` uses `moduleResolution: NodeNext` while
  `apps/web/tsconfig.json` overrides to `Bundler`; the root pass flags every relative import in
  that file for missing `.js` extensions. Not caused by, or fixable within, this lane's scope
  (owned files are `chat-drawer.tsx`, `use-assistant-name.ts`, plus touches to `app.tsx`/`client.ts`
  — a repo-wide import-extension fix is out of scope). Confirmed zero *new* errors from either
  commit (diffed error sets before/after).

## Next step

1. Re-resolve the coordinator's current pane fresh (don't trust the session id above blindly).
2. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (typecheck will show the same
   13 pre-existing errors above — expected, not a blocker) `+ git fetch origin main && git rebase origin/main`.
3. Push, open PR via `coordinated-wrap-up`.
4. **#1451 needs live-path proof** — spec exit criterion §133 explicitly rejects a unit test. On a
   dev instance: set a custom assistant name in Settings → AI persona, sign out/in (or hard-reload),
   confirm via real UI + screenshot/recording that no frame ever shows the default name before the
   custom one, on every surface `useAssistantName()` feeds (drawer header, composer placeholder).
   Post proof on the PR per Live-Path Gate. Plan's "Evidence" section has full detail.
5. Report PR + verification + live-path proof to the coordinator. Do not merge, close the issue, or
   move the board — that's the coordinator's.

## Reminders

- Read the spec/plan by SECTION only if you need it — both tasks are done, so you likely only need
  the plan's Evidence section for step 4.
- Relay trigger is the meter's 70% warning — don't invent a higher personal threshold.
