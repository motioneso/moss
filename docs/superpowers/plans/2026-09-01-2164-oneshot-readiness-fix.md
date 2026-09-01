# Plan — PR #2164 one-shot readiness fix

**Grounding:** issue #2159, PR #2164, QA finding at 2026-09-01T19:02:34Z (blocking) and the
2026-09-01T20:32:14Z five-spec live proof (spec `1883-vault-search-dependency-failure.uat.spec.ts`
failed: safe-reply text never appeared within 60s).

## Seams check (file:line)

- `packages/chat/src/live/chat-session-manager.ts:185-198` — after `engine.launch()`, if a token
  was minted (`mcpConfig?.token`), `launchSession` unconditionally awaits
  `this.deps.waitForToolsListReady?.(mcpConfig.token)` (10s bound per #2159), and on `false` kills
  the engine, revokes the token, and throws `CliChatUnavailableError`.
- `packages/chat/src/live/claude-print-chat-engine.ts:57-63` — `ClaudePrintChatEngine.launch()`
  only records `opts` and computes the transcript path; it spawns no process. The CLI process (and
  its MCP client) is created only in `submit()` (`claude-print-chat-engine.ts:65-86`), per turn.
- `packages/chat/src/live/gemini-print-chat-engine.ts:70-82` — same shape: `launch()` writes
  settings/persona and returns; the process spawns in `submit()`
  (`gemini-print-chat-engine.ts:84-...`).
- `packages/chat/src/live/cli-chat-engine.ts:208-234` — the tmux-backed interactive engine spawns
  the mux pane and CLI process (which opens the MCP client) inside `launch()` itself — this is the
  only engine shape for which "wait for tools/list after launch" observes a real in-flight client.
- `packages/chat/src/live/engine-selection.ts:76-88` — `isBoundedFallbackEngine(provider,
executionMode)` is the existing, exported predicate for "one process per turn, no MCP client
  started during launch": true for `provider === "google"` or
  `(provider === "anthropic" && executionMode === "non_interactive")`.
- `packages/chat/src/live/chat-session-manager.ts:127-142` — `launchSession` already destructures
  `provider` and `executionMode` from `resolveActiveProvider` and passes both to
  `engineFactory`, so both are in scope at the readiness-wait call site with no new plumbing.

**Root cause:** for a bounded-fallback (print/one-shot) engine, `launch()` never starts an MCP
client, so `waitForToolsListReady` can never observe a `tools/list` at that point — it always
blocks the full 10s bound and then returns `false`, which now (post the #2164 cleanup-on-timeout
commit) kills the freshly-launched-but-never-submitted engine and revokes the token before the
first message is ever submitted. This matches the live-proof failure: `1883-vault-search-...`
routes through a bounded-fallback engine and its "safe reply" turn never lands within 60s because
`ensureSession` throws (or a slow-followed-by-retry burns the whole window) before `submit()` is
ever reached.

## Fix

`packages/chat/src/live/chat-session-manager.ts`:

- Import `isBoundedFallbackEngine` from `./engine-selection.js`.
- Guard the existing readiness-wait block (lines 185-198) with
  `mcpConfig?.token && !isBoundedFallbackEngine(provider, executionMode)`. Bounded-fallback
  engines keep getting `mintMcpToken` (still needed for the per-turn `submit()` MCP config) but
  skip the launch-time wait/kill/revoke entirely — they become ready as soon as `engine.launch()`
  returns, unchanged from pre-#2159 behavior for this engine shape.
- No signature changes; no new exported symbols; no changes to `waitForToolsListReady`,
  `mintMcpToken`, or `revokeMcpToken` themselves.

## Test

Add one case to `tests/unit/chat-session-manager-mcp-readiness.test.ts`:

- **Behavior:** `resolveActiveProvider` returns `{ provider: "google", model: "gemini" }` (a
  bounded-fallback pair per `isBoundedFallbackEngine`); `mintMcpToken` resolves a token;
  `waitForToolsListReady` is a `vi.fn()` that would hang forever if called (mirrors the manually-
  controlled-promise style already in this file, or a rejecting mock — either proves non-
  invocation). Assert `ensureSession` resolves and `waitForToolsListReady` was never called.
  **Why it would fail against the current code:** today the block runs unconditionally whenever a
  token exists, regardless of engine shape, so this case would hang/timeout against un-fixed code.

No other test files change. The three existing readiness tests in this file all use
`provider: "anthropic"` with no `executionMode` (interactive, not bounded-fallback), so
`isBoundedFallbackEngine` is `false` for all of them and their behavior is unchanged.

## Verification (run in order, never piped)

```bash
pnpm vitest run tests/unit/chat-session-manager-mcp-readiness.test.ts tests/unit/chat-session-manager.test.ts > /tmp/2164-focused.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Full gate via the `verify-gate` skill (never run `pnpm verify:foundation` directly — unscoped hits
the live dev database). Expected: `EXIT=0`.

## Exit criteria

- Focused unit files green.
- Full gate green via `verify-gate`.
- Existing #2159 interactive-engine behavior unchanged (same three tests, same assertions).
- Push to `fix/2159-sports-retry-card`; PR #2164 updated. Live-UI re-proof stays the coordinator's
  separately-authorized step, not part of this fix.

## Kill gate

If the focused tests or full gate turn up a second, unrelated defect (not explainable by this
guard), stop and escalate to the coordinator rather than expanding scope in this pass.
