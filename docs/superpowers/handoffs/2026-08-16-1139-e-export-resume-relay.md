# Relay — 1139-E export resume

**Issue:** Part of #1522. **Branch/worktree:** `1139-e-export-resume` (this worktree, unchanged).
**Coordinator:** agent name `coordinator-take25` (session `11cf8264-55a8-4fa4-b32b-c8d086469f74`),
label `Coordinator` — re-resolve via `herdr pane list`/`herdr agent list`, never trust a cached
pane number.
**Plan (approved by coordinator, committed):** `docs/superpowers/plans/2026-08-16-1139-e-export-resume.md`
at commit `163405eb6`. Read it in full — it's short and has every decision (storage key, function
signatures, test case list, verification commands).

## Status

Plan approved, committed. **No test or production code written yet — start TDD from scratch,
RED first.** `pnpm install` already done in this worktree — skip it.

## Confirmed design fact (don't re-derive)

`apps/web/src/settings/settings-page.tsx:346` — `const Pane = activeSection.Pane;` renders
`<Pane />` by component-identity swap per active section. Clicking a different Settings nav
category and back **fully unmounts/remounts** `DataExport` (not a display:none toggle) — safe to
use for the plan's "remount" test steps via:
```ts
await nav.getByRole("button", { name: "Modules" }).click();
await nav.getByRole("button", { name: "Account & preferences" }).click();
```

## Next concrete step

1. Write the single new Playwright test in `tests/e2e/settings-shell.spec.ts` per the plan's
   "Test case" section (name must match `--grep "export.*remount"`). Route-mock
   `**/api/me/export` (POST) and `**/api/me/export/status/job-1` with a mutable status variable;
   track POST count via the route handler, not `page.on("request")`. Use `page.evaluate` to
   read/write `sessionStorage` directly for the storage-key assertions (key:
   `moss.settings.export-job-id`, decided in the plan).
2. Run focused command from the plan, confirm it **fails** for the expected reason (remount loses
   `jobId`) — this is the RED step, mandatory per `superpowers:test-driven-development`.
3. Implement the plan's storage helpers + `DataExport` changes (GREEN), re-run until pass.
4. Pre-push trio (`format:check && lint && typecheck`) + rebase, then `coordinated-wrap-up`
   (own gate via `verify-gate` skill, PR, live-path proof).

## Reminders from the run

- `git add` by explicit path only — no `-A`, no bare commit (shared checkout).
- Never touch `docs/coordination/` — coordinator-only.
- Relay trigger is the meter's 70% warning, same threshold for you too — don't invent a higher
  personal bar. If it fires before you've committed green work, commit whatever's green and relay
  anyway, noting it plainly.
