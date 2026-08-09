# w5d-chat-surface relay #5 — 2026-08-09

**Continues:** `2026-08-09-w5d-chat-surface-relay4.md` (read that first for spec/plan pointers —
unchanged, still applies). Issues #1255, #1451. Worktree/branch: this worktree, `w5d-chat-surface`.
**PR:** https://github.com/motioneso/moss/pull/1482 — still OPEN, MERGEABLE, unchanged from relay4
(gate RED / pre-existing-cause explanation already in the PR body — do not redo that work).

**Coordinator:** re-resolve fresh via `herdr agent list` — do not trust a name/session baked into
this doc. As of this relay it was agent name `relay6-coordinator`, session
`9c7ffdf7-4ccc-4378-aa3e-4f2f6f43a171`, pane `w1:p3R` — likely stale by the time you read this.

## Status: only the live-path proof + PR comment + coordinator report remain

A throwaway dev instance is **already running** in this worktree, standing on non-default ports so
it doesn't collide with sibling worktrees:
- API: `PORT=3098`, PID **920789** (listens on :3098)
- Web: vite `--port 5198 --strictPort`, PID **948326** (listens on :5198) — started via
  `pnpm exec vite --host 0.0.0.0 --port 5198 --strictPort` run from `apps/web` directly (NOT via
  `pnpm --filter @moss/web dev -- --port ...` — that mangles arg-forwarding, see gotcha below).
- Env used: `JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:3098,http://localhost:5198"`,
  `BETTER_AUTH_SECRET="w5d-chat-surface-dev-secret-throwaway"`,
  `JARVIS_VAULT_ROOT="<this session's scratchpad>/w5d-vault"`,
  `JARVIS_API_PROXY_TARGET="http://localhost:3098"` (web). DB is the normal shared dev Postgres
  (`jarv1s-postgres` :55433, db `jarv1s`) — no isolated gate DB needed for this, just UI browsing.
- Login: `ben@ben.com` / `jarvistest123!` — confirmed working.
- Verify still up before reusing: `ss -ltnp | grep -E ':3098|:5198'`. If dead, restart with the env
  above (see relay4 doc / memory `dev-instance-lan-spinup-trusted-origins` for the trusted-origins
  trap this recipe avoids).

**Scratch Playwright script already written** (untracked, NOT committed — do not `git add` it):
`apps/web/persona-flash-proof.mjs`. It: (1) signs in, (2) sets assistant name to `"Persimmon"` via
Settings → Assistant & AI (`/settings?section=assistant`,
`input[aria-label="Assistant name"]` → "Save persona" button), (3) checks the shell chat button
aria-label (`button[aria-label^="Chat with"]`), drawer header (`.chatd__name`), and composer
placeholder (`textarea[aria-label^="Message "]`) all show the custom name, (4) does a **second**
reload with `page.route('**/api/me/persona', ...)` delayed 3.5s and screenshots every 500ms during
the loading window — the actual flash-proof — to `<scratchpad>/shots/`. Run it with
`cd apps/web && node persona-flash-proof.mjs` (needs to run from inside `apps/web` for
`@playwright/test` module resolution — running from the scratchpad dir fails with
`ERR_MODULE_NOT_FOUND`).

## Blocker hit this relay — NOT YET RESOLVED

The script's `signIn()` (uses `browser.newContext()` → `context.newPage()`, fills email/password,
clicks submit, then `waitForSelector` immediately) **times out staying on the sign-in screen** —
confirmed via added diagnostics, the page body still shows the sign-in form after submit.

A **separate, simpler manual test** (`browser.newPage()` directly, no explicit context, same
fill+click, then a plain `waitForTimeout(3000)` before checking selectors) **did work** — landed on
`/today` with the shell rendered (`"Chat with Moss"` button present, confirmed via
`$$eval('button[aria-label]', ...)`).

Prime suspect: the dev-only **Agentation annotation toolbar** — visible in the failed run's body-text
dump (`MCP Connection`, `Webhooks`, `Output Detail` etc. — this is the toolbar's own UI, not app
content) — memory **`agentation-overlay-steals-first-textarea`** already documents that this overlay
steals the first textarea/input on the page in dev builds, which is a very plausible reason a
scripted `.fill()`+immediate `waitForSelector` loses the race while a slower manual
`waitForTimeout`-based flow doesn't. **Root cause not confirmed** — didn't have context budget to
bisect (context vs. no-context, or the diagnostic try/catch itself changing timing, or the overlay
theory outright). Read that memory file before touching this again.

## Next step for the agent picking this up

1. Re-resolve the coordinator's pane fresh (see above).
2. Fix `signIn()` in `apps/web/persona-flash-proof.mjs` — likely either (a) block/strip the
   Agentation overlay before navigating (its healthcheck hits `localhost:4747`; consider
   `page.route('**://localhost:4747/**', route => route.abort())` before `page.goto`, or find its
   dev-mount env gate and disable it for this instance), or (b) just match the working manual
   pattern: plain `page.waitForTimeout(~3000)` after the submit click instead of an immediate
   `waitForSelector`. Confirm with a quick smoke run before trusting the full script.
3. Run the full script. Verify the DOM-text-scan log lines it prints
   (`contains "Moss": false, contains "Persimmon": true` etc. during every 500ms sample of the
   throttled window) plus the screenshots in `<scratchpad>/shots/` actually show: during the
   artificially-slowed persona fetch, a bounded loader with **no** "Moss" or any surface text
   anywhere (app.tsx's boot gate blocking render is the actual mechanism under test — see
   `app.tsx:212` `personaQuery.isLoading` gate); after it resolves, "Persimmon" on the shell chat
   button, drawer header, and composer placeholder.
4. Post the proof on the PR: `gh pr comment 1482 --body "..."` per Live-Path Gate. Since this CLI
   can't attach local image files to a comment inline, either (a) describe the DOM-text-scan
   timestamps/results precisely in the comment body as the evidence (script output is deterministic
   and inspectable), or (b) check how other Live-Path Gate PR comments in this repo attached
   screenshots (`gh pr view <n> --comments` on a recent merged PR) and follow that pattern if one
   exists. Don't invent a new upload mechanism without checking precedent first.
5. Tear down: kill the **exact PIDs** above (re-verify via `ss -ltnp` first, they may have changed
   if restarted) plus any leftover `chromium`/node Playwright processes the script spawned
   (`pgrep -af chromium` scoped, don't pattern-kill broadly). Delete
   `apps/web/persona-flash-proof.mjs` before finishing (untracked scratch file in a shared
   worktree — never commit it).
6. Report to the coordinator: PR link, verification summary (RED-gate/pre-existing-cause — already
   in PR body from relay4, just restate briefly), live-path proof link/status. Do **not** merge,
   close the issue, or move the board.

## Gotcha this relay found (not yet in memory — save it if confirmed)

`pnpm --filter @moss/web dev -- --port 5198 --strictPort` does **not** forward flags cleanly through
this package's `dev` script (`vite --host 0.0.0.0`) — pnpm appended a literal second `--` before the
extra args, so vite saw them as positional args and silently fell back to its default port (which
then auto-incremented past the already-occupied :5173/:5174 to :5175, ignoring `--strictPort`).
Fix: run vite directly — `cd apps/web && pnpm exec vite --host 0.0.0.0 --port <port> --strictPort`.

## Reminders

- Relay trigger is the meter's 70% warning — don't invent a higher personal threshold.
- Never `git add -A`/bare-commit in this shared worktree; commit by explicit path (see
  `shared-checkout` skill) — only this doc should be committed this relay, nothing else changed.
