# Relay: #1883 vault-search MCP error detail

Branch/worktree: `build/1883-vault-mcp-errors`, this worktree (unchanged — stay here).
Coordinator: agent name `coordinator` (re-resolve via `herdr agent list` before messaging — do not
trust a pane number from this doc).

## State

- Spec: `docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md` (approved, verified
  current against this branch).
- Plan (committed, commit `e8dd27105`): `docs/superpowers/plans/2026-08-23-1883-vault-mcp-errors.md`
  — read it in full, it's short and has everything (seams with file:line, design, test cases,
  verification commands, kill gate).
- **Plan sent to coordinator for approval, NOT yet confirmed approved.** Message was delivered and
  queued (coordinator was busy). Check for a reply before writing any code — if none arrived yet,
  ping the coordinator again or wait; do not start Phase 2 (build) without approval.
- No code changes made yet. Nothing else is in flight on this branch from me.

## Next steps

1. Confirm plan approval from coordinator (check messages / `herdr pane read`).
2. Follow `coordinated-build` Phase 2: TDD the plan task-by-task, commit green.
3. Kill-gate check first: verify the real error shape `notes.search`'s dependency actually throws
   (read `@huggingface/transformers` fetch/model-load error shape, or force a failure locally) —
   the plan's classifier assumes `.code`/`.cause.code`/`.name`/`.statusCode` are present; if the
   real shape has none of those, escalate to coordinator with the actual shape before shipping a
   dead classifier.
4. Write `tests/unit/mcp-gateway-dependency-errors.test.ts` (see plan for exact cases), watch it
   fail, then implement `packages/ai/src/gateway/dependency-failure.ts` +
   `packages/ai/src/gateway/gateway.ts` runHandler catch change, watch it pass.
5. Re-run `tests/unit/mcp-gateway-recovery.test.ts` — must stay green untouched.
6. Full gate via `verify-gate` skill, then `coordinated-wrap-up`: PR, live-path evidence.
7. Live diagnosis: after fix ships to dev, call `/api/mcp` `notes.search` on the real dev instance
   and read the surfaced cause to identify the current outage — report the finding, do not fix an
   unrelated dependency without that evidence.

## Reminders from CLAUDE.md / boot brief

- Security tier: fixed safe cause vocabulary only, never derive model-visible detail from raw
  exception messages/bodies/vault content/query text/credentials/stack traces. Preserve original
  failure server-side for logs only.
- Own MCP transport + gateway path + focused tests only. Don't touch unrelated areas.
- Do not merge, do not touch project/coordination files. Don't revert others' edits — rebase and
  accommodate.
- Sign every coordinator message with your pane id. Resolve coordinator fresh each time.
- Plain English in all chat/status/handoff text — no jargon, no coined shorthand (see global
  CLAUDE.md).
- Shared checkout: never `git add -A`/bare commit; commit by explicit path; diff-check any
  co-edited file before committing.
