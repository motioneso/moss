# Relay 4: #1755 Workshop page

PR is open, gated, and pushed. Only remaining step is the live-path proof comment.

Read only if you need it (don't re-read in full unless stuck):
- `docs/superpowers/handoffs/2026-08-20-1755-workshop-page-relay3.md` — prior relay (design-system
  audit + wrap-up instructions, both now done).
- Coordination doc (exit criteria/bans): `git show d04251c05:docs/coordination/handoff-1755-workshop-page.md`
  (lives on branch `coord-1258-postmerge`, not this branch — normal, not an error).

## Done and committed (7 commits on this branch since main, all pushed)

1-3. Scaffold, groups rendering, admin-gating (see relay3 doc for detail).
4. `style(#1755): run prettier on the Workshop scaffold` — 4 files the gate's format:check flagged.
5. `fix(#1755): classify @moss/workshop in the module dependency allowlist` — a real gate finding:
   `tests/unit/module-dependency-allowlist.test.ts` didn't know the new package. Added
   `@moss/workshop` to `FEATURE_PACKAGES` (it's a distinct, user-recognizable product page). No new
   sanctioned coupling edge needed — it only depends on `@moss/ui`, which is platform.

**PR open:** https://github.com/motioneso/moss/pull/1804 — rebased on origin/main as of
`255633995`.

## Verified green

- Design-system audit (task 24 from relay3): ran the real grep-diff, zero invented classes.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: all exit 0 (checked individually, not piped).
- Full gate (`scripts/run-gate.sh`, isolated DB `jarvis_gate_1755_workshop_page`): reached
  `test:unit` and failed there on 4 files unrelated to this branch's diff —
  `module-sdk-worker.test.ts`, `mcp-gateway-validation.test.ts`,
  `external-module-invocation-budget.test.ts`, `local-embedding-provider.test.ts`. This matches
  the documented trap in memory `module-sdk-worker-tests-fail-locally-green-in-ci` almost exactly
  (one extra file, `local-embedding-provider.test.ts`, joined this time — same worker-timing/CPU
  family). Confirmed it's the box, not the branch: `git diff --name-only origin/main...HEAD` touches
  neither `packages/ai/` nor `packages/module-sdk/`, and the most recent CI run on main (32444769842)
  shows `test:unit` green including both `mcp-gateway-validation.test.ts` and
  `module-sdk-worker.test.ts`. That CI run's only real failure was an unrelated Playwright flake in
  `chat-drawer.spec.ts`. `db:migrate` / `test:uat-seed` / `test:integration` were not reached
  locally as a result — this is stated plainly in the PR body; CI will run the full gate.
- **This is worth telling the coordinator even if the next session doesn't touch it further** —
  the failing-file list for this trap grew by one (`local-embedding-provider.test.ts`). Worth a
  memory update if you have a moment.

## NOT yet done — pick up here

1. **Live-path proof.** The coordination doc requires this (real UI surface, admin-gated): "Post a
   `gh pr comment` with the feature exercised on a live dev instance (screenshot/DOM evidence), not
   just component tests." Not done yet — deliberately deferred rather than rushed, because:
   - The shared dev instance (`http://192.168.50.36:5173`, API `:3000`) is currently running from
     source in `/home/ben/Jarv1s` (main branch, PID 1929165/1929166, started 14:00) — **not this
     branch's code**. Workshop isn't on main yet, so it won't show up there as-is.
   - Other sessions were actively using shared resources when I checked (a `1752-module-discovery-holder`
     worktree running unit tests, an `agent-a2246e0b65b658587` worktree also mid-test) — swapping
     the shared dev instance to this branch, or restarting it, risked disrupting their work.
   - I ran out of context budget (70% trigger) before working out a way to prove this without
     touching shared state, so I'm handing it off rather than rushing an action on shared
     infrastructure.
   2. **Two options for the next session, in order of preference:**
      a. Check whether `#1752`/`#1753` (the Workshop backend) have landed on main since this was
         written — if so, the shared dev instance may already be closer to ready, and installing
         `@moss/workshop` there via the normal module-install path (see memory
         `dev-module-install-needs-manual-reconcile` — reconcile needed, no tables otherwise) might
         be low-risk. Check `git log origin/main -5` and `gh pr list` for #1752/#1753 status first.
      b. Otherwise, stand up an isolated instance from this worktree specifically for the proof
         (own ports, own DB) rather than touching the shared one — the `run` skill
         (`.claude/skills/run/SKILL.md` via the `run` skill or examples under
         `examples/server.md`) may have the pattern; I hadn't finished reading it when I hit the
         relay trigger.
   3. Once you have a live render: log in as `ben@ben.com` / `jarvistest123!` (admin), navigate to
      `/workshop`, confirm the page renders with the Needs you / Building now / Live groups (or
      their `EmptyState` fallback, since #1752/#1753 backend data may still be absent — say
      explicitly which you saw), and post a `gh pr comment` on #1804 with a screenshot or bounded
      DOM evidence. Also verify the admin-gating: a non-admin account should not see the nav entry
      and should get the access-denied empty state at `/workshop` directly (already covered by
      component tests, but the live-path proof should ideally show this rendering path if quick).
   4. After posting the proof comment, report done to the coordinator per `coordinated-wrap-up` —
      the PR itself is already open and gated; teardown of the temp instance (if you stood up an
      isolated one for the proof) is the only remaining state to clean up before declaring the
      worktree reapable.

## Traps already found, don't re-derive

(carried forward from relay3, still true)
- `@moss/workshop` needed `@moss/ui` as a direct dependency (for `EmptyState`) — already added.
- `apps/web`'s `iconMap` had no `wrench` icon — added (`lucide-react`'s `Wrench`).
- Admin gating is scoped to exactly one call site in `app-shell.tsx` (`buildShellNavigation`) —
  deliberate scope decision, don't extend to `resolvePageHeading`/`CommandPalette`.
- `node_modules` already installed — do not re-run `pnpm install` unless adding a new dependency.
- New trap this relay: `pnpm format` / `pnpm typecheck` / `pnpm lint` each take >120s on this repo
  — always background them (`run_in_background` or `&` + poll), the default Bash timeout isn't
  enough.

## Bookkeeping

- Same worktree/branch, continue here — this is a build-agent relay (not a coordinator relay).
- Coordinator label: `Coordinator` — resolve fresh by label + session id via `herdr pane list`.
- Relay trigger: context-meter 70% warning, fired right after the PR was opened and pre-push
  checks passed. Nothing uncommitted or unpushed was left behind — `git status --porcelain` is
  clean and `HEAD` matches `origin/1755-workshop-page`.
