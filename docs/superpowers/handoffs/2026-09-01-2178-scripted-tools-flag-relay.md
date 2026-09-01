# Relay — #2178 scripted tools flag

**Worktree/branch:** this worktree, `fix/2178-scripted-tools-flag` (already has 2 commits ahead of
`origin/main`, plus this session's `wip(2178): accept MCP trio + non-empty --tools...` commit).
**Handoff doc:** `docs/coordination/handoffs/2026-09-01-2178-scripted-tools-flag.md` (read-only,
never edit).
**Plan:** `docs/superpowers/plans/2026-09-01-2178-scripted-tools-flag.md`.
**Coordinator:** registered agent name `coordinator` (herdr). Confirm exactly one live agent holds
that name before messaging (`herdr agent list`).

## Approved, do not re-litigate

- Coordinator approved the plan and, after a clarifying round, approved the exact test approach:
  **do not** call the exported `buildLaunchCommand` in `packages/chat/src/live/cli-launch-commands.ts`
  — that builds the persistent/interactive engine's line, which never has `-p` or
  `--permission-mode dontAsk`, so it can never parse to `kind: "bounded"`.
  **Use `ClaudePrintChatEngine` from `packages/chat/src/live/claude-print-chat-engine.ts`** — its
  `submit()` is the actual producer of the shape this fixture parses (its own file header says so),
  and it now includes the MCP trio plus non-empty `--tools "Read,Glob,Grep"` since PR #2144.
- Scope is locked to the two fixture files only. No product-code edits. Every existing rejection
  case in `launch-args.test.ts` must stay green, untouched.
- No live-proof needed (fixture-only, not UI-facing).

## Done (this session)

- Source fix applied and committed to `tests/uat/fixtures/scripted-provider/launch-args.ts`:
  replaced the "trio and bare --tools are mutually exclusive" rule with one that accepts
  `hasMcpTrio && bareTools` non-empty, still rejects `hasMcpTrio && bareTools === ""`, and still
  rejects `!hasMcpTrio && bareTools !== ""`. See the commit diff for the exact change (small,
  self-contained — read it with `git show HEAD` before touching the file again, don't re-derive).
- **NOT yet done: the new contract test.** `launch-args.test.ts` still has only its original 8
  cases; nothing has been run yet (`pnpm vitest run tests/uat/fixtures/scripted-provider/launch-args.test.ts`
  has NOT been executed this session — do it, don't assume the source fix is correct until it's
  green).

## Next steps (in order)

1. **Write the contract test** in `tests/uat/fixtures/scripted-provider/launch-args.test.ts`,
   mirroring the established mock-spawn pattern in `tests/unit/claude-print-chat-engine.test.ts`
   (see especially the block around its "pre-approves Read/Glob/Grep" test, ~line 338-367, and the
   `fakeIo`/`fakeChild`/`spawnMock` helpers near the top of that file):
   - `vi.mock("node:child_process", ...)` with a hoisted `spawnMock`, a minimal `fakeChild()`, and a
     minimal `fakeIo()` (only `run`/`readFile`/`writeFile`/`sleep` are required by the `TmuxIo`
     interface in `packages/ai/src/adapters/tmux-bridge.ts`).
   - `new ClaudePrintChatEngine("user-1", io, { homeBase: "/home/test", sessionId: <a fixed UUID> })`,
     then `engine.launch({ neutralDir, personaPath, personaText: "persona", mcpToken: "jst_abc",
     mcpServerUrl: "http://127.0.0.1:3000/api/mcp" })`, then `engine.submit("hello")`.
   - Extract the real launch line from `spawnMock.mock.calls[0][1][1]` (bash -lc argument — same
     `launchLineAt` pattern as the unit test).
   - **Tokenize that shell line into an argv array before calling `parseClaudeLaunchArgs`** — do not
     hand-write an approximation. Write a small local tokenizer in the test file (test-only code,
     not a product change) that treats single-quoted and double-quoted spans as atomic tokens and
     splits on whitespace otherwise. Since you control every string passed into `launch()`/`submit()`
     (paths, session id), avoid embedding any apostrophes in those inputs so you don't need to handle
     the `'\''` bash-escape edge case — keep the tokenizer simple.
   - Assert `result.kind === "bounded"`, and that `result.mcp` is present (don't over-assert exact
     tool list contents — that's not this fixture's job).
2. Run the focused test: `pnpm vitest run tests/uat/fixtures/scripted-provider/launch-args.test.ts`
   — must be green, including all 8 pre-existing cases untouched.
3. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
4. Full gate via the **`verify-gate` skill** — never pipe it, never run `pnpm verify:foundation`
   directly.
5. `git add` only the two locked files (explicit paths, never `-A`/`.`), commit (a real commit,
   not amending the wip one — this repo's convention is new commits, not amends), push.
6. Open the PR against `main`, referencing #2178, with the release-note section filled in
   (`Category: N/A` — fixture-only, not user-facing).
7. Invoke **`coordinated-wrap-up`** and report the PR + gate evidence to the coordinator. Sign off
   with your own pane id.

## Traps already resolved (don't re-investigate)

- The Fable ruling and issue #2178 both loosely call the real function "buildLaunchCommand" — this
  is inaccurate; the coordinator confirmed via its own codebase-graph query that this name refers to
  the wrong (persistent-engine) builder. Use `ClaudePrintChatEngine`, not `buildLaunchCommand`.
- `hasMcpTrio && bareTools === undefined` (no `--tools` flag at all alongside the trio) must keep
  parsing as `bounded` — this is exercised by the two existing trio tests already in the file; don't
  break them.
