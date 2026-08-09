# #1115 relay 2 — live-path proof blocked on sign-in redirect

PR **#1478** is open (https://github.com/motioneso/moss/pull/1478), gate-green
(`scripts/run-gate.sh` rc=0 on gate DB `jarvis_gate_fix_1115_overdue_indicator`), pre-push trio
green, rebased on origin/main at push time. Build itself (`f9ac8fe24` + doc `e4c064cd2` +
format-fix `67abfa8bf`) is done — **only the live-path proof is left**, then report to Coordinator.

## Only remaining task: fix the Playwright sign-in, get the two screenshots, comment on PR

Script: `.scratch-livepath/live-path-1115.mjs` (run with cwd = repo root, not `/tmp` — ESM
resolution needs the workspace `node_modules`). It signs in as `ben@ben.com` / `jarvistest123!`,
goes to `/tasks`, creates `E2E-1115-<ts> overdue proof task` with a due date 3 days in the past via
the Details dialog (`#task-due-input`, submit button is `"Add task"` not `"Save"`), screenshots the
row (expect exactly one "Overdue"), toggles the checkbox done, screenshots again (expect the badge
still the sole "Overdue").

**Blocker:** sign-in POSTs 200 (`POST /api/auth/sign-in/email` → 200 in
`.../scratchpad/devinstance/api.log`) but the browser UI never leaves the sign-in screen —
`page.url()` stays `http://localhost:5299/` after the click, and a follow-up `goto('/tasks')`
times out. Not yet root-caused. Next things to try, in order:

1. Check the actual `/api/me` response body right after sign-in (not just that a request was
   logged) — confirm a session was actually established server-side.
2. Check browser console/network errors in the Playwright page (`page.on('console', ...)`,
   `page.on('requestfailed', ...)`) — add before the sign-in click.
3. Try an explicit `page.reload()` or a longer wait after sign-in before asserting URL — client-side
   router may need a tick.
4. Check cookie attributes: `BETTER_AUTH_SECRET` here is a throwaway dev value
   (`fix1115-livepath-dev-secret-value-not-prod`, in `.../scratchpad/devinstance/dev-env.sh`) on a
   non-standard port (5299 web / 3299 api via proxy) — verify the session cookie is actually being
   set/sent (SameSite/domain) even though trusted-origins already lists both ports.

If this can't be resolved quickly, the honest fallback is to report PR #1478 as **code-complete,
unverified** (state the sign-in blocker as the reason) rather than force a false "done".

## Dev instance already running — reuse it, don't respin

- API: pid **405565**, listening on `:3299` (confirmed via `/health` → `{"ok":true}`)
- Web: pid **405285** (the real vite/node listener — NOT 405229, which was the `nohup`/pnpm
  wrapper pid), listening on `:5299`
- Env file: `/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-fix-1115-overdue-indicator/39efc7c2-f3bc-4334-b0e3-55896a542a5c/scratchpad/devinstance/dev-env.sha` region — the actual file is
  `.../scratchpad/devinstance/dev-env.sh` (sourced when the instance was started; not needed again
  unless you have to restart the servers)
- Logs: `.../scratchpad/devinstance/api.log`, `web.log`
- DB: shared dev Postgres `jarv1s-postgres` container, default db `jarv1s` via `@moss/db` defaults
  (localhost:55433) — **not** an isolated gate DB, this is the real dev-instance DB, same one Ben's
  own dev UI would point at, so clean up any test task you create.

## After the screenshots land

1. `gh pr comment 1478 --body "..."` with the two screenshots + a one-line description of what each
   shows (non-done overdue row: exactly one "Overdue"; same task marked done: badge still the sole
   "Overdue"). Attach via `gh pr comment 1478 --body-file` won't attach images — use
   `gh pr comment 1478 -F -` is also body-only; upload screenshots by referencing them as normal gh
   attachments (`gh pr comment 1478 --body "..." ` after uploading via the GitHub web UI is not
   available headlessly — simplest is to describe the result in the comment body and note the
   screenshot files live at
   `.../scratchpad/devinstance/1115-non-done-overdue.png` and `1115-done-overdue.png`; if there's a
   way to attach inline images to a `gh pr comment` in this environment, use it, otherwise say
   plainly in the comment that screenshots were captured locally and describe pass/fail).
2. Delete the test task (`E2E-1115-<marker>` — the script logs `MARKER=<value>`) from the dev DB by
   id, note the row count before/after.
3. Kill dev instance by **explicit PID only**: `kill 405565 405285` (never `pkill -f`).
4. `rm -rf .scratch-livepath` (untracked scratch, not meant to be committed).
5. Report to the **Coordinator** — re-resolve the Herdr pane fresh via `herdr pane list`, label
   "Coordinator", confirm exactly one match (do not reuse any pane number from a prior session —
   they reflow). Terse result-first report per `coordinated-wrap-up` step 4 template: PR link,
   VF_EXIT=0 (full suite, gate DB `jarvis_gate_fix_1115_overdue_indicator`), live-path status
   (proof posted, or "NOT MET — code-complete, unverified, reason: <sign-in blocker>"), branch
   pushed/rebased, deferred: none, teardown: instance stopped (PIDs 405565/405285), N seed rows
   deleted, worktree reapable. Then **stop** — merge/board is the coordinator's job.

## Not actionable

- `git remote` prints a deprecation notice (`motioneso/Jarv1s` → `motioneso/moss`) — push/PR-create
  against the old remote URL still works fine, ignore it.
