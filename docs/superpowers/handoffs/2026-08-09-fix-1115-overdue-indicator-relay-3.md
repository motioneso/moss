# #1115 relay 3 — QA RED: attach real screenshots, not a narrative comment

PR **#1478** (https://github.com/motioneso/moss/pull/1478). Build is done, gate was green as of
relay-1/2. Relay-2 root-caused and fixed the live-path Playwright script (see below) and got real
passing screenshots — but posted a **narrative-only** PR comment
(https://github.com/motioneso/moss/pull/1478#issuecomment-5230659226) describing the screenshots
by filename instead of attaching them. QA reviewed and returned **RED**: the repo's Live-Path Gate
(`docs/DEVELOPMENT_STANDARDS.md`) requires actual attached images, not a claim. That is the only
remaining work.

## Your two jobs, in order

### 1. Confirm CI is green

At relay-2 handoff time, `gh pr checks 1478` showed `Verify foundation and app` still **pending**
(everything else — Prod compose deployment smoke, Compose deployment smoke, Verify docs, Detect
change scope — had already passed). Check it now:
```bash
gh pr checks 1478
```
If still pending, don't busy-poll in-context — background it (`run_in_background` with an `until`
loop, or the Monitor tool) and do the screenshot work below while it finishes. If it comes back
red, that's a new problem — don't paper over it, report it.

### 2. Re-run the live-path proof and attach real images to a NEW PR comment

**The Playwright script is already fixed and confirmed working** —
`.scratch-livepath/live-path-1115.mjs` (if the directory is gone, it was `rm -rf`'d during relay-2
teardown; recreate it from this doc's contents below, or check `git show
87c4d6e28:.scratch-livepath/live-path-1115.mjs` — no, that path was never committed, it's
untracked scratch. Recreate from scratch if needed using the "Script contents" section below).

**Root cause of the original sign-in blocker (already solved, don't re-debug):** the script used
`waitUntil: "networkidle"` in several places. That never resolves because the app holds an open
SSE connection (`/api/chat/stream`) plus repeated Agentation polling to `localhost:4747` (which
also 404s/refuses in dev — harmless, ignore those). Sign-in itself was always working; the wait
condition was wrong. Fix: use explicit response/selector waits instead of `networkidle` anywhere
in a Playwright script against this app.

**Also already solved (don't re-discover):**
- The Details-dialog title input shares `aria-label="Task title"` with the quick-add bar input —
  after opening the dialog you must scope with `page.getByRole("dialog").getByLabel("Task title")`
  or you'll fill the wrong (or an ambiguous) field and the dialog submits a blank-titled task.
- The dialog's own "Add task" button collides by name with the quick-add bar's — scope it with
  `page.getByRole("dialog").getByRole("button", { name: "Add task" })`.
- Task rows are `.tk-task` divs, not `<li>`.
- The done-state checkbox is visually hidden under a custom `.jds-check__box` — click that box
  locator, not the native `input[type=checkbox]` (it's out of viewport / not "visible" to
  Playwright's actionability check).
- After marking a task done it can drop out of the "Open" filter tab — click the "All" tab
  (`page.getByRole("button", { name: "All", exact: true })`) before screenshotting the done state.

**Respin the dev instance** (previous instance was torn down at end of relay-2; PIDs 405565/405285
are dead, do not try to reuse them):
```bash
cd /home/ben/Jarv1s/.claude/worktrees/fix-1115-overdue-indicator
source /tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-fix-1115-overdue-indicator/39efc7c2-f3bc-4334-b0e3-55896a542a5c/scratchpad/devinstance/dev-env.sh
# (PORT=3299, JARVIS_API_PROXY_TARGET, JARVIS_AUTH_TRUSTED_ORIGINS incl. :5299, BETTER_AUTH_SECRET
#  are all set by that file — do not invent new values, reuse them so trusted-origins still match)
nohup pnpm --filter @moss/api dev > /tmp/claude-1000/.../scratchpad/devinstance/api2.log 2>&1 &
echo "API PID: $!"
nohup pnpm --filter @moss/web dev -- --port 5299 --host 0.0.0.0 > /tmp/claude-1000/.../scratchpad/devinstance/web2.log 2>&1 &
echo "WEB WRAPPER PID: $!"   # NOTE relay-2 found the pnpm wrapper PID is NOT the real vite listener —
                              # grep the log for "Local:" then `ps` to find the real node/vite pid before
                              # recording it as your kill target, same trap as before.
```
Wait for `curl http://localhost:3299/health` → `{"ok":true}` and the web log to show `VITE ... ready`
before running the script. Record BOTH PIDs precisely (API pid, real web/vite pid — not the pnpm
wrapper) for teardown later.

Run: `cd /home/ben/Jarv1s/.claude/worktrees/fix-1115-overdue-indicator && node .scratch-livepath/live-path-1115.mjs`
Expect output ending in `NON_DONE_OVERDUE_COUNT=1`, `DONE_OVERDUE_COUNT=1`, `MARKER=E2E-1115-<ts>`.
Screenshots land at `.../scratchpad/devinstance/1115-non-done-overdue.png` and
`1115-done-overdue.png`.

**Attaching the images for real — gh CLI has no native image-attach flag for PR comments, and
GitHub's inline-upload endpoint needs a browser session, not a token. Use a gist to host them:**
```bash
gh gist create /tmp/.../scratchpad/devinstance/1115-non-done-overdue.png \
                /tmp/.../scratchpad/devinstance/1115-done-overdue.png \
                --public -d "PR #1478 live-path proof screenshots (#1115)"
# → prints a gist URL like https://gist.github.com/motioneso/<gistid>
```
Then get the raw URLs (`https://gist.githubusercontent.com/motioneso/<gistid>/raw/<filename>`) —
`gh gist view <gistid> --raw` or `gh api gists/<gistid>` to list exact filenames — and embed them
as real markdown images in a **new** `gh pr comment 1478 --body "..."` (leave the old narrative
comment as-is, just add a new one with the actual images plus a short note that it supersedes the
narrative-only comment per QA RED). `gh auth status` is logged in as account `motioneso` — gists
will be public under that account, which is fine (these are just dev-UI screenshots, no secrets).

## After the comment lands with real images

1. Re-check `gh pr checks 1478` is fully green (step 1 above) before reporting.
2. Delete the test task from the dev DB (same procedure as before):
   ```bash
   docker exec jarv1s-postgres psql -U postgres -d jarv1s -c \
     "delete from app.tasks where title ilike '%E2E-1115-%'; select count(*) from app.tasks where title ilike '%E2E-1115-%';"
   ```
   Confirm the count is 0 after.
3. Kill the dev instance by **explicit PID only** (the ones you recorded above — never by name
   pattern, never reuse 405565/405285, those are already dead from relay-2).
4. `rm -rf .scratch-livepath` (untracked scratch).
5. Report to the **Coordinator** — re-resolve the Herdr pane fresh via `herdr pane list`, label
   "Coordinator", confirm exactly one match. **Do not reuse any pane id from this doc or from any
   prior relay's output — pane numbers reflow constantly.** Terse result-first report per
   `coordinated-wrap-up` step 4 template: PR link, new comment URL with real attached images,
   VF_EXIT status (confirm the CI check, don't just assume relay-1/2's local gate run still
   applies), live-path status (now actually MET, with the real attachment), branch state, deferred:
   none, teardown: instance stopped (state PIDs), N seed rows deleted, worktree reapable. Then
   **stop** — merge/board is the coordinator's job.

## Script contents (recreate `.scratch-livepath/live-path-1115.mjs` if it's gone)

The working, debugged version — copy this verbatim:

```js
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5299";
const OUT_DIR = "/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-fix-1115-overdue-indicator/39efc7c2-f3bc-4334-b0e3-55896a542a5c/scratchpad/devinstance";

function pastDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(`${BASE}/`, { waitUntil: "load" });
  console.log("LANDING_URL=" + page.url());

  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.fill("ben@ben.com");
  await page.locator('input[type="password"], input[name="password"]').first().fill("jarvistest123!");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/email")),
    page.locator('button[type="submit"]').first().click(),
  ]);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in") && url.pathname !== "/", { timeout: 10000 });
  console.log("POST_SIGNIN_URL=" + page.url());

  await page.goto(`${BASE}/tasks`, { waitUntil: "load" });
  await page.getByLabel("Task title").waitFor({ state: "visible", timeout: 10000 });
  console.log("TASKS_URL=" + page.url());

  const marker = `E2E-1115-${Date.now()}`;
  const title = `${marker} overdue proof task`;

  await page.getByRole("button", { name: "Details" }).click();
  await page.waitForTimeout(500);

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Task title").fill(title);
  await dialog.locator("#task-due-input").fill(pastDate(3));
  await dialog.getByRole("button", { name: "Add task" }).click();
  await page.waitForTimeout(1500);
  await page.locator(".tk-task", { hasText: title }).first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(1000);

  const row = page.locator(".tk-task", { hasText: title }).first();
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: `${OUT_DIR}/1115-non-done-overdue.png` });
  const overdueCountNonDone = await row.getByText("Overdue", { exact: true }).count();
  console.log(`NON_DONE_OVERDUE_COUNT=${overdueCountNonDone}`);

  await row.locator(".jds-check__box").click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForTimeout(500);

  const doneRow = page.locator(".tk-task", { hasText: title }).first();
  await doneRow.scrollIntoViewIfNeeded();
  await doneRow.screenshot({ path: `${OUT_DIR}/1115-done-overdue.png` });
  const overdueCountDone = await doneRow.getByText("Overdue", { exact: true }).count();
  console.log(`DONE_OVERDUE_COUNT=${overdueCountDone}`);

  console.log(`MARKER=${marker}`);
  await browser.close();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## Not actionable

- `git remote` deprecation notice (`motioneso/Jarv1s` → `motioneso/moss`) — ignore, push/PR-create
  still works against the old remote URL.
