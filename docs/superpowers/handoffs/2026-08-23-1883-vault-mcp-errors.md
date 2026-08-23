# Build Handoff — #1883 vault MCP errors

**Spec (approved):** `~/Jarv1s/docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md`
**GitHub issue:** #1883
**Risk tier:** security — adversarial Opus QA and Ben merge sign-off required
**Worktree:** `~/Jarv1s/.claude/worktrees/1883-vault-mcp-errors`
**Branch:** `build/1883-vault-mcp-errors` from green `origin/main` `4ee77dbd2`
**Coordinator:** registered name `coordinator`, pane label `Coordinator`, immutable Codex session
`01a02f0e-05d0-7e61-9a20-c87b7a7f9305`

## Start and exit

Install dependencies, invoke `coordinated-build` and `diagnosing-bugs`, send a plan to the
coordinator before code, then use TDD and `coordinated-wrap-up`. Open a non-draft PR with exact-head
green evidence. Never merge or touch the board or `docs/coordination/`.

## Collision and security boundary

No source or migration collision with this run. Begin with a deterministic failing MCP-boundary
reproduction. Fixed safe cause classifications are allowed; exception-message-derived output is
not. Never expose secrets, vault/query content, embedding input, raw bodies, database values, or
stack traces. Preserve the original server-side cause for logging.

