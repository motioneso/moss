# w5d-chat-surface relay #6 — 2026-08-09

**Continues:** relay5 doc (same file name pattern) — unchanged pointers to spec/plan Evidence
section still apply. Issues #1255, #1451. Worktree/branch: this worktree, `w5d-chat-surface`.
**PR:** https://github.com/motioneso/moss/pull/1482 — still OPEN, MERGEABLE (gate RED /
pre-existing-cause explanation already in PR body — don't redo that work).

**Coordinator:** re-resolve fresh via `herdr agent list` — do not trust this doc's value. Last
confirmed this relay: `relay6-coordinator`, session `9c7ffdf7-4ccc-4378-aa3e-4f2f6f43a171`, pane
`w1:p3R`.

## Live-path proof: CAPTURED AND VERIFIED — only posting + teardown remain

The proof is done and clean. What's left is mechanical: upload screenshots, post the PR comment,
tear down, report to coordinator. No more debugging needed.

**Proof script** (untracked, in-repo at `apps/web/persona-flash-proof.mjs` — never commit it) now
works reliably. Two real bugs were found and fixed in the script itself this relay (not app bugs):
1. `emailInput.count()` right after `domcontentloaded` is racy (returns 0 before hydration) —
   replaced with `Promise.race([emailInput.waitFor(...), chatButton.waitFor(...)])`.
2. The proof's loading-window check was blanket-scanning `document.body.innerText` for `/\bMoss\b/`
   — but "Moss" is also the unconditional product wordmark (`app-shell.tsx:316`
   `.brand-wordmark`, `auth-screen.tsx:46` `.eyebrow`), giving false positives unrelated to the
   assistant-persona-flash bug under test. Fixed to check ONLY the three
   `useAssistantName()`-fed surfaces via `document.querySelector` (chat button aria-label,
   `.chatd__name`, composer placeholder) — see current file for the fixed sampling loop.
3. Also had to add a "skip save if already dirty-false" guard in `setAssistantName()` since a
   prior run already persisted "Persimmon" for `ben@ben.com` on this throwaway DB.
4. A red herring: blocked the Agentation dev overlay (`page.route(/agentation/i|:4747\//, abort)`)
   suspecting it stole focus — turned out NOT to be the real cause (fix #1 above was), but it's
   harmless to leave blocked and reduces noise, so it's still in the script.

**Result (full log at** `<scratchpad>/proof-run6.log`, **screenshots at**
`<scratchpad>/shots/`, both are outside the worktree so untracked by git):
- Baseline after save: shell chat button `"Chat with Persimmon"`, drawer header `"Persimmon"`,
  composer placeholder `"Message Persimmon…"` — all correct.
- Throttled reload (3.5s artificial delay on `/api/me/persona`), sampled every 500ms for 3s:
  - t=500ms–2000ms: all three surfaces are `null` — nothing mounted yet. Screenshot
    (`02-loading-t1000ms.png`) shows a plain loader with text **"Loading Moss"** (the product
    name, expected/harmless — not a `useAssistantName()` surface) and nothing else.
  - t=2500ms–3000ms: chat button shows `"Chat with Persimmon"` — correct value, first paint.
  - `showsDefaultMoss` is `false` at **every single sample** — zero flash of the default name on
    any of the three surfaces, at any point.
  - After throttled reload completes: all three surfaces again correct (`Persimmon`).
- This directly confirms the `app.tsx:212` `personaQuery.isLoading` boot gate works exactly as
  intended: the whole app shell (and therefore every `useAssistantName()` consumer) is unmounted
  during the persona fetch, never rendered with a stale/default value.

## Next step for the agent picking this up

1. Re-resolve the coordinator's pane fresh (see above).
2. **Upload proof images and post the PR comment.** Precedent checked this relay: PR #1478 shows
   a plain-text "screenshots exist but weren't attached" comment got QA'd **RED** — attaching
   actual images is a hard requirement, not optional. Precedent pattern: `gh gist create` the PNGs
   (gh is already authenticated with `gist` scope — confirmed `gh auth status`), then embed via
   `![...](https://gist.githubusercontent.com/.../raw/.../file.png)` in the PR comment body,
   exactly like the second (GREEN) comment on #1478. Suggested minimal image set (don't need all
   11 in `<scratchpad>/shots/`): `01-baseline-after-save-drawer-open.png`,
   `02-loading-t1000ms.png` (shows the loader, proves nothing flashes), and
   `03-after-throttled-reload-drawer-open.png`. Command:
   `gh gist create <scratchpad>/shots/01-baseline-after-save-drawer-open.png <scratchpad>/shots/02-loading-t1000ms.png <scratchpad>/shots/03-after-throttled-reload-drawer-open.png --desc "w5d #1451 live-path proof"`
   — then `gh pr comment 1482 --body "..."` referencing the raw URLs it prints, describing the
   sample-by-sample result from `<scratchpad>/proof-run6.log` (all `showsDefaultMoss=false`,
   loader screenshot shows only "Loading Moss" text with no assistant-name surfaces mounted).
3. **Tear down.** Re-verify current PIDs first (`ss -ltnp | grep -E ':3098|:5198'` — may have
   changed from relay5's recorded 920789/948326 if restarted; last known API :3098, web :5198),
   kill them by exact PID, kill any leftover Chromium/Playwright processes (`pgrep -af chromium`,
   kill by exact PID only). Delete `apps/web/persona-flash-proof.mjs` (untracked scratch file,
   never commit). The `<scratchpad>/shots/*.png` and `.log` files are outside the repo, no
   cleanup needed there beyond your own session's scratchpad lifecycle.
4. **Report to coordinator** (re-resolve pane fresh, don't trust step 1's value if time has
   passed): PR link, verification summary (RED-gate/pre-existing-cause — already in PR body from
   relay4, just restate briefly), live-path proof PR comment link. Do **not** merge, close the
   issue, or move the board — that's the coordinator's job only.

## Reminders

- Relay trigger is the meter's 70% warning — don't invent a higher personal threshold.
- Never `git add -A`/bare-commit in this shared worktree; commit by explicit path (see
  `shared-checkout` skill) — only this doc should be committed this relay.
