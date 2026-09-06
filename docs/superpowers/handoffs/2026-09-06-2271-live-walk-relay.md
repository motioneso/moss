# PR 2271 live walk — handoff (relay 1)

## What this is
Boot brief: `/home/ben/.coord-briefs/boot-2271-live.txt`. Coordinator pane: `w1:pQJ`.
Pull request: https://github.com/motioneso/moss/pull/2271 (issue #2257 follow-up — stop flagging
bulk mail and sign-in notices as tasks). Worktree: this folder, branch `fix/email-triage-bulk-mail`.

## Done so far
1. `pnpm install` — done, clean.
2. **Base branch fixed.** PR 2271 was still targeting the now-merged branch `fix/email-skip-otp`
   (PR #2257, squash-merged into main as `e418f1a1d`). Retargeted PR 2271's base to `main` via
   `gh api -X PATCH repos/motioneso/moss/pulls/2271 -f base=main` (plain `gh pr edit --base main`
   fails here with a GraphQL project-card error — known trap, use the REST PATCH instead).
   Now shows `mergeable: true` against main.
3. **Release note section** — already filled in properly in the PR body (Category: Fixed, plain
   English title and description). Nothing to fix there.
4. **App map declarations** — already correct. `packages/email/src/manifest.ts` on this branch
   adds two `features` entries (`email.skip-sign-in-code-emails`, `email.flag-only-real-obligations`)
   describing the new behavior in plain language, and updates the `email.capture-tasks` permission
   description. Ran `pnpm -s build:app-map` — no diff produced, so the committed declarations are
   already true. Nothing to fix there either.
5. **Own dev instance is running**, separate from the shared one at 192.168.50.36 (which is a
   different session's checkout on :3000/:5173 — do not touch it):
   - API on port **3010**. Started with:
     `PORT=3010 JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:3010,http://localhost:5183,http://192.168.50.36:5183" BETTER_AUTH_SECRET="dev-2271-live-walk-secret" pnpm dev:api`
     Root process id **2389134** (this is the exact id to kill at cleanup — do not pkill by name,
     other sessions run the same command).
   - Web on port **5183**, run directly with `npx vite --host 0.0.0.0 --port 5183` (NOT via
     `pnpm dev -- --port 5183` — that double-dash form gets swallowed and vite silently falls back
     to :5174; confirmed the failure and killed it before switching to the direct vite command).
     Proxy target set via `JARVIS_API_PROXY_TARGET=http://localhost:3010`.
     Root process id **2416525** — the exact id to kill at cleanup.
   - No new migrations in this PR, so it is safe that both instances point at the same dev
     Postgres (`localhost:55433`, db `jarv1s`) as the shared instance.
   - Login confirmed working through the real UI at `http://localhost:5183`, using the usual
     test account credentials (see memory, not repeated here since this file is checked into a
     public repository).
   - Confirmed through Settings, Connected accounts (`/settings?section=connected`): a **live
     Google account is already connected** with email access, status "Live connection / Syncing".
     This is the existing test mailbox the brief refers to — no need to connect a new one.
   - Checked `/today` and `/briefings` — at the time I looked, Today showed "Nothing pressing right
     now" and the morning briefing had not run yet, so flagged items were not visible there.

## What's left — the actual live-walk evidence
The part not yet done is proving, through a real screen, that ordinary bulk mail and sign-in
notices are no longer flagged while a genuine task-shaped message still is.

Key finding from reading the code (`packages/email/src/tools.ts`): the flagged/triaged view of
email is exposed as an assistant tool called **`email.listVisibleMessages`** (see
`packages/email/src/tools.ts` around line 197), returning each message's `actionability` category
(`needs_reply`, `needs_action`, `time_sensitive_info`, `waiting_on_someone`, `fyi`, `noise`,
`unknown`), `reason`, and any `suggestedTasks`. This is almost certainly the real screen to use:
**open the chat in the running web app and ask the assistant something like "what in my email
needs my attention" or "show me email that needs a reply or action"** — that will invoke the real
tool end to end through the real UI, and its answer will show category counts and specific
messages by sender/subject. This is more reliable than the Today/briefing screens, which depend on
a briefing having run.

Plan for the successor:
1. Open the chat UI at `http://localhost:5183` (already logged in from a fresh Playwright session —
   redo the login, it's quick, see the working script below) and ask it to list email needing
   action/reply, BEFORE re-judging. Screenshot and copy the exact text of the answer — this is the
   "before" state, reflecting whatever triage ran under old code.
2. Find the user's id for the re-judge command: `ben@ben.com`'s user id (a `select id from
   app.users where email = 'ben@ben.com'` via `docker exec jarv1s-postgres psql -U postgres` is
   fine for finding the id — that is not the live-proof itself, just a lookup).
3. Run the re-judge script AGAINST THIS BRANCH'S API (port 3010), from the repo root:
   `pnpm email:rejudge <userId> --days 14`
   This empties stored triage on recent messages and queues a re-sync, which runs them back
   through the NEW rules in this PR.
4. Wait for the sync job to finish (poll, don't guess — check the connected-accounts screen status
   or a suitable status endpoint; do not just sleep a fixed time).
5. Ask the assistant the same question again through the same chat UI. Screenshot and quote the
   exact after text. Identify:
   - At least one message that was flagged before and is now correctly NOT flagged (ideally a
     sign-in/security notice or something with an unsubscribe link — bulk mail).
   - At least one message that is STILL flagged both before and after (a genuine task — a bill,
     appointment, etc.) — proving the fix didn't just suppress everything.
   - Counts before and after if the assistant's answer or the tool naturally gives them.
6. Post a comment on PR 2271 (`gh pr comment 2271 --body-file <file>` or `gh api
   repos/motioneso/moss/issues/2271/comments -f body=...`) that plainly says a script drove the
   browser (be honest — Playwright, not a human), and quotes the specific before/after text seen.
   No assertions without quotes — that gets rejected (per the brief, already happened once today on
   another PR).
7. Take the PR out of draft: `gh api -X PATCH repos/motioneso/moss/pulls/2271 -f draft=false`
   (use the REST PATCH form, not `gh pr ready`/`gh pr edit`, to avoid the same GraphQL project-card
   error hit earlier).
8. Message the coordinator in pane `w1:pQJ` that evidence is posted and the PR is out of draft.
   Do NOT merge it.

## Cleanup — do this before finishing, whichever session finishes
Kill by the exact recorded process ids, never by name pattern (another lane's identical dev:api
process is running on :3000 from a different checkout — do not touch it):
- API root: **2389134** (and its children will die with it — this is a `pnpm dev:api` wrapper
  around `tsx watch`; kill the group, e.g. `kill -- -$(ps -o pgid= -p 2389134 | tr -d ' ')` or
  just `kill 2389134` then check nothing of mine is still listening on :3010).
- Web root: **2416525** (same approach, then check :5183 is free).
- Confirm afterward: `ss -ltnp | grep -E ':3010|:5183'` should return nothing.
- Check `ps aux` for any other process whose cwd is inside this worktree
  (`/home/ben/Jarv1s/.claude/worktrees/email-2271-live`) that isn't one of the above, and kill by
  exact id if found.
- If the re-judge step created/reset rows in `app.email_messages` for the test mailbox, that's
  expected and fine (it's Ben's own real test mailbox being re-triaged under the new rules, not
  seeded rows) — nothing to delete there.
- Two scratch files exist in the worktree root, not part of the PR: `scratch-live-walk-2271.mjs`
  (a throwaway Playwright script) and this handoff doc under `docs/superpowers/handoffs/`. Delete
  the scratch `.mjs` file before finishing — it must not end up in the PR diff. The handoff doc
  should be committed (repo convention: plan/handoff docs are always committed) but is not part of
  the PR's own diff review — check `git status` before any commit and only stage what belongs.

## Working Playwright login snippet (already proven to work in this session)
```js
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:5183/");
await page.getByLabel(/email/i).fill("ben@ben.com");
await page.getByLabel(/password/i).fill("<the usual test account password, see memory>");
await page.locator("form").getByRole("button", { name: /sign in/i }).click();
await page.waitForSelector('nav', { timeout: 20000 });
```
Chromium is already installed for Playwright in this worktree (`npx playwright install chromium`
already run — no system deps available via sudo, but the plain chromium binary installed fine and
launches headless without `--with-deps`).

## Standing rules (repeat to yourself, and to anyone you spawn)
- Plain English in every message a human reads — no jargon, no invented shorthand, at most one
  piece of code formatting per sentence, plain keyboard punctuation.
- Never pipe a gate command. This task hasn't needed `pnpm verify:foundation` — the PR's own gates
  are already green from prior rounds of review; no need to rerun them unless something changed.
- Waits are event driven — poll a real health/status signal, never a fixed sleep for something that
  can be checked.
- Do not touch `docs/coordination`. Do not run a repository-wide format command. Do not use a broad
  `git add`. Do not open a second pull request.
- If your own context meter warns at seventy percent, this was already your one relay — per the
  standing rule, do not relay again. Finish the slice as-is, or report to the coordinator that it
  needs re-slicing.
