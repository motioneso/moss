# Stale PR fixer lane — checkpoint (pane w1:pJ3)

Brief: ~/.coord-briefs/boot-stale-2220-2219.txt (this session only owns PR 2220 and PR 2219).
Report each green PR to coordinator with: herdr pane run w1:pD6 "stale PR <n>: green at <sha>, auto-merge <on|off> [pane w1:pJ3]"

## PR 2219 (fix/ai-tier-pick-newest-release) — worktree ~/Jarv1s/.claude/worktrees/ai-newest-release

STATUS: fully green on GitHub as of commit bbee50e77. All required jobs passed (static checks,
both integration shards, web/browser tests, both compose smokes, CI gate).
NOT YET DONE: turn on auto-merge (`gh pr merge 2219 --squash --auto`) and report to the coordinator.
Do this first when resuming.

History: fixed a real bug in packages/ai/src/repository.ts (selectAutomaticModelForCapability
was missing .clearOrderBy() before applying the newest-release sort, so the base
newest-created-first sort silently won) and a stale hardcoded migration list in
tests/integration/foundation-schema-catalog.test.ts (added the 0214 entry). Confirmed green
through the verify-gate skill before committing (7166f65d1). Later had to merge origin/main again
(main had moved 5 commits ahead and added its own migration 0216_scratchpads.sql) — merged clean
except one expected conflict in the same migration-list test file, resolved by keeping both the
0214 and 0216 entries in order (commit bbee50e77). Pushed and confirmed green.

## PR 2220 (fix/settings-setup-link) — worktree ~/Jarv1s/.claude/worktrees/settings-setup-link (session cwd)

STATUS: just pushed a new fix commit (1c5dfe841). CI has not been confirmed against this commit
yet — this is the next thing to check when resuming (gh pr checks 2220, or gh pr view 2220
--json statusCheckRollup). Do not re-diagnose past failures below if this run is green.

History:

1. Own test rewrite (a plain stand-in button replacing the removed Chat settings screen) - done,
   clean, commits 95eff9b97 and 5b8682d04 (a prettier fix).
2. This branch shares history with PR 2219 (2219's commits are ancestors), so it inherited and
   then received the fix for 2219's real bug via a branch merge (commit 0d155455d).
3. Main moved ahead again (5 commits, including a new module called scratchpad which added
   migration 0216). Merged origin/main, same one conflict as 2219 in the migration-list test,
   resolved the same way (commit 60a377d07).
4. That merge exposed a NEW real failure, not seen before: a PR already on main (#2254, "search
   box now covers module settings") added an import of a Vite virtual module
   (virtual:moss-module-settings) to settings-page.tsx. Our test imports settings-page.tsx (via
   SettingsPage) but did not mock that virtual module, so Vite's import-analysis plugin failed
   to resolve it outright ("Failed to resolve import ... Does the file exist?").
   - First fix attempt: added the same vi.mock("virtual:moss-module-settings", ...) stub that
     other test files in this repo already use for the same reason. This alone did NOT fix it.
   - Root cause found by isolating a minimal repro file: this test has a per-file
     "// @vitest-environment jsdom" pragma at the top. Under Vitest 4, running a file's
     transform under a per-file jsdom environment pragma causes the vi.mock registration for an
     otherwise-unresolvable "virtual:" module id to not take effect — Vite's resolver fails
     before the mock ever intercepts. Removing the pragma fixed it immediately (confirmed with a
     minimal 12-line repro file, deleted after confirming). This test uses react-test-renderer,
     which does not need a real DOM, so dropping the pragma does not weaken what the test proves.
   - Fix committed and pushed as 1c5dfe841: removed the "@vitest-environment jsdom" line, kept
     the vi.mock("virtual:moss-module-settings", ...) addition (needed regardless of the pragma,
     since the import is real and unmocked otherwise).
   - Locally confirmed green: the test file (2 tests pass), tsc --noEmit, eslint, and
     prettier --check all clean.

NEXT STEPS for PR 2220: watch gh pr checks 2220 to completion (background, do not pipe, do not
poll by hand). If green: turn on auto-merge and report. If it fails again, read the real new
error before touching anything - the jsdom/virtual-module issue above is fully diagnosed and
should not recur unless a different file trips the same pattern.

## Standing rules (apply to every PR) — unchanged from the original brief

- Plain English only in any message to a human, ASCII punctuation, at most one backtick per
  sentence, no jargon. This applies to every agent, not just this session.
- Never name the dependency folder or build output folder in any command or message.
- Never pipe a gate/verification command - always redirect to a file and check the exit code
  separately.
- Database tests only via the verify-gate skill; never run the full local gate or any DB test
  directly.
- Waits are event-driven (background watch or Monitor), never polled by hand.
- Never git add -A, never bare git commit, never checkout/stash/reset in the shared checkout
  ~/Jarv1s itself (each PR here uses its own worktree, which is fine).
- Port 1533 is PROD, never touch it.
- Sign every report to the coordinator with the pane id in brackets, e.g. "[pane w1:pJ3]".
  (Note: this session has not yet resolved what its own pane id actually is - check herdr
  tooling or environment for it before sending the first report.)
- When a PR's checks are fully green: report to coordinator via
  `herdr pane run w1:pD6 "stale PR <n>: green at <sha>, auto-merge <on|off> [pane w1:pJ3]"`,
  and if auto-merge isn't already on, turn it on with `gh pr merge <PR> --squash --auto`.
- If a check fails twice on the same PR for the same reason, stop that PR and report it blocked
  with the error text, plain English.
- When both PRs are handled: send one final one-line summary to the coordinator, then remove
  both worktrees with `git worktree remove`.
