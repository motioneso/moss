# Plan — #2178 accept read-only --tools in scripted chat fixture

**Grounding:** issue #2178, Fable ruling https://github.com/motioneso/moss/issues/1883#issuecomment-5500473776 (defect 2)
**Scope:** `tests/uat/fixtures/scripted-provider/launch-args.ts` and its test only. Fixture-only, no product code.

## Seams (file:line, current `main`/branch state confirmed)

- `tests/uat/fixtures/scripted-provider/launch-args.ts:87-89` — rejects whenever the MCP flag trio
  (`--mcp-config`/`--settings`/`--allowedTools`) and any `--tools` value (bare) are both present,
  with reason `"both the MCP flag trio and bare --tools present"`.
- `packages/chat/src/live/claude-print-chat-engine.ts:265-277` — the real bounded/print-engine
  `buildCommand`: when `opts.mcpToken && opts.mcpServerUrl` it emits the MCP trio **and then**
  `--tools "Read,Glob,Grep"` unconditionally (line 274) — this is the shape #2144 introduced and
  the fixture currently rejects.
- `tests/uat/fixtures/scripted-provider/launch-args.test.ts` — existing 8 cases; none currently
  exercise trio+bare-tools together (verified by reading the file).

## Change

In `launch-args.ts`, replace the "trio and bare --tools are mutually exclusive" rule with:

- `hasMcpTrio && bareTools === ""` → still rejected (empty --tools alongside the trio is a
  mismatch, not the real shape).
- `hasMcpTrio && bareTools === undefined` → unchanged, accepted (existing no-`--tools` trio case).
- `hasMcpTrio && bareTools` non-empty → now accepted (the real read-only launch shape).
- `!hasMcpTrio && bareTools !== ""` → unchanged, still rejected.

No change to `ParsedLaunch`'s output shape — `bareTools`'s value isn't surfaced, only used to
gate acceptance, matching the issue's minimal scope.

## Test

Add one contract test to `launch-args.test.ts`: the MCP trio plus `--tools "Read,Glob,Grep"` (the
literal value `buildCommand` emits) parses to `kind: "bounded"` with the same mcp/session/prompt
fields as the existing trio test. Keep all 8 existing cases passing verbatim (no edits to them).

## Verification

- Focused: `pnpm vitest run tests/uat/fixtures/scripted-provider/launch-args.test.ts`
- Full gate via `verify-gate` skill (never piped, never run directly).
- Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then rebase onto
  `origin/main`.

## Exit

Pushed branch, PR open against `main`, PR references #2178. No live-proof owed (fixture-only, not
a UI-facing change). `coordinated-wrap-up` for closeout.
