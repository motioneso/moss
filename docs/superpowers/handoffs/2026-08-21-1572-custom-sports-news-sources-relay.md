# Relay: #1572 custom sports news sources (Task 1)

Relaying because a context compaction summary just appeared in this session. Per the box-wide
context-diet rule and the `relay` skill, hand off now rather than keep building in a
post-compaction context.

## Where things stand

- Spec: `docs/superpowers/specs/2026-08-17-1572-custom-sports-news-sources.md` (Approved)
- Plan: `docs/superpowers/plans/2026-08-21-1572-custom-sports-news-sources.md`
- Task issue: #1572
- Branch/worktree: `1572-custom-sports-news-sources`, this worktree
  (`~/Jarv1s/.claude/worktrees/1572-custom-sports-news-sources`)
- Scope: **Task 1 only** (schema + discovery/preview/confirm REST + settings UI). Tasks 2-3
  (ranking integration, chat tools/export/deletion) are scope-only, blocked on Task 1's live
  end-to-end proof — do not detail or build them yet.
- Coordinator: Herdr label `Coordinator` (currently pane `w1:pK3` — re-resolve fresh, don't reuse
  this number).

## What's done (all committed on this branch)

1. `45f77426b` — schema (migration 0189), REST routes, repository, discovery, settings UI (Task 1
   build itself).
2. `14a8d794f` — unit test coverage for the 5 custom-source REST routes.
3. `0e59e5f10` — **just committed this session**: the live-path UAT spec
   `tests/uat/specs/1572-sports-custom-sources.uat.spec.ts` plus its three rows in
   `.claude/skills/coordinate/uat-trigger-map.tsv`. Confirmed compiling clean (`pnpm exec tsc
   --noEmit` exit 0). Two tests in it:
   - An always-on test that signs in, opens Sports settings
     (`/settings?section=modules&module=sports`), and asserts the "Custom sports news sources"
     section renders with its input and Check button. No real model needed — this is the
     credential-free proof that runs on every default/CI pass.
   - A full add/assign/edit/remove flow, skipped unless the operator sets
     `JARVIS_UAT_REAL_CHAT_ENV_FILE` (same opt-in pattern as
     `tests/uat/specs/926-food-real-chat.uat.spec.ts`), because the preview step does a real
     network fetch plus a real AI policy check that the default UAT seed's fake AI provider
     cannot satisfy.

## What's left before wrap-up

1. **Pre-push trio + rebase** (not yet run this session):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   Fix anything red before pushing.

2. **Full local gate**, using the `verify-gate` skill's safe recipe exactly (dedicated
   `JARVIS_PGDATABASE`, DROP+CREATE, unpiped `pnpm verify:foundation`, check `herdr pane list`
   first to avoid a concurrent gate run crashing shared dev Postgres). Not yet run this session.

3. **Live-path proof** — the actual point of this relay's remaining work. Run the UAT spec against
   a live dev instance (`pnpm test:uat` per `tests/uat/run-uat.ts`'s env conventions —
   `JARVIS_UAT_BASE_URL` / `JARVIS_UAT_PROJECT_NAME` are set by that runner, don't hand-set them).
   At minimum capture real output for the always-on deterministic test. If a real Anthropic token
   is available for `JARVIS_UAT_REAL_CHAT_ENV_FILE`, also run the full add/assign/edit/remove test
   for the strongest possible proof — but the always-on test alone satisfies the gate if a real
   token isn't available; say so plainly rather than skipping the proof comment.

4. **Push, open PR, post the live-path proof** via `coordinated-wrap-up`: push (after step 1),
   open PR, `gh pr comment` with the UAT run output/exit code and what was exercised. Fill in the
   PR template's Release note section (Category/Title/Description — plain English, no jargon), run
   `node scripts/append-release-note.mjs --pr <number>`, commit the resulting
   `docs/WHATS_NEW.md` change onto this branch before final push if the note wasn't already
   appended.

5. **Report to the coordinator** (re-resolve its pane by label `Coordinator` fresh, don't trust the
   `w1:pK3` above) with the PR link and the live-path evidence. Then stop — merge/board/close are
   the coordinator's, not this lane's.

## Notes for the successor

- `node_modules` already exists in this worktree — do not re-run `pnpm install`.
- This is a **shared checkout** — other sessions may be committing here concurrently (this
  session hit exactly that: two commits from another session landed on this branch mid-turn).
  Before any commit, re-check `git status`/`git diff` on the exact paths you're about to commit,
  and use `git add <path>` + `git commit` (not bare `git commit <path>` on untracked new files —
  that silently no-ops instead of adding them; confirmed this session). Never `git add -A`.
- Read the spec/plan by section for what you need, not front-to-back — the plan file above is
  short and already has everything needed for steps 1-5.
- Relay trigger is the same for you: the context-meter 70% warning, or immediately on seeing
  another compaction summary. Don't invent a higher personal threshold.
