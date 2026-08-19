# Continuation — #1560 assistant-name loading flash

Relay checkpoint (context budget), not a real handoff boundary. Same worktree/branch, same task.
Do not re-read the whole prior transcript — this doc plus the plan doc is the full state.

## What's done

- Plan approved-pending: `docs/superpowers/plans/2026-08-10-1560-assistant-name-flash.md`
  (committed at `a5fccdb41`). Read it in full — it has the seams, the exact two-line diff, the two
  test cases with why-they-fail-today, and the verification commands.
- Plan pointer sent to Coordinator (agent name `coord-relay`, session `019fef6b-...`) via
  `herdr agent prompt`. **Not yet confirmed approved as of this writing** — check for a reply
  before editing code. Re-resolve the Coordinator pane fresh via `herdr agent list` /
  `herdr pane list` (don't trust a stale pane_id) and read its output for a response addressed to
  `issue-1560-name-flash` (this agent's registered name).
- No code or test edits yet. Working tree is clean except the committed plan doc.

## Next steps, in order

1. **Wait for / check Coordinator approval** on the plan pointer message already sent. If no
   response yet, it's fine to wait — do not proceed to code edits without approval, and do not
   poll aggressively (check once, and if still pending, that's an acceptable place to pause and
   re-check shortly).
2. **Test-first:** add the two `it` blocks described in the plan's "Test" section to
   `tests/unit/today-evening-mode.test.tsx` (inside the existing `describe("TodayPage evening
   mode", ...)` block). Run `pnpm vitest run tests/unit/today-evening-mode.test.tsx` and confirm
   test 1 ("keeps the prep-card CTA neutral...") **fails** against current code (red).
3. **Apply the fix:** the two-line diff in `apps/web/src/today/evening-mode.tsx` from the plan's
   "Decision" section (`useAssistantName("")` + ternary on the button copy). Re-run the same
   vitest command, confirm both new tests pass (green), unpiped with `echo "EXIT=$?"`.
4. **Verify:** `pnpm format:check && pnpm lint && pnpm typecheck`, unpiped, `EXIT=0` expected.
5. **Live-path proof:** on a real dev instance — sign in, set a custom assistant name in Settings →
   AI persona, reach `/today` in evening mode, confirm no "Chat with Moss" flash and the button
   settles on "Chat with `<name>`". Follow this repo's live-path-gate convention (no screenshot
   needs to enter coordinator context — describe the observation in words).
6. **`coordinated-wrap-up`:** clean tree (respect `shared-checkout` skill — explicit paths only,
   verify `git show --name-only HEAD` after any commit), own gate per that skill's DB-isolation
   recipe, pre-push trio (`format:check && lint && typecheck`), `git fetch origin main && git
   rebase origin/main`, push, open a **draft PR** (do not merge), post live-path proof via
   `gh pr comment`, report the PR + evidence back to Coordinator.

## Constraints (unchanged)

- No new dependency/abstraction. Only files touched: `apps/web/src/today/evening-mode.tsx` and
  `tests/unit/today-evening-mode.test.tsx`.
- Never touch `docs/coordination/`, project fields, milestones, or merge state.
- Independent of #1557/#1533/#1564/#1121 — no need to coordinate with those lanes.
- Never end turn mid-procedure per the original boot brief
  (`/tmp/boot-1560-assistant-name-flash.txt`).
- If this relays again before the PR is open, repeat this same pattern: commit any new work by
  explicit path, update this doc in place, re-send a fresh continuation.

## Reference

- Issue: #1560, GitHub repo `motioneso/moss`.
- Original boot brief: `/tmp/boot-1560-assistant-name-flash.txt`.
- Handoff doc (scope/exit-criteria/collision-notes): `docs/superpowers/handoffs/2026-08-10-1560-assistant-name-flash.md`.
- This agent's registered herdr name: `issue-1560-name-flash`.
- Coordinator's registered herdr name: `coord-relay` (session `019fef6b-8f40-7453-a6f9-4c3e245dce52`).
