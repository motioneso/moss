# Build relay 3 — #1121 scriptable UAT chat (implementation phase)

**Plan (approved):** `docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md`
**Issue:** #1121 · **Worktree:** this one · **Branch:** `build/1121-scriptable-chat`
**Coordinator directive (binding):** "Proceed with Phase 1 Tasks 1-4; hold 5/6 until #1557 is on
main." Do not start Task 5/6 work until #1557 has merged — check `gh pr view 1557` or the board
before touching seed-chunk or engine-selection-regression work.

This is the **implementation** phase — planning/spec relays 1-2 (docs in this same directory) are
done and superseded for code purposes. Nothing has been committed yet this whole build lane; the
tree is clean except untracked new files listed below. **Invoke the `shared-checkout` skill before
any git action** — this worktree may be shared.

## Done — Tasks 1 and 2, fully verified, nothing left to do on them

All four files below exist, pass `pnpm exec vitest run <file>` (23/23 total), `pnpm exec tsc
--noEmit` (repo-wide, EXIT=0), and scoped `pnpm exec eslint <paths> --max-warnings=0` (EXIT=0):

- `tests/uat/fixtures/scripted-provider/script-schema.ts` + `.test.ts` — chat-script fixture
  contract: `ChatScriptFixture`, `loadChatScriptFixture`, `extractCapture` (RFC 6901 pointer),
  `resolveCaptures` (recursive `${name}` substitution). Fail-closed on every malformed shape.
- `tests/uat/fixtures/scripted-provider/launch-args.ts` + `.test.ts` — `parseClaudeLaunchArgs`,
  parses the real bounded-print-engine argv shape (`claude-print-chat-engine.ts` `buildCommand`),
  rejects `buildStructuredCommand`'s shape and anything unrecognized.
- `tests/uat/fixtures/scripted-provider/session-state.ts` + `.test.ts` — `readCursor`/`writeCursor`,
  0600-mode on-disk cursor (`scriptId`, `turnIndex`, `captures` only — no sensitive content).

`tests/uat/fixtures/chat-scripts/` directory exists but is **empty** — `phase1-smoke.json` (needed
by Task 3's own integration test) has not been written yet.

## In progress — Task 3: `bin/claude` main entrypoint (fixture executable)

**No code written yet.** All research/seams-check is done and is captured in full in a memory
entry — read it first, don't re-derive:

```
mcp__plugin_agentmemory_agentmemory__memory_recall query="1121 scriptable uat confirmation registry mcp transport"
```

(saved as memory id `mem_msofwzst_d067c4794c79`, type `architecture`, project `jarv1s`). It covers,
with `file:line` citations:

1. **Confirmation flow is a single blocking `fetch()`, not a poll loop.** The plan's Task 3 step 6
   literally says "poll the JSON-RPC result until terminal" — that's wrong. `ConfirmationRegistry
   .awaitResolution()` is awaited **server-side inside** the `/api/mcp` `tools/call` handler
   (`packages/ai/src/gateway/gateway.ts:332-365`, `packages/chat/src/mcp-transport.ts:113-133`).
   The HTTP request just hangs until the registry resolves or `confirmTimeoutMs` elapses. Implement
   `bin/claude` with one `fetch()` whose client-side timeout is >= the server's `confirmTimeoutMs`
   — cite `gateway.ts:332-365` in a comment explaining the deviation from the plan's literal wording.
2. `tools/call` result shape: `{content: McpContentBlock[], isError}`, blocks are
   `{type:"text",text}` or `{type:"image",data,mimeType}` — captures resolve against this object
   (e.g. `/content/0/text`).
3. `mcp__jarvis__<name>` is **client-side-only** convention for `--allowedTools` pattern matching
   (`packages/chat/src/routes.ts:276-277`). The wire protocol (`tools/list`/`tools/call`
   `params.name`) always uses the bare dotted tool name, e.g. `"example.read"`.
4. `transcriptGlobDir(provider, cwd, homeBase)` (`packages/ai/src/adapters/tmux-bridge.ts:93`)
   returns the **directory only** — join `${sessionId}.jsonl` yourself
   (`claude-print-chat-engine.ts:61` does this).
5. Anthropic transcript JSONL schema required by `parseTranscript`
   (`packages/ai/src/adapters/transcript-reader.ts:128-220`): each line
   `{type:"assistant", message:{stop_reason, content:[...]}}`. Intermediate tool-use record:
   `stop_reason !== "end_turn"`, content item `{type:"tool_use", name}`. Final record:
   `stop_reason === "end_turn"`, content item(s) `{type:"text", text}` joined with `"\n"` as the
   reply. No `uuid`/`parentUuid`/`sessionId` fields required by the parser.

### Next steps for `bin/claude`, in order

1. Write `tests/uat/fixtures/scripted-provider/bin/claude` (the executable entrypoint), wiring
   `launch-args.ts` + `session-state.ts` + `script-schema.ts` together per plan Task 3's step list:
   parse argv → reject closed on anything not `bounded`/`no-mcp` → for `bounded`, read the
   `--mcp-config` file (shape matches `writeClaudeMcpConfig`, `claude-print-chat-engine.ts:~312-330`)
   to get the `/api/mcp` URL + bearer → call `tools/list`, require the fixture's declared bare tool
   name is present → derive `mcp__jarvis__<dots-to-underscores>` and require it matches an
   `--allowedTools` entry (exact match or trailing-`*` prefix only, no regex) → call `tools/call`
   with `resolveCaptures`-resolved arguments (single bounded-timeout `fetch()`, see finding #1
   above) → on success, append the tool-use + final `end_turn` JSONL records (schema in finding #5)
   to `<transcriptGlobDir(...)>/<sessionId>.jsonl`, calling the real exported `transcriptGlobDir`
   helper, then exit 0 → on any failure, exit non-zero, append nothing, write to stderr **only**
   script id / turn index / failure class — never prompt text, MCP config contents, bearer, tool
   arguments/results, or reply text (CLAUDE.md "secrets never escape").
2. Write `tests/uat/fixtures/chat-scripts/phase1-smoke.json` — the fixture Task 3's own integration
   test depends on.
3. Write the integration test per plan Task 3's test-case list: valid bounded call against a
   seeded read-only tool (real DB + real MCP, no browser) → transcript appended, exit 0;
   undeclared/out-of-pattern tool → fails **before** `tools/call` is issued (assert via spy/mock
   transport, don't require a live confirmation UI for this case); confirmation-required write stays
   unmutated until real `ConfirmationRegistry` approval, then completes; no sensitive content in
   stderr on any failure path. **Invoke the `verify-gate` skill before running this** — it touches
   the live dev DB via the real MCP transport, and CLAUDE.md forbids any DB-touching test command
   without that skill.
4. Run `pnpm exec tsc --noEmit` (repo-wide) and scoped `eslint --max-warnings=0` on every new file
   before calling Task 3 done — this has caught real errors on both prior tasks (see prior relay
   history / memory), don't skip it because vitest passed.

## Addendum (same session, hit 70% context before writing code) — concrete decisions for `bin/claude`

Everything below is researched/decided, not yet written to any file. Write `bin/claude` directly
from this list — no further research should be needed.

- **Shebang:** `#!/usr/bin/env -S node --import tsx/esm`. Confirmed safe: `Dockerfile` (base
  `node:24-bookworm-slim`, `WORKDIR /app`) deliberately keeps the **full** `node_modules` (incl.
  `tsx`) plus full source (`COPY . .`) in the runtime image specifically so `tsx <script>.ts` works
  at container runtime (see Dockerfile lines ~36-44 comment, and `CMD ["node_modules/.bin/tsx", ...]`
  at line 87). Bookworm's GNU coreutils `env` supports `-S`. This lets `bin/claude`'s body be plain
  TypeScript, importing the sibling `.ts` files exactly like the vitest tests already do.
- **`transcriptGlobDir` import:** `import { transcriptGlobDir } from "@moss/ai";` — confirmed
  re-exported at package root (`packages/ai/src/index.ts:29`, `export * from "./adapters/tmux-bridge.js"`).
- **`process.cwd()` == `neutralDir` at runtime** — confirmed via
  `claude-print-chat-engine.ts:74-75,90-91` (`spawn(..., { cwd: opts.neutralDir })`). So inside
  `bin/claude`, `transcriptGlobDir("anthropic", process.cwd(), process.env.JARVIS_CLI_HOME_BASE)`
  computes the identical directory the real transcript reader will read from — no extra plumbing
  needed to locate it.
- **Script selection:** read `process.env.JARVIS_UAT_SEED_CHAT_SCRIPT` for the fixture id (matches
  the env var name Task 4 will set — see Task 4 section below; safe to reference now even though
  Task 4 hasn't wired the setter yet). Empty/unset → reject closed (no script selected).
- **State file location:** fixed subdir under cwd — `join(process.cwd(), ".uat-chat-script-state")`
  — passed as `stateDir` to `readCursor`/`writeCursor`. Matches spec's "under the neutral working
  directory" (spec line 140).
- **Cursor transition rule** (spec line 140-141, "rejects a missing/mismatched transition"): for a
  `sessionFlag.mode === "new"` launch, a prior cursor must NOT exist (reject if it does — replay/
  reuse of a session id); the effective turn index is `0`. For `"resume"`, a prior cursor MUST exist
  (reject if missing); the effective turn index is `priorCursor.turnIndex + 1`.
- **Turn selection algorithm** (spec lines 96-98: "every `expectIncludes` value must occur; zero or
  multiple eligible next steps fail" — this is a stronger check than a bare index lookup, it also
  catches script-authoring bugs like overlapping `expectIncludes` across turns):
  ```ts
  const eligible = fixture.turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.expectIncludes.every((s) => promptText.includes(s)));
  if (eligible.length !== 1) fail("ambiguous or zero eligible turns");
  if (eligible[0].index !== effectiveTurnIndex) fail("eligible turn out of order");
  ```
  Also reject if `effectiveTurnIndex >= fixture.turns.length` (EOF — harness drove more turns than
  the script defines).
- **MCP call timeout:** server-side `ConfirmationRegistry` bound is `NATIVE_CONFIRM_TIMEOUT_MS =
  150_000` (`packages/chat/src/live/claude-permission-hook.ts:17`, wired via
  `gateway-services.ts:152`). Use a single `fetch()` with an `AbortSignal.timeout(170_000)` (20s
  margin over the server bound) for the `tools/call` request — do **not** import the constant
  across the fixture→`packages/chat` boundary, just cite the file:line in a comment; hardcoding
  avoids a real coupling for one integer.
- **`/api/mcp` full wire contract** (`packages/chat/src/mcp-transport.ts`, read in full):
  - Request: `POST /api/mcp`, header `Authorization: Bearer <token>` (from the `--mcp-config` file's
    `mcpServers.jarvis.headers.Authorization`), body `{jsonrpc:"2.0", id, method, params}`.
  - `401` only for missing/invalid bearer. **Every other error is HTTP 200** with a JSON-RPC
    `{jsonrpc,id,error:{code,message}}` body (scrubbed generic messages: `-32603 "Internal error"`,
    `-32602 "tools/call requires params.name"`, `-32601 "Method not found: ..."`) — `bin/claude`
    must check `body.error` presence, not rely on HTTP status, for `tools/list`/`tools/call` failures.
  - `tools/list` success: `{jsonrpc,id,result:{tools:[{name,description,inputSchema}]}}` — `name` is
    the bare dotted tool name (e.g. `"sports.followTeam"`), never `mcp__jarvis__`-prefixed.
  - `tools/call` success: `{jsonrpc,id,result:{content:McpContentBlock[],isError:false}}` per the
    memory-recalled shape; `isError:true` on a denial/failure the gateway itself reports (distinct
    from a JSON-RPC-level `error`).

## STATUS UPDATE (same session, after the addendum above): Task 3 code is WRITTEN

Everything in the addendum above is now implemented, not just decided:

- `tests/uat/fixtures/scripted-provider/claude-main.ts` — all logic (`runScriptedClaude`/`main`
  exported). **Not** `bin/claude` itself — tsconfig.json's `"include"` only globs `**/*.ts`, so an
  extensionless file gets zero tsc/eslint coverage. Discovered this the hard way (first draft was
  written straight into `bin/claude` and `tsc --noEmit` silently skipped it — 0 errors reported
  because 0 files checked). Fixed by moving all logic into the `.ts` file.
- `tests/uat/fixtures/scripted-provider/bin/claude` — now just a 2-line executable shim:
  `#!/usr/bin/env -S node --import tsx/esm` + `import { main } from "../claude-main.js"; main();`.
  `chmod +x` applied.
- `tests/uat/fixtures/chat-scripts/phase1-smoke.json` — one turn, calls `goals.list` (read-only,
  zero-arg, always-enabled tool — `packages/goals/src/manifest.ts:47-54` — safe for a fresh
  solo-admin user with no seeded goals).
- Verified: `pnpm exec tsc --noEmit` (repo-wide, unpiped) → EXIT=0. `pnpm exec eslint
  tests/uat/fixtures/scripted-provider/claude-main.ts --max-warnings=0` → EXIT=0.

## DONE — Task 3 is fully complete and verified

`tests/integration/uat-scripted-claude.test.ts` (4 tests, real Fastify `/api/mcp` + real
`AssistantToolGateway`/`SessionTokenRegistry`/`ConfirmationRegistry`, no mocked transport) all pass:
(a) valid bounded call → transcript appended, exit 0; (b) undeclared/out-of-pattern tool → rejects
before `tools/call`; (c) confirmation-required write stays unmutated until real
`ConfirmationRegistry` approval, then completes; (d) no sensitive content reaches stderr on a
failure path. Verified via scoped `pnpm exec tsx scripts/test-integration.ts
tests/integration/uat-scripted-claude.test.ts` (isolated `jarvis_gate_1121_task3` DB, DROP+CREATE'd
fresh, dropped after — per `verify-gate` skill), repo-wide `pnpm exec tsc --noEmit` (EXIT=0), and
scoped `pnpm exec eslint tests/integration/uat-scripted-claude.test.ts
tests/uat/fixtures/scripted-provider/claude-main.ts --max-warnings=0` (EXIT=0).

**Trap hit and fixed, worth knowing if you touch this test file:** test (d) initially failed
flakily-looking (`exitSpy` observed `[0]` instead of `[1]`). Root cause was NOT in `claude-main.ts`
— it was `afterEach` never calling `vi.restoreAllMocks()`. `vi.spyOn(process, "exit")` in test (d)
returned the *same* mock instance test (a) had already installed (vitest doesn't re-wrap an
already-spied global), so test (d)'s `exitSpy` had test (a)'s leftover `exit(0)` call baked in
before test (d) even ran its own `main()`; `vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())`
resolved instantly against the stale call. Fixed by adding `vi.restoreAllMocks()` as the first line
of the shared `afterEach`. Saved as memory `mem_msoi5w7l_5bee131ce581` (type `bug`, project
`jarvis`) — any future suite here that does `vi.spyOn` on a Node global (`process.exit`,
`process.stderr.write`, etc.) must restore it in `afterEach` or risk the same cross-test leak.

## DONE — Task 4 is fully complete and verified, committed `7afa4838c`

`run-uat.ts`'s `readUatLevel` regex extended with an optional trailing `chatScript: "id"` group,
validated against `UAT_CHAT_SCRIPTS`, threaded into `provisionForUat`'s options. `provisioner.ts`:
`UatProvisionOptions.chatScript` → `buildSeedHookInput` → `SeedHook` ctx → `composeSeedHook`'s
`-e JARVIS_UAT_SEED_CHAT_SCRIPT=${chatScript ?? ""}` (always-pass-empty-means-off, same convention
as the job-search fixture var). `provisionForUat` sets `JARVIS_CLI_TOOLS_PREFIX` to the
scripted-provider fixture path for the call's duration when `chatScript` is set, restored in all 3
terminal exit paths (success teardown, terminal-catch throw, exhausted-loop throw) — not in the
port-bind retry-continue path, since the override must persist across retries within one call.
`infra/docker-compose.prod.yml:152` now reads `JARVIS_CLI_TOOLS_PREFIX:
${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}`.

All three plan-required test cases written and passing:
- `run-uat.test.ts`: chatScript threads through when valid; unknown id throws clearly. (Also fixed
  a pre-existing broken assertion in the "derives provisioning" test that predated this task —
  its `provisionForUat` expectation was missing 2 keys added by earlier #1306 Task 22 work.)
- `tests/uat/provisioner.test.ts` (new): `buildSeedHookInput`/`composeSeedHook` arg-building,
  `spawn` mocked, no Docker.
- `tests/unit/prod-compose-cli-tools-prefix.test.ts` (new): real `docker compose -f
  infra/docker-compose.prod.yml config` invocation (not a text grep) proving
  `JARVIS_CLI_TOOLS_PREFIX` resolves to `/data/cli-tools` by default and to an exported override
  value when set.

Verified: all 3 test files green via scoped `vitest run`; repo-wide `pnpm exec tsc --noEmit`
EXIT=0; scoped `pnpm exec eslint` on all 5 touched/new source+test files EXIT=0. Committed as
`7afa4838c` (6 files) via `shared-checkout` skill — `herdr pane list` confirmed no other session at
this worktree's cwd before committing.

Task 5's seed-side wiring (`tests/uat/seed/cli.ts` consuming `JARVIS_UAT_SEED_CHAT_SCRIPT`, the
solo-admin AI-provider-chunk gap) was confirmed out of Task 4's scope by re-reading the plan doc
directly — it stays with the blocked Task 5 below, nothing was duplicated into Task 4.

## Still blocked — do not start

Task 5 (seed chunk + solo-admin AI-provider-chunk seeding + instance-setting registry) and Task 6
(engine-selection regression test for `isBoundedFallbackEngine`) — held until #1557 merges to
`main` per the Coordinator's directive above.

## Standing constraints (repeated from CLAUDE.md, still binding)

- Never `git add -A`/`git add .`, never bare `git commit`, never tree-wide `checkout`/`stash`/
  `reset` — use `shared-checkout` skill first.
- Never run `pnpm verify:foundation` or any DB-touching test command without `verify-gate` skill.
- No credential/private-content exposure in fixtures, logs, docs, or prompts.
- Scope ends at PR + report — never move the board, close the issue, or merge; that's the
  Coordinator's job.
