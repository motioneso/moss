# Buzz chat runtime comparison for #1554

**Date:** 2026-08-10  
**Buzz source:** `01c23810fa7f`  
**Moss comparison:** [persistent CLI chat runtime](./2026-08-10-persistent-cli-chat-runtime.md)

## Recommendation

Keep #1554's persistent-process direction, but borrow Buzz's **ACP-style supervisor shape**, not
its entire bundled application architecture.

Buzz validates the central diagnosis: reliable chat is built around a long-lived, machine-readable
agent process with stable sessions, bounded cancellation, crash recovery, and a durable application
message log. It does not launch `claude -p --resume` for every turn. Moving Moss to a desktop bundle
is unnecessary to obtain those properties; a self-hosted Moss server can supervise the same kind of
long-lived child process. Bundling should remain a separate product decision about local ownership,
installation, and credential policy—not a prerequisite for fixing chat transport.

For the first #1554 implementation, raw Claude `stream-json` remains the smallest solution because
Moss has one immediate Claude transport problem and already has its own chat, MCP, persistence, and
approval contracts. ACP becomes attractive when Moss genuinely needs several interchangeable local
agent runtimes behind one protocol.

## What Buzz actually does

```text
React composer
  -> signed Nostr channel event
  -> relay/Postgres + WebSocket fan-out
  -> long-lived buzz-acp harness
  -> persistent ACP provider subprocess over NDJSON stdio
  -> agent explicitly publishes a signed Buzz reply
  -> relay/Postgres + live React timeline
```

This is not a conventional browser-to-model chat endpoint. The human posts a durable channel
message. An independently authenticated agent notices the event, receives an ACP prompt, uses tools,
and explicitly publishes a new durable channel message.

### Frontend and durable timeline

- The composer submits through the ordinary message pipeline
  (`~/buzz/desktop/src/features/messages/ui/MessageComposer.tsx:599`,
  `~/buzz/desktop/src/features/messages/hooks.ts:400`). Plain messages use the relay WebSocket;
  replies/media use the validated Tauri/REST path. Both optimistically update the React Query cache.
- The relay authenticates the Nostr signer and persists accepted messages as Postgres events
  (`~/buzz/crates/buzz-relay/src/handlers/event.rs:603`,
  `~/buzz/crates/buzz-db/src/event.rs:253`).
- The desktop loads a stored channel window, merges live WebSocket events, and refreshes the visible
  channel after reconnect (`~/buzz/desktop/src/features/messages/hooks.ts:229`).
- Provider text chunks are **not** automatically treated as assistant chat. Buzz records ACP wire
  activity in a separate encrypted observer stream; human-visible responses exist only when the
  agent deliberately runs `buzz messages send`
  (`~/buzz/crates/buzz-acp/src/base_prompt.md:45`,
  `~/buzz/crates/buzz-acp/src/acp.rs:1535`). This is a useful strict boundary between diagnostic
  model output and the authoritative chat record.

### Process and session lifecycle

- Buzz Desktop launches one managed `buzz-acp` harness per configured agent and injects its relay
  identity, runtime command, policy, and optional MCP command
  (`~/buzz/desktop/src-tauri/src/managed_agents/runtime.rs:454`).
- The harness launches a provider once with piped stdin/stdout, process-group isolation,
  `kill_on_drop`, and bounded NDJSON lines (`~/buzz/crates/buzz-acp/src/acp.rs:408`). It initializes
  ACP once, then sends `session/new` and later `session/prompt` requests over the same stdio process.
- A pool slot keeps a map of `channel_id -> session_id`; turns in the same channel preferentially
  return to the process holding that session (`~/buzz/crates/buzz-acp/src/pool.rs:81`,
  `~/buzz/crates/buzz-acp/src/lib.rs:2890`). Thus the provider process and its channel session persist
  across turns.
- Sessions rotate on explicit `!rotate`, max-token/request stop reasons, or an optional turn limit
  (`~/buzz/crates/buzz-acp/src/pool.rs:2050`). Process failures invalidate the in-memory session map,
  requeue eligible work, and respawn with backoff/circuit breaking
  (`~/buzz/crates/buzz-acp/src/lib.rs:3035`, `:3629`).

This is materially stronger than Moss's per-turn `claude -p --resume`: process startup, model
initialization, tool discovery, and MCP lifecycle are amortized across many turns.

### Replay and memory

Buzz separates three kinds of continuity:

1. **Durable conversation:** every channel message is a stored relay event.
2. **Warm provider context:** the live ACP session retains turn history while its process survives.
3. **Rebuilt prompt context:** on a new turn, the harness may fetch up to 12 recent messages by
   default, but only for DMs and thread replies
   (`~/buzz/crates/buzz-acp/src/config.rs:363`,
   `~/buzz/crates/buzz-acp/src/pool.rs:2556`). Plain top-level channel messages receive no automatic
   history window.

Buzz therefore does **not** fully solve Moss's same-thread crash continuity problem. After a provider
crash, its cached ACP session IDs disappear; there is no `session/load` or `session/resume` path in
the harness. DMs/threads get a bounded reconstruction, while ordinary channel continuity relies on
the agent's own recovery tools and persistent memory. Buzz's base prompt explicitly tells a restarted
agent to inspect its feed, channel messages, todos, and memory (`~/buzz/crates/buzz-acp/src/base_prompt.md:95`).

The reusable lesson is the separation of durable app history from warm provider state—not Buzz's
current replay coverage. Moss should keep its database transcript authoritative and deliberately
replay a bounded same-surface window whenever a persistent child is replaced.

### MCP and tools

- ACP `session/new` can carry stdio MCP server definitions. Buzz injects relay credentials into an
  optional MCP child (`~/buzz/crates/buzz-acp/src/lib.rs:4142`).
- Current first-party managed agents increasingly use the bundled `buzz` CLI directly; runtime
  metadata calls the single MCP command field vestigial
  (`~/buzz/desktop/src-tauri/src/managed_agents/discovery/runtime_metadata.rs:2`).
- The agent and its tools remain attached to the persistent provider process rather than being
  rediscovered every human message. This is the direct analogue of #1554's goal of stopping the
  constant Jarv1s MCP unavailable/available cycle.

Moss should copy the lifecycle property, not Buzz's tool surface. Moss already has an HTTP MCP
gateway, actor scoping, confirmation records, and vault policy that should remain authoritative.

### Streaming and observer UI

ACP streams `session/update` notifications for text, thoughts, plans, tool calls, and tool status.
Buzz publishes these as owner-scoped encrypted observer events and renders them in a separate agent
transcript (`~/buzz/crates/buzz-acp/src/observer.rs:1`,
`~/buzz/desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx:79`). Observer events are
ephemeral at the relay, with bounded in-process/reconnect buffers; the durable user conversation
remains the signed message timeline.

This separation is worth copying conceptually. Moss can stream model deltas into its existing
in-progress turn UI while committing only the final normalized assistant message and tool/action
records to its durable transcript.

### Cancellation and approvals

- Owner controls identify the exact channel turn. ACP `session/cancel` is followed by a bounded drain;
  cancellation failures invalidate the session or process, and eligible input is requeued
  (`~/buzz/crates/buzz-acp/src/acp.rs:755`,
  `~/buzz/crates/buzz-acp/src/pool.rs:1882`).
- New messages can queue, interrupt, or steer an active turn. Goose has a native steer extension;
  other runtimes fall back to cancel-and-merge (`~/buzz/crates/buzz-acp/src/lib.rs:2705`).
- Buzz is **not** a model for Moss's approval UX. Its harness automatically chooses ACP
  `allow_once` when offered, otherwise `reject_once`
  (`~/buzz/crates/buzz-acp/src/acp.rs:1688`), and its default permission mode is bypass-oriented.
  The observer UI displays permission activity but does not provide Moss-style browser approval and
  continuation.

Moss must retain its confirmation boundary. A persistent Claude child should pause or terminate at
the existing confirmation seam; it must not inherit Buzz's auto-approval behavior.

### Authentication and bundled-app assumptions

Buzz's bundle makes several things easier:

- one local OS user owns the app, provider CLI login, child processes, workspace, and agent secrets;
- Tauri can install/probe adapters, supervise exact PIDs, and keep provider traffic off a hosted
  multi-tenant service;
- each Buzz agent has a distinct Nostr key and owner relationship at the relay.

For Claude, Desktop discovers `claude-agent-acp`, checks `claude auth status`, and points to the
installed CLI (`~/buzz/desktop/src-tauri/src/managed_agents/discovery.rs:99`). However, Buzz's own
standalone harness documentation still instructs `ANTHROPIC_API_KEY` and says the adapter wraps the
Claude Agent SDK (`~/buzz/crates/buzz-acp/README.md:83`). Buzz therefore is not sufficient evidence
that subscription authentication is supported for a distributed third-party product. #1554's
owner-only, self-hosted limitation remains necessary regardless of whether the host is a server or
desktop bundle.

## Reusable patterns versus bundled-only choices

| Pattern                                                    | Use in Moss?              | Why                                                                                                                             |
| ---------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Long-lived machine-readable provider child                 | Yes                       | Directly fixes per-turn CLI/MCP churn.                                                                                          |
| Stable application session -> provider session mapping     | Yes                       | Gives warm context and surface isolation.                                                                                       |
| Durable app transcript independent of provider process     | Yes                       | Required for crash recovery and auditability.                                                                                   |
| Bounded line parsing, deadlines, exact-child cleanup       | Yes                       | Production-grade subprocess supervision.                                                                                        |
| Backoff/circuit breaker and bounded requeue                | Later, minimal form first | Add after the basic persistent child is proven; avoid porting Buzz's large pool prematurely.                                    |
| Separate transient stream/observer state from durable chat | Yes                       | Prevents ambient lifecycle text from becoming assistant prose.                                                                  |
| ACP runtime abstraction                                    | Not initially             | One Claude runtime does not justify an adapter layer. Add when a second real runtime needs it.                                  |
| Nostr channel/event topology                               | No                        | Moss already owns threads, turns, actions, and actor-scoped persistence.                                                        |
| Agent-explicit `buzz messages send` response boundary      | Concept only              | Moss should normalize final CLI result events itself; requiring its assistant to call a chat-send tool would add failure modes. |
| Buzz auto-approval                                         | No                        | Conflicts with Moss confirmation invariants.                                                                                    |
| Desktop-managed provider credentials                       | Optional future direction | Helpful for local-first distribution, but not required for the owner-operated server.                                           |

## Decision for #1554

1. Proceed with one persistent Claude `stream-json` child per active Moss surface.
2. Structure its manager like a small, single-runtime version of Buzz's ACP supervisor: explicit
   states, stable surface affinity, one in-flight turn, bounded parsing/deadlines, exact cancellation,
   idle reap, and one bounded crash restart.
3. Keep Moss's DB transcript, MCP gateway, authorization, and confirmation system authoritative.
4. On replacement, replay a bounded persisted same-surface window; do not rely on provider session
   files alone and do not copy Buzz's DM/thread-only context gap.
5. Record streamed lifecycle/tool events separately from durable assistant prose.
6. Reconsider ACP only when Moss supports multiple local CLI runtimes. Reconsider a bundled desktop
   host only if local credential ownership and offline/local-first deployment become product goals.

Buzz strongly supports changing Moss's **runtime lifecycle**. It does not establish that Moss must
change its packaging, conversation model, approval boundary, or system of record.

## Primary references

- [Agent Client Protocol overview](https://agentclientprotocol.com/overview/introduction)
- [ACP protocol](https://agentclientprotocol.com/protocol/overview)
- [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Buzz ACP harness README](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- Buzz source paths and line anchors cited inline, grounded on `01c23810fa7f`.
