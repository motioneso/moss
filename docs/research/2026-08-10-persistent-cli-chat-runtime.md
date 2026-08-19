# Persistent subscription-authenticated CLI chat runtime

**Date:** 2026-08-10  
**Grounded on:** `74ed02ad0103` and Claude Code `2.1.226`  
**Question:** How should Moss provide reliable multi-turn chat and stable MCP access without calling
provider APIs directly?

## Recommendation

Replace Claude chat's per-turn `claude -p --resume` process with **one long-lived print-mode
subprocess per active Moss chat surface**, using `--input-format stream-json --output-format
stream-json`. Keep the database transcript as the durable source of truth and relaunch with bounded
Moss replay after a crash.

This is the smallest architecture that combines the useful parts of both current implementations:

- headless JSON events instead of terminal scraping;
- a live multi-turn process instead of one CLI startup per message;
- one MCP connection lifecycle per active chat session instead of rediscovery on every turn;
- the existing local Claude subscription credential, MCP config, tool allowlist, and `PreToolUse`
  policy hook.

Do **not** migrate Moss chat back to the interactive PTY and do not introduce the Agent SDK package
yet. The raw CLI already exposes the required transport, and Moss already uses that transport for
structured generation (`ClaudePrintChatEngine.launchStructured` / `submitStructured`). An SDK
migration adds a dependency without solving a missing capability.

## What the official sources establish

| Question                                            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can one CLI process accept multiple turns?          | Yes. Anthropic calls streaming input a persistent, interactive, long-lived process. It accepts queued messages sequentially, maintains conversation context, and keeps tools and custom MCP servers available. The CLI reference exposes `--input-format stream-json`; messages arriving while Claude is working remain queued as their own turns. [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md), [CLI reference](https://code.claude.com/docs/en/cli-reference.md) |
| Is this fundamentally different from the Agent SDK? | No. The SDK supervises a `claude` subprocess over stdio; one live session maps to one subprocess. Long-running hosts map each active session to a long-lived query/subprocess. [Hosting: subprocess model](https://code.claude.com/docs/en/agent-sdk/hosting.md#the-subprocess-model), [long-running sessions](https://code.claude.com/docs/en/agent-sdk/hosting.md#long-running-sessions)                                                                                                                     |
| What does `--resume` do?                            | It restores a persisted Claude conversation into a new invocation. It is useful after a process ends, but is unnecessary between messages while streaming stdin remains open. Session history does not restore process or filesystem state. [Sessions](https://code.claude.com/docs/en/sessions.md), [headless continuation](https://code.claude.com/docs/en/headless.md#continue-conversations)                                                                                                               |
| Will MCP stay connected?                            | Within a live subprocess, the session owns its MCP servers. Claude Code may lazily connect cached remote servers, and HTTP/SSE disconnects trigger up to five exponential-backoff reconnect attempts. A new subprocess necessarily establishes a new MCP lifecycle. [Claude MCP connection timing and reconnection](https://code.claude.com/docs/en/mcp.md#automatic-reconnection), [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp.md#connection-timing)                                        |
| How are permissions handled headlessly?             | Use explicit allowed tools, a permission mode, and hooks. SDK callbacks provide a richer pause/answer protocol, but Moss already has a `PreToolUse` hook that allows Jarv1s MCP discovery/calls and safe vault reads while denying everything else. Hooks run before the rest of permission evaluation. [Headless permissions](https://code.claude.com/docs/en/headless.md#control-tool-use), [SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input.md)                                         |
| Can subscription OAuth authenticate it?             | Technically yes. Claude Code supports subscription login, and `claude setup-token` produces a one-year `CLAUDE_CODE_OAUTH_TOKEN` for scripts; locally configured MCP servers still work. Use that documented command, not credential harvesting. [Authentication precedence](https://code.claude.com/docs/en/authentication.md#authentication-precedence), [setup-token](https://code.claude.com/docs/en/authentication.md#generate-a-long-lived-token)                                                        |

The MCP specification reinforces the process boundary: legacy sessions negotiate once per stdio
process or HTTP session, while transport bindings own their connection and cancellation behavior.
MCP itself does not promise that server state survives replacement of the host process.
[MCP lifecycle](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle.md),
[MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/index.md).

## Why the current modes are weak

### Current one-shot print mode

`ClaudePrintChatEngine.submit()` starts a detached process for every message. The first invocation
uses `--session-id`; later invocations use `--resume`. This avoids terminal scraping, but every turn
repeats process startup, settings loading, MCP discovery/connection, and shutdown. The observed
“112 deferred tools unavailable/available again” cycle is consistent with that lifecycle, but the
correlation should be verified using process IDs and `system/init` events before treating it as the
only cause. A genuinely unstable HTTP MCP endpoint would still reconnect inside a persistent
process.

### Existing interactive PTY mode

`CliChatEngineImpl` keeps an interactive Claude process alive in a multiplexer, so conversation and
MCP state are warm. Its cost is substantial accidental complexity: terminal readiness detection,
paste/submit verification, prompt and warning handling, transcript-file tailing, terminal control
for interruption, and provider-specific identity capture. The code history already records a
permission-mode warning that prevented the REPL from becoming ready. A browser chat should not be
coupled to terminal UI behavior when Claude offers a machine-readable transport.

### Persistent stream-JSON mode

Launch once, keep stdin/stdout open, send one JSON user frame per Moss turn, and use result events as
turn boundaries. This removes terminal automation and per-turn MCP churn. It does not replace Moss
durability: if the process or container dies, the app must start another process and replay the
bounded persisted thread. That also prevents a provider's local transcript format from becoming
Moss's system of record.

## Minimal target shape

1. One child process per active `(actor, chat surface)` session.
2. Launch with the existing persona file, strict HTTP MCP config, model override, `dontAsk`, allowed
   tool patterns, and the existing deny-by-default one-shot `PreToolUse` hook.
3. Keep stdin open. Write the documented user-message JSON shape followed by a newline.
4. Parse stdout JSONL incrementally: text deltas feed the UI; a terminal `result` closes the Moss
   turn; `system/init` records model/MCP health once per process.
5. Keep one in-flight Moss turn per surface. The CLI can queue messages, but Moss does not need that
   extra state until the UI supports intentional steering.
6. On idle reap, logout, or thread replacement: close/terminate the exact child and revoke its MCP
   token. On unexpected exit: relaunch once and rebuild context from Moss persistence.
7. Keep the current one-shot engine as a rollback mode during rollout; remove it only after measured
   stability.

For user cancellation, the first version may terminate and relaunch the subprocess with bounded
replay. Do not invent an undocumented raw control protocol. Adopt the SDK's interruption protocol
only if graceful mid-turn cancellation proves important enough to justify the SDK dependency.

## Authentication and policy boundary

The technical mechanism is supported, but its permitted scope matters. Anthropic says subscription
OAuth is for ordinary use of native Claude applications and says third-party developers may not
offer Claude.ai login or subscription rate limits in their products without prior approval. Agent
SDK products are directed to API-key or cloud-provider authentication.
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md#get-started),
[legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md#authentication-and-credential-use).

For now, limit this path to the owner's self-hosted Moss instance using the owner's own Claude Code
subscription. Do not expose “Sign in with Claude” to other Moss users or route their work through
the owner's subscription. Before this becomes a distributed or multi-user feature, obtain written
Anthropic approval or revisit provider authentication. This limitation applies whether Moss uses
the CLI directly or through the Agent SDK; changing libraries does not change the policy.

Store only the documented `claude setup-token` output in the existing `0600` credential file. Never
copy refresh credentials out of Claude Code's private credential store.

## Phased migration and proof

### Phase 0 — prove the incident mechanism

- Correlate each disconnect/reconnect notice with Claude child PID changes, `system/init` events,
  MCP gateway connection logs, and API/container restarts.
- Distinguish expected per-turn teardown from a gateway/network disconnect occurring while the same
  child PID remains alive.

### Phase 1 — bounded dev spike

- Reuse the existing raw stream transport already exercised by structured generation; add no SDK.
- Send at least three sequential turns through one child and prove exactly one `system/init` and one
  stable child PID.
- Enable the real Jarv1s MCP config and prove two turns can call tools without an unavailable/
  available cycle.
- Kill the child between turns and prove Moss relaunches with bounded DB replay and answers in the
  same Moss thread.

### Phase 2 — opt-in runtime

- Add a Claude execution mode for persistent print streaming behind configuration.
- Preserve the existing MCP token, permission hook, idle reaper, surface isolation, and rollback to
  one-shot.
- Instrument child starts/exits, init count, MCP status changes, first-token latency, relaunches, and
  turn failures without logging prompts, results, or credentials.

### Phase 3 — UAT and production canary

- UAT: multi-turn conversation, tool discovery, read tool, confirmation-gated mutation, denial,
  cancellation/relaunch, MCP gateway restart, CLI crash, API restart, and container restart.
- Dev: one real subscription-authenticated session with Haiku and the production-shaped HTTP MCP
  gateway.
- Canary in production for the owner only. Success means one CLI/MCP initialization per active
  session, no ambient tool-cycle notices during ordinary turns, lower warm-turn latency, and no
  regression in confirmation or replay behavior.

## Decision

Use **persistent headless CLI streaming** as Claude chat's primary runtime. It is already supported
by the installed CLI, already partially implemented in Moss, and removes the two weakest pieces of
the current design: per-turn process churn and terminal UI automation. Keep Moss persistence and
permission enforcement authoritative, and keep subscription use owner-only until Anthropic confirms
a broader product use.
