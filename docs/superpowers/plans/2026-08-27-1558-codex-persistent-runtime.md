# Plan — issue #1558: Codex persistent chat adapter

Spec: `docs/specs/1558.md` (also posted as issue #1558 comment, first line `SPEC`).
Task issue: #1558.

Built under the fleet daemon (no live coordinator this run) — plan is self-approved per the
brief's substitution rule (fleetctl records stand in for coordinator messages). No product/
architecture fork found during verification; spec's premises all confirmed current on this branch
(`codex-persistent-runtime.ts` absent, `claude-persistent-runtime.ts` / `codex-exec-session.ts`
present exactly as cited).

## Seams check (file:line citations)

- `packages/chat/src/live/provider-runtime.ts:67-82` — `ProviderChatRuntime` interface every
  adapter must implement.
- `packages/chat/src/live/claude-persistent-runtime.ts:51-353` — reference adapter shape
  (launch/submitTurn/streamEvents/cancel/health/reap/recover), `createMcpReadinessProbe`
  (`:306-343`), `killChildProcess` pattern (`:204-230`), `shellQuote`/`modelOverrideFlag`
  (`:345-352`).
- `packages/chat/src/live/codex-exec-session.ts:104-161` — `buildPrompt`/`buildCommand` exact
  flags to reuse: `--skip-git-repo-check`, `--disable apps`, `--sandbox read-only`,
  `-c 'approval_policy="never"'`, `-c 'features.shell_tool=false'`,
  `-c 'features.apply_patch_tool=false'`, MCP `-c` lines (`:134-142`).
- `packages/ai/src/adapters/transcript-reader.ts:224-326` — Codex `exec --json` line shapes:
  `thread.started` -> `turn.started` -> `item.completed{item:{type,text}}` (agent_message /
  reasoning / command_execution / mcp_tool_call) -> `turn.completed`.
- `packages/chat/src/live/persistent-stream-decoder.ts:20,29` — `MAX_FRAME_BYTES`,
  `MAX_TOTAL_BUFFERED_BYTES` constants to import and reuse (not redefine).
- `packages/chat/src/live/persistent-runtime-engine.ts:51-191` — `ClaudePersistentRuntimeEngine`,
  the `CliChatEngine` wrapper to generalize.
- `packages/chat/src/live/engine-selection.ts:158-177` — `createChatEngine`, the
  `provider === "anthropic"` gate to extend.
- `packages/chat/src/live/types.ts:14-33,47-80` — `TranscriptRecord`, `EngineLaunchOpts`.

Open question: none — the pool/composition-root wiring in `runtime.ts` / `cli-runner/src/main.ts`
(single Claude-only `PersistentRuntimePool`) is out of scope per spec's "Wiring it in" section,
which names only `persistent-runtime-engine.ts` and `engine-selection.ts`. The Codex branch in
`engine-selection.ts` therefore only takes the unconditional (non-pool) construction path, exactly
like the pre-task-5 Claude behavior when no pool is supplied — this does not change any existing
Claude call site.

## Task 1 — `codex-persistent-runtime.ts`

New file `packages/chat/src/live/codex-persistent-runtime.ts`.

```ts
export const NEUTRAL_ADMISSION_FAILURE: string; // reused message, same text as Claude's
export const NEUTRAL_LAUNCH_FAILURE: string;
export const NEUTRAL_CRASH_FAILURE: string;

export interface CodexPersistentRuntimeOpts {
  readonly io: Pick<TmuxIo, "run" | "writeFile">;
  readonly tokenEnvPath?: string;
  readonly spawnChild?: (command: string, cwd: string) => ChildProcessWithoutNullStreams;
}

export class CodexPersistentRuntime implements ProviderChatRuntime {
  readonly kind: ProviderRuntimeKind = "persistent";
  readonly provider: ProviderKind = "openai-compatible";
  constructor(opts: CodexPersistentRuntimeOpts);
  launch(opts: EngineLaunchOpts & { readonly mcpReadiness: McpReadinessProbe }): Promise<void>;
  submitTurn(turnId: string, engineText: string): Promise<void>;
  streamEvents(): AsyncIterable<RuntimeTurnEvent>;
  cancel(turnId: string): Promise<CancelOutcome>;
  health(): Promise<RuntimeHealth>;
  reap(reason: ReapReason): Promise<void>;
  recover(turnId: string): Promise<RecoveryOutcome>;
}

export class CodexStreamDecoder {
  constructor(opts: { readonly killChild: (reason: string) => void });
  beginTurn(turnId: string): void;
  write(chunk: string): void;
  end(): void;
  events(): AsyncIterable<RuntimeTurnEvent>;
}
```

Decisions:

- `launch()`: same fail-closed `mcpReadiness()` gate as Claude's (P1.4 probe, imported from
  `claude-persistent-runtime.js`). No child spawned here — Codex only starts a process per turn.
  State -> `"ready"` once the probe resolves; throw `NEUTRAL_ADMISSION_FAILURE` on reject,
  `NEUTRAL_LAUNCH_FAILURE` if `mcpToken`/`mcpServerUrl` missing (mirrors Claude's own-token guard).
- `submitTurn(turnId, engineText)`: write the prompt file (mirrors `codex-exec-session.ts`
  `buildPrompt`, minus the prior-turn `User:`/`Assistant:` replay list — Codex's own session
  already holds that once resumed). First physical process launch on this runtime instance runs
  `codex exec --json`; every launch after that (including a retried first turn) runs
  `codex exec resume --last --json`. Spawn via `this.spawnChild` (piped stdio, not `io.run`) so
  stdout streams into a fresh `CodexStreamDecoder` per turn.
- `streamEvents()`: an async generator that waits for the decoder assigned by the most recent
  `submitTurn`, drains its events, then waits for the next one — a small internal gate
  (`decoderReady`/`decoderQueue`) since a new child spawns every turn (unlike Claude's one
  long-lived child). Reuses `MAX_FRAME_BYTES`/`MAX_TOTAL_BUFFERED_BYTES` imported from
  `persistent-stream-decoder.ts`. EOF with no `turn.completed` seen -> `turn-failed` neutral
  failure (mirrors `EOF_WITHOUT_TERMINAL_REASON`).
- `cancel(turnId)`: SIGTERM then SIGKILL after a 1s grace period on the current turn's child —
  copy of Claude's `killChildProcess` (`claude-persistent-runtime.ts:204-230`).
- `health()`: `alive` true only while a turn's process is currently running (no persistent child
  between turns — that's the documented, accepted tradeoff, not a fault). `state` tracks
  `ready`/`in-turn`/`idle`; `turnsCompleted`/`lastResultAt` updated on `turn-complete`, same as
  Claude's runtime.
- `reap(reason)`: kill the in-flight per-turn child if any; close the decoder gate. No persistent
  process to additionally clean up.
- `recover(turnId)`: safe to resubmit only if `currentTurnId === turnId`, no `record.kind==="tool"`
  event was seen for this turn yet, and this is the first recovery attempt for the turn (mirrors
  Claude's `recoveredForTurn` single-shot guard, minus the `frameAcceptedForTurn` check — Codex has
  no discrete "frame accepted" moment since the whole process is the submission). Otherwise
  `{ kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE }`.

## Task 2 — wire it in

- `persistent-runtime-engine.ts`: add an optional `provider?: ProviderKind` (default
  `"anthropic"`) to `ClaudePersistentRuntimeEngineOpts` and make the instance `provider` field
  follow it. When no `opts.runtime` is injected, default-construct `ClaudePersistentRuntime` for
  `"anthropic"` (unchanged) or `CodexPersistentRuntime` for `"openai-compatible"` (new) — every
  existing call site that omits `provider` keeps today's behavior exactly.
- `engine-selection.ts`: extend the `opts.persistentRuntimeEnabled` gate from
  `provider === "anthropic"` to `provider === "anthropic" || provider === "openai-compatible"`.
  The pool-admission branch (`admitPersistentOrFallback`) stays anthropic-only (the shared pool's
  `createRuntime` is wired Claude-only at the composition roots, out of scope here — see seams
  note above); Codex takes the unconditional-construct branch, passing
  `provider: "openai-compatible"` to `ClaudePersistentRuntimeEngine`.

## Testing (per phase, run and observed passing — see verification below; no live-UI proof needed,

see spec "Testing" section: unit-testable, no chat UI change)

- `tests/unit/codex-persistent-runtime.test.ts` (new, modeled on
  `tests/unit/claude-persistent-runtime.test.ts`): fake `spawnChild`, feed canned
  `thread.started`/`turn.started`/`item.completed`/`turn.completed` JSON lines; assert
  - second `submitTurn` call's command contains `resume --last` and NOT plain `codex exec --json`.
  - a crash (stdout EOF) before any `command_execution`/`mcp_tool_call` item -> `recover()` returns
    `{ kind: "resubmitted" }` and spawns a second process.
  - a crash after a tool item -> `recover()` returns `{ kind: "neutral-failure", reason:
NEUTRAL_CRASH_FAILURE }`.
  - `agent_message` item text surfaces as a `record` event with `kind: "reply"`.
- `tests/unit/persistent-runtime-engine.test.ts`: extend with a case constructing
  `ClaudePersistentRuntimeEngine` with `provider: "openai-compatible"` and a fake
  `ProviderChatRuntime`, proving the wrapper is provider-agnostic (same assertions as the existing
  Claude case).
- `packages/chat/src/live/engine-selection.test.ts`: add a case proving
  `provider === "openai-compatible"` with `persistentRuntimeEnabled: true` and no pool selects
  `ClaudePersistentRuntimeEngine` with `provider: "openai-compatible"`, matching the existing
  Claude case's shape.

## Verification

```bash
pnpm --filter @moss/chat exec vitest run tests/unit/codex-persistent-runtime.test.ts tests/unit/persistent-runtime-engine.test.ts > /tmp/1558-vitest.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

```bash
pnpm --filter @moss/chat exec vitest run src/live/engine-selection.test.ts > /tmp/1558-vitest-2.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

Pre-push trio (per `coordinated-build`):

```bash
pnpm format:check && pnpm lint && pnpm typecheck
```

Expected exit code: 0 for each.

## Kill gate

Phase ships alone (this is already a single bounded fast-follow, not a multi-phase feature) — no
further phase planned. If `codex exec resume --last` turns out not to preserve context the way the
spec assumes (discovered only against a real Codex binary, out of reach in this unit-test-only
lane), that is a finding for whoever runs live-path verification later, not a reason to hold this
PR — the spec explicitly scopes verification to unit tests with a fake process.

## Determinism boundary

No UI/user-facing surface changes in this PR — chat feedback rendering is unchanged; only which
process runs behind a Codex chat session when the rollout flag is on. N/A beyond that.
