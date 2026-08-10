# w5d-chat-surface relay #10

Worktree: `~/Jarv1s/.claude/worktrees/w5d-chat-surface`, branch `w5d-chat-surface`, PR #1482
(#1255 + #1451). Re-resolve Coordinator fresh via `herdr agent list` / `herdr pane list` — do not
trust any pane id baked into an older doc. Full state: agentmemory `project: jarvis`, type `bug`,
search "app-persona-boot-gate-test" (id `mem_msmz9ijr_94dbe93c50f1`) — **read that before redoing
anything.**

## Status

Fix is done, committed, and pushed. **Only the live-path proof (task #12) and Coordinator report
(#13) remain.**

- Fix: `apps/web/src/app.tsx` — removed the unconditional `personaQuery.isLoading` boot gate.
  Commit `65e87fe6d66c1eb78dc5e1d9ff5e56df15a021fe`, already pushed. Automatic CI triggered on that
  head — do NOT manually rerun it or change any timeout. A background Monitor (task `blwugav00` in
  the session that pushed it) was watching `gh pr checks 1482`; if that session is gone, just check
  `gh pr checks 1482` fresh yourself (one-shot check, not a poll loop).
- New regression test `tests/unit/app-persona-boot-gate.test.tsx`, proven red-before/green-after.
  Focused unit tests + root/web typecheck + format + lint all clean before commit.

## Next: finish the live UI proof

A dev instance is already up from this worktree/branch (head `65e87fe6d`): API `:3099`, web
`:5199`. Env at `<scratchpad>/dev-env.sh`. Don't touch pid ~920662 (unrelated `tsx watch`, port
3098, appears dead — not mine, another session's).

`<scratchpad>/live-proof.mjs` is a Playwright script that signs in as `ben@ben.com` /
`jarvistest123!`, throttles the network, and asserts the shell renders without getting stuck on
"Loading Moss". It failed 3x with `ERR_MODULE_NOT_FOUND '@playwright/test'` — needs to run with
**cwd inside the worktree** so Node's resolver finds `node_modules`. Run as one command, e.g.:

```
cd /home/ben/Jarv1s/.claude/worktrees/w5d-chat-surface && node <scratchpad>/live-proof.mjs
```

Verify the `cd` actually landed (`pwd`) before assuming it's fixed — that's exactly what silently
failed 3x before. Once it runs, the JSON output + screenshot (`live-proof-shell.png`) is the
live-path proof artifact — post both when reporting.

## Constraints (still binding)

No manual CI rerun, no CI timeout change, do not bundle #1534, no merge under any circumstances.

## Protocol reminders

Shared checkout — `shared-checkout` skill before any commit (explicit paths only). Blocked on Ben →
`AWAITING-BEN.md` entry AND `needs-ben`, never idle silently.
