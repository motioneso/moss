# Relay: PR 2280 extension, built-in search for command-line models

Brief: `~/.coord-briefs/boot-build-2280-cli-search.txt` (read it in full; it is short). Branch
`build/web-search-default`, worktree `~/Jarv1s/.claude/worktrees/web-search`. Issue 2228, PR 2280.
No code written yet: the first session spent its window on discovery. Everything below is
verified against the branch at daacc5ddf. Do not re-derive it; build.

Ben's added ruling (chat, tonight): provider agnostic. One contract every CLI provider can
declare (built-in search with sources) and one generic mapping from a runner's tool results into
the shared source shape. Claude CLI and Codex CLI are the two implementations. A third CLI must
need no change outside its adapter. No hardcoded model or provider names in feature code.

Plain English rule for every human-facing message: no jargon, ASCII punctuation, at most one
backtick per sentence. Pass it on verbatim to any agent you spawn.

## How search flows today (verified)

- Chat and News both search through the `web.search` tool, which calls the model-native provider
  (`packages/web-research/src/providers.ts:157`), which calls the runner built by
  `buildModelNativeSearchResolver` (`packages/module-registry/src/index.ts:897`), which calls
  `generateStructured` with `nativeSearch: true`.
- For a CLI provider, `generateStructured` (`packages/ai/src/structured/generate-structured.ts:160`)
  uses `createCliStructuredAdapter` = `CliStructuredAdapter`
  (`packages/chat/src/live/cli-structured-adapter.ts`). One-shot path (no scope): `engine.launch`
  + `submit` + poll `readNew` for a "reply" record. Returns `{ rawText, usage }`, no sources.
  `nativeSearch` on the input is ignored.
- `generateStructured` line 209: the rawText branch drops sources; line 268 only reads
  `sources` from the rawObject branch. Both need the sources passed through.
- Engine for anthropic non-interactive + needsStructuredOutput is `ClaudePrintChatEngine`
  (`claude-print-chat-engine.ts`). `buildCommand` (line 356) runs `claude -p ... --tools ""`
  (no MCP in the structured case, so no permission hook), then `readNew` (line 252) parses
  Claude's own transcript jsonl with `parseTranscript("anthropic", ...)`.
- Engine for openai-compatible structured calls is `CliChatEngineImpl` in codex exec mode
  (`cli-chat-engine.ts:255`) which runs `CodexExecSession` (`codex-exec-session.ts`, `buildCommand`
  line 120: `codex exec --json ...`), output parsed by `parseTranscript("openai-compatible")`.
- Transcript mapping: `packages/ai/src/adapters/transcript-reader.ts`. Anthropic user records
  with `tool_result` blocks: `mapAnthropicUserRecord` line 281 (only errors today). Codex exec
  items: `mapCodexExecItem` line 373 (ignores `web_search` items). Events are
  `ChatActivityEventWithToolName` (line 89); print engine copies them to `TranscriptRecord`
  (`packages/chat/src/live/types.ts:14`) at `claude-print-chat-engine.ts:284`.
- Dev and prod run the engine in the cli-runner sidecar over RPC. Launch options cross the
  socket as `RpcLaunchParams` (`packages/chat/src/live/rpc-contract.ts:268`), built by
  `buildLaunchParams` (`chat-engine-rpc-client.ts:842`), consumed by `engine-host.ts:325`
  (`launchOpts` object). Records come back as-is (JSON), so an extra optional field on a
  record passes through without contract changes.
- Family marking: `inferWebSearchCapability(kind, id, isCli)` (`packages/ai/src/model-discovery.ts:247`)
  returns false for any CLI. CLI discovery calls it with `isCli: true` at line 126. API-key path
  is `provider-validation.ts:127`. Refreshing models on the provider card re-runs discovery, so
  existing CLI model rows get the flag on the next refresh (say this in the PR comment).
- Codex CLI 0.139.0 is installed; Claude Code 2.1.261. Codex web search is enabled by
  `-c 'web_search="live"'`. Its `--json` item `web_search` carries `{id, query, action}` where
  action is `search` (no urls), `open_page` or `find_in_page` (each with a `url`). No titles.
- Wording surfaces (chip, AI providers group, News reason, app map) are all driven by the
  model's `web-search` capability flag; none of them names CLI providers. Only the spec does:
  `docs/superpowers/specs/2026-09-04-web-search-default-native.md` lines 34-39, 52-63, 101-106.

## Design to build (decided; matches Ben's ruling)

1. **Declaration, in `@moss/ai`:** a small table `CLI_PROVIDER_SEARCH` keyed by provider kind,
   `{ builtInSearch: boolean }` (anthropic true, openai-compatible true, google false). Export
   `cliProviderHasBuiltInSearch(kind)`. `inferWebSearchCapability` returns that when `isCli`
   (the CLI's search tool is the CLI's, not the model family's). A third CLI adds one row.
2. **Contract:** `EngineLaunchOpts.nativeSearch?: boolean` (types.ts) and
   `RpcLaunchParams.nativeSearch?: boolean`; forward it in `buildLaunchParams` and in the
   engine-host `launchOpts`. `TranscriptRecord` and the transcript event type gain
   `sources?: readonly { title: string; url: string }[]` on tool records.
3. **Generic collection:** `CliStructuredAdapter.run` and the late-read path collect `sources`
   from every record it reads (dedupe by url) and return `{ rawText, usage, sources }`; pass
   `nativeSearch: input.nativeSearch` into `engine.launch`. `StructuredProviderResult` rawText
   variant gains `sources?`; `generateStructured` keeps them on the rawText branch.
4. **Claude adapter:** in `buildCommand`, when `opts.nativeSearch`, the no-MCP branch emits
   `--tools "WebSearch"` and `--allowedTools WebSearch` instead of `--tools ""` (append to both
   lists in the MCP branch). In `mapAnthropicUserRecord`, for each successful `tool_result`,
   extract sources from the record's top-level `toolUseResult.results[].content[]` objects
   with title and url, falling back to a `Links: [...]` JSON array inside the result text; emit
   `{ kind: "tool", text: "", toolCallId, sources }` only when non-empty.
5. **Codex adapter:** `CodexExecSession.buildCommand` adds `-c 'web_search="live"'` when
   `launchOpts.nativeSearch`. `mapCodexExecItem` maps a `web_search` item to a tool event whose
   sources are the `open_page` / `find_in_page` urls (title = url). Codex only reports pages it
   opened, not every hit; say so plainly in the PR comment. Keep Codex marked (row 1) unless a
   bounded local run shows the installed codex emits no urls.
6. **Spec:** amend non-goal 3, decision 3 and section 5.2 to say CLI providers are covered via
   the CLI's own search tool and that the app map, chip and News reason follow the flag.
7. **Tests to extend, never loosen:** `tests/unit/ai-model-discovery-web-search.test.ts`
   (CLI case flips to true for anthropic and openai-compatible, stays false for google),
   `tests/unit/cli-structured-adapter.test.ts` (sources collected and returned; nativeSearch
   forwarded to launch), `tests/unit/claude-print-chat-engine.test.ts` (launch line has
   WebSearch only when nativeSearch), `tests/unit/chat-codex-exec-session.test.ts` (live
   web_search config only when nativeSearch), `tests/unit/transcript-reader-tool-name.test.ts`
   or a new transcript test (both source extractions), `generate-structured` test for sources
   on the rawText path.

## Verify (worktree only, never the live database)

`pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck`, then vitest on the
touched test files. Push normally to origin. Post one PR comment on 2280 headed
"Extension: built-in search for command-line models" (commit hash, per-file changes, how a
reviewer sees CLI search results flow into sources, the refresh-models note, the Codex caveat).
Then report: `herdr agent prompt coordinator "2280 CLI search extension pushed at <hash>: ... [pane $HERDR_PANE_ID]"`.
Relay budget is spent: if the meter fires again, push what is green and report for a re-slice.
