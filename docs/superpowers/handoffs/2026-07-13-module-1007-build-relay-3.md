# Relay 3 — module-persist-1006 build (#1007 fix + Stage 2 UAT), mid-Task-4

Worktree: `/home/ben/Jarv1s/.claude/worktrees/module-persist-1006`, branch `module-persist-1006`.
`node_modules` present — **skip `pnpm install`**. Coordinator label: `Coordinator` (re-resolve
fresh via `herdr pane list`, never reuse a cached `…-N`). Skill: `coordinated-build`. Tier:
**security**.

## Plan (APPROVED — do not re-litigate)

`docs/superpowers/plans/2026-07-12-module-1007-enoent-guard-and-uat-proof.md` — 6 tasks. Read by
SECTION only. You're resuming Task 4 (line ~201). Tasks 5 (line ~405) and 6 (line ~452) after.

## Done (committed)

Tasks 1-3 same as before (see `ab35d05e`, `c08c13a2`, and Stage 2 stack up). Nothing new
committed this relay — **`scripts/uat/job-search-install.spec.ts` is written but UNCOMMITTED**
(untracked `scripts/uat/`), still failing end-to-end, do not commit yet.

## Task 4 progress — 3 real bugs found + fixed by running against the live stack, none committed

The plan's inlined script (copied verbatim first) had three defects only visible by running it —
all now patched in the working copy:

1. **`import ... from "playwright"` doesn't resolve.** pnpm's strict linking doesn't hoist
   `playwright` (only a transitive dep via `@playwright/test`). Fixed: import `{ chromium, type
   Page }` from `"@playwright/test"` instead (it re-exports both) — no package.json/lockfile
   change needed.
2. **`waitForURL(/\/(onboarding|home|today)?/)` is a no-op wait** — the optional group matches the
   current URL instantly, so `shot(page, "02-post-signup")` fired before the app actually
   navigated (screenshot showed the still-filled signup form, not the post-auth screen, even
   though the signup mutation *had* succeeded server-side). Fixed both `signUpOwner` and
   `resumeAfterRestart` to `await page.locator("section.auth-panel").waitFor({ state: "hidden",
   timeout: 15_000 })` instead.
3. **`resumeAfterRestart`'s `getByRole("button", { name: "Sign in" })` is ambiguous** once
   bootstrap is done — the auth screen then shows a `segmented-control` "Sign in" tab button AND
   the form's submit button, both named "Sign in" (strict-mode violation). Fixed: scope to
   `page.locator("form.auth-form").getByRole("button", { name: "Sign in" })`.
4. **`skipOnboardingIfPresent` doesn't handle the skip-confirmation dialog.** This UAT stack has
   no AI provider connected, so `onboarding-wizard.tsx`'s #369 guard
   (`apps/web/src/onboarding/skip-confirm.tsx`) opens a `SkipConfirmDialog` ("Skip setup without
   connecting a provider?") after clicking "Skip setup" — skipping isn't immediate. Fixed: after
   the first skip click, look for a `"Skip anyway"` button (3s visibility check) and click it too,
   then `waitForURL` for the path to leave `/onboarding`. **This fix landed but has not yet been
   run end-to-end** — that's the next step.

All four fixes are already in `scripts/uat/job-search-install.spec.ts` on disk. Re-verify by
reading the file before trusting this summary (short — read it in full, it's ~150 lines).

## DB state — clean up before your next run

The stack's Postgres (`jarvis-uat-1006-postgres-1`, db `jarv1s`) currently has **one leftover test
user** from debugging (`uat-owner-1006@example.com`, onboarding not completed). The script's
`run()` mode assumes a **fresh bootstrap** (`needsBootstrap: true` → "Create owner account" form
with a Name field) — if you rerun `run` against an existing user, `signUpOwner`'s
`getByLabel("Name")` will fail because the auth screen will already be in sign-in mode. **Delete
the leftover row first:**

```bash
docker exec jarvis-uat-1006-postgres-1 psql -U postgres -d jarv1s -tAc \
  "delete from app.users where email='uat-owner-1006@example.com';"
```

Then rerun Step 3:

```bash
cd /home/ben/Jarv1s/.claude/worktrees/module-persist-1006
UAT_BASE_URL=http://localhost:1545 pnpm exec tsx scripts/uat/job-search-install.spec.ts run
```

**Use `pnpm exec tsx`, not `pnpm dlx tsx`** — `dlx` runs in an isolated dir with no access to this
workspace's `node_modules` (that's how bug #1 above was first discovered).

Expect `RUN OK needsRestart=true`. If it still fails, read the error and capture bounded DOM/log evidence
(pattern: throwaway `scripts/uat/_diagN.ts` files, **delete them before committing** — three were
already made and deleted this relay, don't leave stragglers). Store bounded assertion/log artifacts
in the coordinator's scratchpad `devproof/` directory.

## Next steps (in order)

1. Delete the leftover DB user (above), rerun Step 3, confirm `RUN OK needsRestart=true` and the
   numbered state assertions `01`-`06` (07 is a post-restart assertion).
   If new selector mismatches surface (e.g. the job-search row/install-button text), fix them the
   same way: diagnose with a throwaway script against the live `:1545` stack, don't guess.
2. Step 4: `git add scripts/uat/job-search-install.spec.ts` (that file only) and commit:
   `test(uat): add Playwright job-search install/enable proof script (#1007)`.
3. Task 5 (plan line ~405): restart stack, resume-mode script run
   (`UAT_BASE_URL=http://localhost:1545 pnpm exec tsx scripts/uat/job-search-install.spec.ts
   resume`), then `--force-recreate` + resume-mode run again — the actual #1006/#1007 persistence
   proof. Use env file
   `/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-module-persist-1006/9ed81faa-7b82-45d5-98e4-3da7f0637430/scratchpad/uat-1006/env.uat-1006`
   (port 1545, **not** the plan's literal devproof path — different stack). Remember: `/data/modules`
   is the real persistent-volume mount (plan says `/app/data`, that's stale — already noted as a
   drift to report, not a blocker).
4. Task 6: pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin
   main && git rebase origin/main`, then `coordinated-wrap-up` (push, PR, report to Coordinator —
   include both the Task 3 `/data/modules` drift note AND this relay's 4 script-bug fixes in the
   report, since they're genuine plan corrections worth recording).
5. Self-monitor context; relay again on 70% warning or compaction summary.

## Escalation

Message `Coordinator` (fresh-resolved) once your successor is confirmed driving: "relayed to
<successor pane/label>, safe to reap me." It kills this session's pane.
