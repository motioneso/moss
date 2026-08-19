# Persistent provider chat runtime

**Date:** 2026-08-10

**Status:** Draft, revised 2026-08-10 after Codex adversarial review
(`docs/coordination/2026-08-10-1553-1554-codex-review.md`) — pending Ben sign-off

**Parent issue:** #1554. Depends on the replay contract in
`2026-08-10-1553-context-continuity-and-notes-retrieval.md` (crash recovery consumes it, never
redefines it).

**Grounded on:** `origin/main` = `128a5bed6`; issue #1554 body + comments (including the binding
provider-agnostic ruling, 2026-08-10 22:15Z); `docs/research/2026-08-10-persistent-cli-chat-runtime.md`;
`docs/research/2026-08-10-buzz-chat-runtime-comparison.md`; Phase-0 spike
`docs/research/2026-08-10-1554-phase0-spike.md` (CLI 2.1.227, both legs CONFIRMED).

## Decision summary

Replace per-turn one-shot CLI execution with **one long-lived headless provider process per
(actor, chat surface)**, speaking newline-delimited stream-JSON over piped stdio, held open across
turns. The process — and therefore its MCP session — survives between messages, which removes the
per-turn connect/teardown window entirely. This is the endgame replacement for the `-p` flow;
one-shot survives only as a rollback behind a single config flag until measured stability, then
both the one-shot path and the flag are deleted.

A **provider-neutral lifecycle contract** is defined first; the Claude adapter implements it with
the spike-proven persistent transport, and the existing one-shot engine is re-badged as the
contract's **bounded fallback**, which Codex and Gemini keep using unchanged until fast-follow
parity issues give them persistent transports of their own.

## Evidence (Phase 0, complete)

The spike (2026-08-10, dev box, no prod contact) settled the mechanism questions:

- **Churn confirmed:** 3 one-shot turns = 3 server-side MCP `initialize` + 3 `tools/list`, even on
  a turn that called no tool. The persistent child: 1 PID, exactly 1 `initialize` across 3 turns,
  MCP tool calls succeeding on turns 1 and 3, graceful SIGTERM exit, no orphan.
- **The leak is model prose, not a notice.** During a connection-failure window the jarvis tools
  silently vanish and the model _narrates_ their absence in its own words. There is no string to
  filter; the only fix is eliminating the window. This spec therefore contains **no text
  filtering** anywhere.
- **One-shot is structurally blind to MCP failure:** exit 0, `result.subtype: success`,
  `is_error: false`, and zero `mcp_servers` records in the transcript the engine parses. Prod
  looked healthy while failing.
- **The persistent path degrades better:** with the MCP server killed mid-session, tools stayed
  exposed, the model reported a transient connection error, and it self-healed on the next turn —
  same process, no relaunch.
- **Health-signal traps:** `system/init` is emitted _per turn_ on the persistent path (stream
  framing, not lifecycle) and `init.mcp_servers` goes stale after turn 1. Health and tests must
  use per-turn `result` fields and server-side handshake counts, never init events.
- **Guard traps:** `--allowedTools` is a permission allowlist, not a tool-set restriction (31
  built-ins remain exposed) — the deny-by-default `PreToolUse` hook is the sole real guard and
  stays mandatory. `--strict-mcp-config` does not fail closed on an unreachable server.
- **Clients never send a session DELETE** — they drop the socket. The server-side MCP session
  store needs a TTL.

## Goals (from #1554's "done")

1. MCP tools stay available across an active chat session — one handshake per session, not per turn.
2. Provider/host lifecycle events never appear as user-facing assistant content.
3. Provider process death has explicit, bounded recovery.
4. Action-request approval and continuation keep working unchanged.
5. No direct provider API credentials; existing owner-only `setup-token` auth posture unchanged.

## Non-goals

- Agent SDK, ACP adapter layer, desktop bundling, direct-API billing/auth (all ruled out in the
  issue thread).
- Reviving the interactive PTY path.
- Mid-turn graceful cancellation protocols (v1 cancels by terminate + relaunch; an SDK-style
  interrupt is a later cost-justified decision).
- Multi-user auth widening (gate remains written Anthropic approval).
- CLI-side prompt queueing (turn serialization is Moss's job; the spike did not certify
  concurrent stdin frames).

## The provider-neutral contract

Per the binding ruling: product UI, user-facing status, user-facing logs, and acceptance language
say _Moss / assistant / model / provider_. Vendor names appear only in adapter code, provider
settings, operator diagnostics, and provider-specific tests.

The session manager owns a neutral lifecycle contract — the same seam `engine-selection.ts`
already guards (its header records the two-composition-roots outage; both roots, in-process and
cli-runner RPC, must resolve engines identically):

- `launch(surface, persona, tools, replayWindow)` — start or adopt a warm engine for
  (actor, surface); replay window comes from the #1553 contract.
- `submitTurn(text)` — exactly one in-flight turn per surface, serialized by the manager.
- `streamEvents()` — deltas for the live UI; a terminal per-turn result closes the turn and is
  the _only_ source of durable assistant content and health fields.
- `cancel()` — v1: terminally resolve any pending action requests (see lifecycle policy), then
  terminate the child and relaunch with bounded replay.
- `health()` — derived from per-turn results (`is_error`, stop/terminal reason, latency, usage)
  and process liveness; never from provider init banners.
- `reap()` — clean shutdown (SIGTERM to the process group), MCP token revoked immediately.
- `recover()` — bounded relaunch policy below.

**Two implementations at v1:** `persistent` (Claude adapter) and `bounded-fallback` (today's
one-shot engine, unchanged behavior, re-labeled). Engine selection: if the provider has a
persistent adapter **and** the rollout flag is on → persistent; otherwise bounded fallback. The
`provider_execution_mode` column is untouched — no migration; the fallback limitation never
surfaces in product vocabulary.

## Claude adapter

Extends the existing `launchStructured` transport (`claude-print-chat-engine.ts:84-110`) with the
chat args from `buildCommand`. Spike-proven launch shape (CLI 2.1.227):

```
claude --print --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose --session-id <uuid> \
  --permission-mode dontAsk --mcp-config <neutralDir>/mcp.json \
  --settings <neutralDir>/settings.json --allowedTools 'mcp__jarvis__*' <vault read-only> \
  --append-system-prompt-file <persona> --strict-mcp-config
```

(The block shows the _fallback_ session-identity posture — `--session-id <uuid>`, as the spike
ran it. The preferred posture swaps that for `--no-session-persistence`, pending the phase-1
verification below.)

Deltas from `launchStructured`: drop `--tools ""` and `--json-schema`; add the MCP-config,
settings, allowlist and persona args. Piped stdio (the one-shot path's `detached + stdio:ignore`
spawn is not reused). One `{"type":"user",...}` frame per Moss turn; the manager waits for that
turn's terminal result frame before accepting the next frame.

**Conversation truth and provider-session identity:** the DB transcript is the sole source of
conversation truth. A provider-side transcript is never resumed and never adopted; every launch is
a fresh provider session fed by bounded DB replay (the #1553 replay contract). _Preferred
posture:_ keep `--no-session-persistence`, so no resumable provider transcript is written at all.
Whether the CLI supports that flag combined with persistent stream-JSON input is a bounded phase-1
verification item — the spike dropped the flag without testing that combination. _Fallback
posture_ if it turns out to be unsupported: a fresh random `--session-id` per launch, never
reused, with the provider session file purged on every termination path (reap, crash, cancel,
shutdown).

**Stream decoding is bounded:** the persistent transport uses a consuming incremental line decoder
with a maximum frame size and a total buffer bound. The current `launchStructured` accumulates
stdout forever (`claude-print-chat-engine.ts:84-110`, re-sliced at `:126-141`) and must not be
reused as-is. A malformed line is logged and skipped. A bound exceeded ⇒ the child is killed and
the turn fails neutrally (fail closed). stdout EOF without a terminal result ⇒ the turn fails
neutrally. Events are pushed to the session manager as parsed — the transcript-file
`readNew()`/offset-polling path is not part of the persistent flow (the DB transcript remains the
system of record, written from terminal results exactly as today).

## Lifecycle policy

- **Warm pool:** at most **4** warm children instance-wide (admin setting, default 4, validated on
  save). At the cap, launching a new surface's child evicts the least-recently-used child **in
  `idle` state** via clean `reap()`. If no child is idle, the new surface's turn runs on the
  bounded-fallback (one-shot) engine for that turn — there is no queueing, and a busy child is
  never evicted.
- **Pool ownership:** the child registry, the state machine and the LRU bookkeeping live in the
  process that owns the child PIDs — the cli-runner host when the RPC root is active, the
  in-process runtime otherwise. Both composition roots reach it through the single
  engine-selection seam (`engine-selection.ts`, whose file header records the two-roots divergence
  outage). The cap is enforced only by the PID owner; no other process keeps a count.
- **Child state model:** `launching → ready → (in-turn | awaiting-approval | idle) → reaping`.
  Only a child in `idle` is a reap or eviction candidate. `awaiting-approval` can outlast the idle
  window (cf. the 150 s confirmation wait, `claude-permission-hook.ts:17-19`) and is never treated
  as idle. Reap and evict take a per-child lock and atomically re-check state immediately before
  the kill.
- **Admission (fail closed):** before the first user frame is sent to a new child, server-side
  readiness is required — the MCP session for that child's token is initialized and the required
  tools are listed. No readiness ⇒ the child is destroyed, a neutral error is returned, and the
  frame is never sent. This closes the spike's tool-less "success" window; `--strict-mcp-config`
  does not fail closed and is not sufficient.
- **Idle reap:** a child in `idle` state with no turn activity for **30 minutes** (admin setting,
  default 30) is reaped; only idle children are reap candidates. Next message relaunches
  transparently with #1553 replay. Reap revokes the child's MCP token immediately, as today.
- **Crash recovery:** unexpected child exit → relaunch **once per turn** with bounded replay. The
  in-flight user frame is auto-resubmitted **only when the failure is provably pre-acceptance** —
  the child died before accepting the frame and there was no tool activity for that turn —
  mirroring the delivery-unknown vs. verifiably-unavailable distinction the session manager
  already draws (`chat-session-manager.ts:423-440`). Delivery-unknown — the frame was accepted, or
  any tool call occurred (an approved write may execute before a terminal result exists,
  `gateway.ts:580-626`) — fails the turn neutrally ("Something went wrong — try again"); it is
  never silently retried, and the relaunched child stays warm for the next message. A second death
  within the same turn fails the same neutral way. No retry loops, no backoff ladders in v1.
  Recovery emits structured log events only — nothing in the thread (Ben's ruling: logs only).
- **Approval continuation:** unchanged block-in-tool-call semantics. The child's MCP tool call
  blocks on the gateway's confirmation waiter (waits at `gateway.ts:332-335` and `:548-551`; the
  fail-closed timer is `confirmation-registry.ts:15-30`); the surface's single turn slot is held
  meanwhile, exactly as today. A child in `awaiting-approval` is never reaped and never evicted.
  Async park/resume is explicitly a future story.
- **Cancel/termination resolves approvals:** before any kill — cancel, reap, eviction, crash
  cleanup, shutdown — every pending action request bound to that session is terminally resolved
  (cancelled). Otherwise the waiter outlives the child and a late Approve still executes the
  handler (`gateway.ts:548-609`). Acceptance includes a late-Approve test.
- **Incognito lifecycle:** an incognito child never leaves a resumable provider transcript behind —
  under the preferred posture no session file is written at all; under the fallback posture the
  session file is purged on every termination path (reap, crash, cancel, shutdown). Relaunch
  replays nothing (per #1553). The existing purge-guard refusal (`chat-session-manager.ts:248-253`)
  stays: a private chat may not launch on an engine that cannot purge. Acceptance includes a
  disk-level check after crash, reap and cancel.
- **Token rotation:** an MCP token rotation restarts the child (reap + relaunch with replay).
  Rotation is rare; no hot-reload protocol.
- **Server-side TTL:** the Moss MCP handler's session store expires sessions on a TTL (idle-reap
  window + margin), since clients drop sockets without a DELETE.
- **Shutdown/logout/thread replacement:** exact-child termination, token revocation — semantics
  carried over from the one-shot manager.

## Settings

Admin, instance-wide (never per-user — these govern host RAM): max warm children (default 4),
idle reap minutes (default 30). Surfaced in the existing admin settings area per the module
settings conventions.

## Rollout

- **Flag:** one boolean config flag (admin/ops scope, e.g. `chat.persistentRuntime`), default
  **off** at merge. No DB migration; no third `provider_execution_mode` value.
- **Flag-off is a lifecycle transition:** flipping the flag off makes new launches select the
  bounded fallback immediately; in-flight turns drain to completion; the warm children are then
  reaped and their MCP tokens revoked. "Without restart" means no Moss process restart is needed —
  not that warm children keep serving. Both the idle-flip and the in-flight-flip cases are tested.
- **Canary:** flag on for Ben's instance (owner-only dogfood). Instrumentation watched: child
  starts/exits, relaunch count, turn failures, first-token latency, server-side `initialize`
  count per session (expected: 1). Never prompts, results, or credentials.
- **Exit criteria to delete one-shot + flag:** after a stability window on the canary (proposal:
  2 weeks) with zero lifecycle-prose incidents, relaunch rate within bound, and no unexplained
  turn failures, a follow-up task removes the one-shot engine, the flag, and this spec's
  fallback labeling. Rollback at any point = flip the flag; no deploy.
- **Fast-follow parity:** task issues filed at wrap-up for Codex and Gemini persistent adapters
  behind the same contract.

## Acceptance criteria

1. One CLI process serves ≥3 consecutive turns of a real UI chat on the live dev instance; MCP
   session reused (server-side `initialize` count = 1 for the session).
2. A real read tool and a browser-approved write tool both complete on the persistent path.
3. Forced provider interruption mid-session recovers per the crash-recovery rule: exactly one
   relaunch with bounded replay (per #1553); the in-flight frame is resubmitted only when the
   failure is provably pre-acceptance, and a delivery-unknown death fails the turn neutrally
   instead of being retried. Zero lifecycle wording in any assistant message.
4. Reap/eviction: idle child reaped at the window, next message transparently relaunches; cap
   eviction reaps LRU cleanly (no orphan processes — verified with process checks, not logs).
5. Rollback: flipping the flag off returns the surface to one-shot behavior without restart.
6. Regression tests assert on process identity and server-side handshake counts — never on
   `system/init` event counts (spike: per-turn framing) or `init.mcp_servers` (spike: stale).
7. Live-path evidence on the PR per the gate; no secrets/personal transcript in evidence.
8. Gateway/MCP restart mid-session: the **same** child recovers on a later turn — no relaunch
   (process identity unchanged), tools keep working, and zero lifecycle wording in the thread.
9. MCP unreachable at launch: no user frame is sent, the surface returns a neutral error, and no
   tool-less "successful" reply is produced.
10. Cancel or reap with a pending approval: the approval is terminally resolved, and a subsequent
    Approve does not execute the tool.

## Security posture (unchanged, restated as blocking review points)

- Deny-by-default `PreToolUse` hook remains the sole effective tool guard (`--allowedTools` is
  permission-scoped only); any change weakening the hook is a blocker.
- Owner-only `CLAUDE_CODE_OAUTH_TOKEN` in the existing 0600 file; no refresh-credential
  harvesting; no direct API keys.
- MCP tokens: per-session, revoked on reap; rotation restarts the child.
- Instrumentation and logs carry counts, ids, and durations — never prompt or reply content.
