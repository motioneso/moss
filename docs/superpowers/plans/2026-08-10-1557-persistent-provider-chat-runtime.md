# Plan — #1557: Persistent provider chat runtime (build of spec #1554)

- **Spec:** `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md`
  (APPROVED by Ben 2026-08-10, post-Codex-review revision; grounded on origin/main `128a5bed6`)
- **Task issue:** motioneso/moss **#1557** (Part of #1554). Fast-follows #1558 (Codex adapter)
  and #1559 (Gemini adapter) are **blocked on the phase-1 kill gate below**.
- **Plan date:** 2026-08-10. Seam citations verified against the working tree this day.
- **User-facing summary (release-note language):** Chat replies start faster and tool calls are
  more reliable, because Moss now keeps one assistant process warm per conversation instead of
  starting a new one for every message. No visible UI change; behaviour is identical when the
  feature flag is off.

## Seams check (verified `file:line`, current tree)

| Seam                                                                              | Citation                                                                                                                                                                                                                                                                                             | What it gives the plan                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine selection (THE fork point)                                                 | `packages/chat/src/live/engine-selection.ts:48-54` (`isOneShotEngine`), `:61-89` (`createChatEngine(provider, sessionKey, io, opts)`), `:27-40` (`ChatEngineSelectionOpts`: mux, homeBase, executionMode, credentialFile, ownsDrain, onDiagnostic)                                                   | Persistent-vs-fallback decision threads through here; header documents the #1350 two-composition-roots trap (in-process `runtime.ts` factory vs cli-runner `EngineHost`; RPC root active whenever `JARVIS_CLI_RUNNER_SOCKET` is set) |
| cli-runner root                                                                   | `packages/cli-runner/src/engine-host.ts:162,176,181` (`launchOnce`)                                                                                                                                                                                                                                  | Pool must live HERE when the socket is set (PID-owning process, per spec)                                                                                                                                                            |
| One-shot structured transport (fallback keeps it; persistent must NOT inherit it) | `packages/chat/src/live/claude-print-chat-engine.ts:74-78` (detached, `stdio:"ignore"` spawn), `:84-110` (`launchStructured`, unbounded `structuredOutput += chunk` accumulation at `:99-101`), `:112-124` (`submitStructured` user-frame shape), `:126-141` (`readStructured` full-buffer re-slice) | The exact patterns the spec forbids reusing: persistent transport is piped stdio + consuming bounded decoder, no offset re-slicing                                                                                                   |
| Existing engine contract                                                          | `packages/chat/src/live/types.ts:81-112` (`CliChatEngine`: launch/submit/interrupt/readNew/isAlive/kill/purgeTranscripts?/resetActivityDeadline?)                                                                                                                                                    | The fallback already conforms; the new neutral lifecycle contract sits beside it, and an adapter maps it onto `CliChatEngine` so `chat-session-manager` needs no rewrite in phase 1                                                  |
| Approval wait (native)                                                            | `packages/ai/src/gateway/gateway.ts:332-335` (`confirmations.awaitResolution(action.id, confirmTimeoutMs)`)                                                                                                                                                                                          | Block-in-tool-call already exists server-side                                                                                                                                                                                        |
| Approval wait (module tools) + late-Approve execution point                       | `gateway.ts:564` (`await pendingResolution`), `:566-591` (denied/timeout/cancelled path), `:593` (`runHandler` runs ONLY after `"confirmed"`)                                                                                                                                                        | Cancel-terminally-resolves work targets the registry, not the gateway                                                                                                                                                                |
| Confirmation registry                                                             | `packages/ai/src/gateway/confirmation-registry.ts:15-30` (`awaitResolution` fail-closed timeout), `:38-43` (`resolve(id, status): boolean`, false when no live waiter)                                                                                                                               | `resolve(id, "cancelled")` is the terminal-resolution primitive; the false return is what makes "late Approve cannot execute" checkable                                                                                              |
| Hook timeout ladder                                                               | `packages/chat/src/live/claude-permission-hook.ts:17-19` (`NATIVE_CONFIRM_TIMEOUT_MS=150_000` < `HOOK_INTERNAL_DEADLINE_S=170` < `HOOK_TIMEOUT_SECONDS=180`, #1158 ordering)                                                                                                                         | Persistent child keeps the same hook + ladder; `awaiting-approval` state duration is bounded by this ladder                                                                                                                          |
| Incognito purge guard                                                             | `packages/chat/src/live/chat-session-manager.ts:246-251` (throws `CliChatUnavailableError` when incognito and `!engine.purgeTranscripts`)                                                                                                                                                            | Stays as-is; persistent adapter must satisfy it under whichever phase-1 posture wins                                                                                                                                                 |
| Delivery-unknown semantics                                                        | `chat-session-manager.ts:434-440` (`CliChatDeliveryUnknownError` ⇒ evict + revoke token, NEVER resubmit), `:441-448` (`CliChatUnavailableError` ⇒ heal + resubmit ONCE)                                                                                                                              | The provably-pre-acceptance rule maps onto these two existing error classes — no new manager semantics                                                                                                                               |
| Replay seam (#1553/#1556 owns internals)                                          | `chat-session-manager.ts:242-257` (assembles memory seed + summary + `listPriorTurns` into `replayBatch`), `packages/chat/src/live/persistence.ts:157` (`listPriorTurns`)                                                                                                                            | Persistent launch consumes `replayBatch` exactly like today's launch; no coupling to #1556 beyond the existing string                                                                                                                |
| MCP token lifecycle                                                               | `chat-session-manager.ts:252` (`mintMcpToken` at launch), `:438` (`revokeMcpToken` on evict), wired at `packages/chat/src/live/runtime.ts:385-386` (`mcpTokenLifecycle.mint/revoke`)                                                                                                                 | Reap-revokes-token is already the pattern; pool reap must call the same seam                                                                                                                                                         |
| Server-side MCP session + TTL                                                     | `packages/chat/src/mcp-transport.ts:72-77` (per-request bearer verify), `:84` (initialize), `:120` (`gateway.callTool(token, …)`); `packages/ai/src/gateway/session-tokens.ts:26-35` (`DEFAULT_TOKEN_TTL_MS = 60min` backstop, touch-on-activity, `revokeBySessionId` at reap)                       | Spec's "MCP session TTL ≥ idle-reap + margin" is ALREADY satisfied: 60-min touch-refreshed backstop > 30-min reap. Decision: no TTL change; cite in code comment only if a reviewer asks                                             |
| Admin settings pattern                                                            | `packages/settings/src/instance-settings-keys.ts` (`INSTANCE_SETTINGS_REGISTRY`; precedent `chat.multiplexer`; secret-key guards), `packages/settings/src/runtime-config-keys.ts` (`RUNTIME_CONFIG_REGISTRY`, typed entries incl. `int`, admin PATCH validation via runtime-config-routes)           | Flag + pool cap + idle-reap land here, admin-only by construction                                                                                                                                                                    |
| Env carve-out (#1443)                                                             | `packages/db/src/env.ts:5-29` (`resolveMossEnv`: MOSS*-first, JARVIS* fallback; `CARVE_OUT` list is for shell/compose-consumed names only), `packages/cli-runner/src/sanitized-env.ts:14-28` (`ALLOWED_KEYS` allowlist for spawned children)                                                         | New knobs are settings-first; anything env-shaped is `MOSS_*`-only (no JARVIS\_ history). Pool/reap values reach cli-runner via RPC params, NOT env ⇒ no sanitized-env change                                                        |

**Could not cite (by design → phase-1 verification item):** whether CLI 2.1.227
`--no-session-persistence` coexists with `--input-format stream-json` persistent stdin (multiple
user frames, one process). Nothing in the tree can answer this; the Phase-0 spike
(`docs/research/2026-08-10-1554-phase0-spike.md`) only proved the `--session-id` leg.

## Rulings ledger (decisions locked by spec/Ben — do not re-litigate in build)

1. DB transcript is sole conversation truth; provider transcript never resumed/adopted; fresh
   provider session per launch fed by the existing `replayBatch`.
2. No migration; `provider_execution_mode` column untouched. Selection = persistent adapter
   exists for provider AND rollout flag on; else bounded-fallback (re-badged one-shot).
3. Block-in-tool-call approvals; `awaiting-approval` children are never reaped/evicted.
4. No mid-turn graceful cancel in v1: cancel = terminally resolve pending approvals, then
   terminate + relaunch.
5. All-busy at pool cap ⇒ that turn runs on bounded-fallback. No queueing; never evict busy.
6. Determinism boundary: zero model-generated lifecycle/recovery prose reaches threads.
   Recovery is log events + neutral server-composed turn failures only.
7. Provider-agnostic: no vendor names in product surfaces, settings labels, or error text.
   The Claude adapter is internal behind the neutral contract.
8. Tests never assert on `system/init` event counts (fires per-turn on the persistent path) or
   `init.mcp_servers` (goes stale). Health reads result fields only.
9. Deny-by-default PreToolUse hook is the sole real tool guard; `--allowedTools` is
   permission-scoping only (31 built-ins remain exposed without the hook).

## Neutral lifecycle contract (decision — exact shape, new file)

New file `packages/chat/src/live/provider-runtime.ts` (exported via `public.ts` only if a
consumer outside `live/` appears — default: not exported from the package):

```ts
export type ProviderRuntimeKind = "persistent" | "bounded-fallback";
export type ChildState =
  | "launching"
  | "ready"
  | "in-turn"
  | "awaiting-approval"
  | "idle"
  | "reaping";
export type ReapReason =
  | "idle-timeout"
  | "lru-evict"
  | "flag-drain"
  | "token-rotation"
  | "incognito-end"
  | "crash-cleanup"
  | "shutdown";
export type CancelOutcome = { readonly approvalsResolved: number };
export type RecoveryOutcome =
  | { readonly kind: "resubmitted" } // provably-pre-acceptance only
  | { readonly kind: "neutral-failure"; readonly reason: string }; // server-composed, no model prose

export interface RuntimeHealth {
  readonly alive: boolean;
  readonly state: ChildState;
  readonly turnsCompleted: number;
  readonly lastResultAt: number | null; // from terminal result frames ONLY (ruling 8)
}

export interface ProviderChatRuntime {
  readonly kind: ProviderRuntimeKind;
  readonly provider: ProviderKind;
  /** Fail-closed admission: resolves only after the server-side MCP session for this child's
   *  token has initialized AND listed tools; no user frame may be written before then. */
  launch(opts: EngineLaunchOpts & { readonly mcpReadiness: McpReadinessProbe }): Promise<void>;
  submitTurn(turnId: string, engineText: string): Promise<void>;
  /** Push-based; resolves per-frame as the bounded decoder parses. Replaces readNew polling. */
  streamEvents(): AsyncIterable<RuntimeTurnEvent>;
  cancel(turnId: string): Promise<CancelOutcome>;
  health(): Promise<RuntimeHealth>;
  reap(reason: ReapReason): Promise<void>;
  /** Called by the owner after a child death mid-turn. Decides resubmit-vs-neutral-failure
   *  from acceptance evidence (frame accepted? any tool activity?), relaunch ≤ once per turn. */
  recover(turnId: string): Promise<RecoveryOutcome>;
}
```

An adapter class (`persistent-runtime-engine.ts`, phase 1) wraps a `ProviderChatRuntime` in the
existing `CliChatEngine` interface (`types.ts:81-112`) so `chat-session-manager` keeps its
current call shape; `readNew` on this adapter drains the event stream's buffer instead of
re-slicing a transcript. Error mapping decision: recovery `neutral-failure` after possible
delivery ⇒ throw `CliChatDeliveryUnknownError`; failures provably before acceptance ⇒
`CliChatUnavailableError` (manager heals + resubmits once, `chat-session-manager.ts:441-448`).

## Settings & flags (decision — exact keys)

All admin-only via the existing registries; no migration, no new routes.

- `INSTANCE_SETTINGS_REGISTRY` (+ its keys test): `chat.persistent_runtime.enabled`
  (boolean-string, default absent = **off**). This is the single rollout flag; flag-off is a
  drain transition (ruling in spec): new launches select fallback immediately, in-flight
  children drain, then reap + `revokeMcpToken`.
- `RUNTIME_CONFIG_REGISTRY`: `chat.persistent_pool_cap` (`int`, default `"4"`, envVar
  `MOSS_CHAT_PERSISTENT_POOL_CAP`, moduleOwner `chat`) and `chat.persistent_idle_reap_minutes`
  (`int`, default `"30"`, envVar `MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES`, moduleOwner `chat`).
  Values reach the cli-runner root inside RPC launch params (never via child env; sanitized-env
  untouched).

---

## Phase 1 — Neutral contract + Claude persistent adapter, flag-gated, drawer-first (SHIPS ALONE)

Scope: one persistent child per (actor, surface); happy-path turns + tools; fail-closed
admission; bounded decoder; incognito posture. **No pool** (cap enforced trivially: second
concurrent (actor,surface) launch while flag on but pool absent ⇒ fallback). In-process
composition root only; RPC root explicitly selects fallback in phase 1 (one-line guard at the
`engine-selection.ts` fork, so the #1350 two-roots trap cannot half-ship).

### Tasks (boundaries, not implementations)

1. **P1.0 — Bounded verification item (FIRST, timeboxed ≤ half a day):** on the dev box, drive
   CLI 2.1.227 by hand: `--print --input-format stream-json --output-format stream-json
--include-partial-messages --verbose --no-session-persistence` + piped stdin; send ≥3 user
   frames sequentially, confirm ≥3 terminal results on ONE process and then inspect
   `~/.claude/projects/` for any resumable transcript. Record the transcript of the probe in
   `docs/research/` (counts/flags only, no chat content).
   **Decision point (named in exit criteria):** works ⇒ adopt `--no-session-persistence`
   (preferred posture: incognito needs no purge because nothing persists). Fails ⇒ fallback
   posture: fresh `--session-id <uuid>` per launch + purge of that session's provider files on
   EVERY termination path (reap, crash-cleanup, cancel-relaunch, flag-drain, shutdown), and the
   adapter implements `purgeTranscripts` so the incognito guard at
   `chat-session-manager.ts:246-251` admits it.
2. **P1.1 — Contract + types:** `provider-runtime.ts` exactly as above; re-badge one-shot as
   `bounded-fallback` (naming/log-fields only — zero behaviour change to the one-shot engine).
3. **P1.2 — Bounded stream decoder** (`persistent-stream-decoder.ts`): consuming incremental
   line splitter; max frame size + total buffered bound (constants with rationale comments);
   malformed line ⇒ log + skip; bound exceeded ⇒ kill child + neutral turn failure; stdout EOF
   without terminal result ⇒ neutral failure. No offset API.
4. **P1.3 — Claude persistent adapter** (`claude-persistent-runtime.ts`): piped-stdio spawn
   (NOT the detached/ignore pattern at `claude-print-chat-engine.ts:74-78`), process-group
   SIGTERM→SIGKILL reap, launch flags per spec §Claude adapter with the P1.0 decision applied;
   one user frame per `submitTurn`, terminal-result bookkeeping for `health()`.
5. **P1.4 — Fail-closed MCP admission:** before the first frame, verify the server-side MCP
   session for the minted `jst_` token has initialized and listed tools (probe via the same
   HTTP surface the child uses, `mcp-transport.ts:84` initialize + tools/list); unreachable ⇒
   no frame ever sent, neutral launch error. `--strict-mcp-config` alone is insufficient
   (spike finding).
6. **P1.5 — Selection + flag:** thread `chat.persistent_runtime.enabled` through
   `createChatEngine` (`engine-selection.ts:61-89`) via a new opt; in-process root wires it in
   `runtime.ts`; RPC root pinned to fallback this phase.
7. **P1.6 — CliChatEngine adapter** (`persistent-runtime-engine.ts`): the mapping described
   above, including error-class mapping and `purgeTranscripts` per P1.0 outcome.

### Test cases (behaviour + why it fails against a broken build)

- _Three frames, one process:_ decoder/adapter unit test drives 3 turns against a scripted
  fake child; asserts 3 terminal results, `turnsCompleted === 3`, same child PID. Fails if the
  adapter silently respawns per turn (the one-shot habit this whole task exists to remove).
- _Decoder bound:_ feed a frame exceeding max size ⇒ child killed + neutral failure surfaced;
  fails against a port of the `structuredOutput +=` unbounded accumulator (`:99-101`).
- _EOF mid-turn:_ close scripted stdout before a terminal result ⇒ neutral failure, no retry;
  fails if EOF is treated as turn completion (empty reply reaches the thread).
- _Admission fail-closed:_ MCP probe returns unreachable ⇒ `submitTurn` never called, launch
  rejects with neutral error; fails if the adapter trusts `--strict-mcp-config` and writes the
  frame anyway (spike showed the child launches fine with MCP down).
- _Incognito posture:_ per P1.0 branch — either assert no provider transcript exists after 2
  turns + reap, or assert `purgeTranscripts` ran on every `ReapReason`; fails if any
  termination path leaks a resumable transcript.
- _No init-count assertions:_ meta-test/lint of new tests for `system/init` count or
  `init.mcp_servers` matching (ruling 8) — protects against the spike's known-stale signals.
- _Vendor-neutral surfaces:_ neutral error strings + settings labels contain no provider names;
  fails if adapter internals leak into user-facing text (hard invariant).

### Verification (unpiped, expected exit codes)

```
pnpm --filter @moss/chat test > /tmp/1557-p1-chat.log 2>&1; echo "EXIT=$?"     # expect EXIT=0, and >0 tests ran (check the log tail — a filter matching 0 tests is a false green)
pnpm typecheck > /tmp/1557-p1-tc.log 2>&1; echo "EXIT=$?"                      # expect EXIT=0
```

Full gate `pnpm verify:foundation` ONLY via the `verify-gate` skill (fresh DB, run-gate.sh
sentinel); expect EXIT=0. Untracked scratch files red the gate — clean before running.

### Phase-1 e2e (live dev instance, recorded on the PR)

**e2e-P1 "warm child, real tools":** flag ON for Ben's dev instance, drawer surface: ≥3
consecutive turns land on one child (assert same PID via `ps`, and server-side initialize
count for the session's token == 1 in api logs); one read tool and one browser-approved write
tool complete within those turns; flag OFF ⇒ next turn selects fallback without an api restart.
Evidence: URL for Ben + PID/initialize-count observations. No transcript content in evidence.

### Exit criteria & KILL GATE

Exit: e2e-P1 green; **P1.0 decision point recorded in the PR body** (which posture shipped and
the probe evidence path); all unit behaviours above green; gate green via verify-gate.

**KILL GATE — owner: Ben.** Named observation: on the live dev canary, phase 1 must show
(a) ≥3-turn same-process sessions with initialize count 1, (b) perceptibly better first-token
latency than one-shot on turns ≥2, and (c) zero model-generated lifecycle prose in any thread
across at least one forced child kill. If (a)–(c) don't hold, or the P1.0 probe forces the
purge fallback AND the purge posture leaves any resumable provider transcript on any
termination path, Ben kills or re-scopes #1554 here. **#1558/#1559 stay blocked until Ben
passes this gate.** Phase 1 merges and ships alone regardless of later phases.

---

## Phase 2 — Lifecycle policy: state model, pool, reap, admin settings (coarse)

Child state machine (`launching → ready → (in-turn | awaiting-approval | idle) → reaping`) with
per-child lock + atomic state re-check before any kill; warm pool cap
(`chat.persistent_pool_cap`) with LRU eviction of `idle` children only; all-busy ⇒ fallback for
that turn; idle reap (`chat.persistent_idle_reap_minutes`); pool ownership in the PID-owning
process — cli-runner `EngineHost` (`engine-host.ts:162-181`) when `JARVIS_CLI_RUNNER_SOCKET` is
set, in-process runtime otherwise, both selected through the same `engine-selection.ts` fork
(lifts the phase-1 RPC pin). Settings registry entries + admin PATCH validation tests.
**e2e-P2 "reap is real":** fill pool past cap, verify eviction and 30-min reap with `ps`
process checks, not logs; reap revokes the session token (`revokeBySessionId`).

## Phase 3 — Failure & approval semantics (coarse; carries 4 spec acceptance scenarios)

Crash recovery: relaunch ≤ once per turn; auto-resubmit only provably-pre-acceptance (child
died before accepting the frame, zero tool activity); delivery-unknown ⇒ neutral failure, never
retried (maps to `CliChatDeliveryUnknownError`, manager `:434-440`); second death same turn ⇒
neutral failure. Cancel/reap terminally resolves ALL pending action requests
(`confirmation-registry.resolve(id, "cancelled")`, `:38-43`) BEFORE any kill; `awaiting-approval`
never reaped/evicted (bounded by the hook ladder, `claude-permission-hook.ts:17-19`). Token
rotation restarts the child.
Named e2es (live dev, each recorded on the PR):

- **e2e-P3a "gateway restart, same child":** restart api/MCP mid-session ⇒ the SAME child
  (unchanged PID) completes the next turn.
- **e2e-P3b "MCP down at launch":** MCP unreachable ⇒ no frame sent, neutral launch error
  (phase-1 admission re-proven under the pool).
- **e2e-P3c "late Approve cannot execute":** cancel a turn with a pending write approval, then
  click Approve ⇒ nothing executes (`resolve` returns false — no live waiter), audit row says
  cancelled.
- **e2e-P3d "no-prose relaunch":** kill the child mid-turn ⇒ recovery per rule, thread shows
  only the neutral failure or the clean resubmit; zero lifecycle wording (determinism boundary).

## Phase 4 — Rollout: instrumentation, drain, canary (coarse)

Counters through the existing `onDiagnostic` seam (`engine-selection.ts:27-40`) + structured
logs: child starts/exits by ReapReason, relaunch count, turn failures, first-token latency,
initialize count per session (expected 1) — never prompts/results/credentials. Flag-off drain
exercised live. Canary = Ben's dev instance, flag on, ~2-week stability window.
**e2e-P4 "drain under load":** flip flag off mid-session ⇒ in-flight turn completes, next turn
on fallback, children reaped + tokens revoked, no api restart.

## Phase 5 — Cleanup after stability (coarse; post-window)

Delete the one-shot-as-primary path + the rollout flag; bounded-fallback remains only as the
all-busy/no-adapter posture; remove dead vocabulary in the same pass (no stale
"structured one-shot" naming left behind). Unblocks #1558/#1559 to implement
`ProviderChatRuntime` for Codex/Gemini.

---

## Open questions (named owners)

1. **P1.0 probe outcome** — `--no-session-persistence` × persistent stream-JSON stdin. Owner:
   phase-1 builder (timeboxed; decision recorded in PR body). Not answerable from the tree.
2. **First-token latency threshold for the kill gate** — "perceptibly better" is Ben's call on
   the canary; no numeric SLO is set in the spec. Owner: Ben, at the gate.
3. **Pool-cap interaction with multi-surface actors** (drawer + module surface = 2 children for
   one actor): spec caps globally at 4; if canary shows one actor starving the pool, revisit as
   a fast-follow, not in-phase. Owner: Ben (observation), filed as an issue only if seen.

## Plan-build checklist (worked)

- [x] Gate 0: approved spec + task issue #1557, both cited in header
- [x] Seams check first; every assumed capability has a verified `file:line`; the one
      uncitable item is a named phase-1 verification with an owner
- [x] Decisions not implementations: contract signatures, exact settings keys, file paths,
      error-class mappings; no function bodies
- [x] Test cases stated as behaviour + why they'd fail against a broken implementation
- [x] Unpiped verification commands with expected exit codes; gate only via verify-gate skill
- [x] Kill gate after phase 1, named observation, owner Ben; phase 1 ships alone
- [x] Later phases coarse; each phase names its live-dev e2e
- [x] All four spec acceptance scenarios mapped: P3a (gateway restart same child), P3b (MCP
      down at launch), P3c (late Approve), P3d (no-prose relaunch); the other criteria land in
      P1/P2/P4 e2es
- [x] Determinism boundary restated (ruling 6) and enforced by e2e-P3d
- [x] Env/settings follow #1443 carve-out rules (MOSS\_-only new vars; values via RPC params,
      sanitized-env untouched) and the existing admin-settings registries — cited
- [x] Provider-agnostic invariant: neutral contract + vendor-free surfaces (ruling 7, tested)
- [x] No migration; no `AccessContext` changes; metadata-only logs/instrumentation
