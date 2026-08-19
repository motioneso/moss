# Relay 4 — #989 Sports settings dogfood hardening — QA RED, fix + re-QA

**Worktree:** `~/Jarv1s/.claude/worktrees/ux-989-sports-settings-build` (already checked out — do NOT re-clone, do NOT `pnpm install`, `node_modules` present)
**Branch:** `ux/989-sports-settings-build` (pushed, PR open)
**PR:** https://github.com/motioneso/Jarv1s/pull/1009 — **QA VERDICT: RED, do not merge.**
**QA comment:** https://github.com/motioneso/Jarv1s/pull/1009#issuecomment-4955504323
**Supervising coordinator:** label `UX Coordinator` — re-resolve fresh via `herdr pane list` before messaging.

## Status: all 6 plan tasks done+committed+pushed. PR open, QA reviewed code CLEAN, but RED on 2 non-code blockers.

Code review itself: **0 blocking, 0 non-blocking findings** — implementation matches spec
decisions 1-6, invariants ok (no routes/service/repo/SQL/shell touched). The RED is entirely
about these two gates:

## Blocker 1 — CI RED: plan doc fails `pnpm format:check`

File: `docs/superpowers/plans/2026-07-12-sports-settings-dogfood-hardening.md` (part of this
PR's diff — it was added on this branch by an earlier relay's docs commit, so it's now this PR's
problem to fix, not out-of-scope). Not a flake, deterministic.

**I (predecessor) previously declined to fix this**, wrongly reasoning the prettier diff would
change snippet *meaning* — I re-checked and it does NOT: the diff is pure reformatting (JSX
expression-container brace wrapping, blank-line spacing, markdown-escaping `jds-*` → `jds-\*` for
rendering safety). Same logic, same rendered content, just prettier's canonical style. **QA
confirmed this is required and not waivable.**

Fix:
```bash
npx prettier --write docs/superpowers/plans/2026-07-12-sports-settings-dogfood-hardening.md
git diff docs/superpowers/plans/2026-07-12-sports-settings-dogfood-hardening.md   # eyeball: no semantic change, just formatting
git add docs/superpowers/plans/2026-07-12-sports-settings-dogfood-hardening.md
git commit -m "style(docs): prettier-format the #989 plan doc to unblock format:check"
```
Then confirm: `pnpm format:check` exits 0.

## Blocker 2 — live-path gate not satisfied: no real dev-instance walkthrough

Per #1000 UAT harness policy (mocked Playwright insufficient alone for user-facing Settings
PRs — see `e2e-dev-uat-for-ui-features` project memory). Need:

1. A real dev instance running (frontend `apps/web` Vite + backend API + Postgres with a real
   dev user session) — check what's ALREADY running before starting anything new, other agent
   sessions share this box:
   - `ps aux | grep -E "vite|tsx watch src/server"` showed (at last check): a `vite --host
     0.0.0.0` already running from `/home/ben/Jarv1s/apps/web` (not this worktree — the main
     checkout) on default port, another vite on `:5174` from an unrelated dir, and an API dev
     server (`tsx watch src/server.ts`) running from worktree `668-sports-feedback-build`. None
     of these are guaranteed to be pointed at THIS branch's code — verify before using, or start
     your own scoped instance (`pnpm dev --filter @jarv1s/web -- --host 0.0.0.0` /
     equivalent, check `package.json` dev scripts) bound to a free port so you don't collide with
     other agents' preview instances. Per `dev-preview-recipe` memory: prod runs on :1533 via
     JarvisProd — do not touch; use source dev servers instead.
   - Needs a logged-in dev user with the `sports` module active. Check `tests/e2e/mock-*.ts` /
     existing E2E onboarding flow for how a real dev account gets created, or ask coordinator if
     a standing dev user already exists.
2. Navigate to `/settings?section=modules&module=sports` (verified-correct deep link, see relay-3
   handoff), exercise: search → follow a team → see "Following" state → unfollow; follow-all a
   league → unfollow-all; open "Browse leagues" disclosure; repeat at narrow viewport (~390px).
3. Assert each key state with live DOM/network evidence (past design
   review memory — check if it still exists/applies, or use Playwright assertions against the REAL
   dev server, i.e. non-mocked).
4. Post a PR comment on #1009 linking the assertions/run (quote directly or link an artifact
   path) describing what was exercised.

## After both fixed

1. Push, note exact SHA, confirm CI status (`gh pr checks 1009` or equivalent) — must be green,
   not just locally green.
2. Report to `UX Coordinator` (re-resolve label fresh) requesting re-QA. Do NOT merge, do NOT
   move the board.
3. Relay again yourself if you hit 70% context before this is fully done — same procedure.

## Locked file paths (unchanged)
`packages/sports/src/settings/index.tsx`, `packages/sports/src/settings/sports-2.css`,
`tests/unit/settings-sports-pane.test.tsx`, `tests/e2e/sports-settings.spec.ts`, plus now the
plan doc fix (Blocker 1, docs-only, formatting-only) and a PR comment (no file). No
shell/routes/service/repository/SQL edits.

## Predecessor session (safe to reap once you confirm driving)
Resolve fresh by label — do not trust a baked-in id/pane number here (they reflow).
