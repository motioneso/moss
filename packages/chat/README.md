# @moss/chat

The chat module: REST + live (terminal-CLI-backed) chat. Live sessions are driven through a portable
`Multiplexer` seam (`@moss/ai`) so a deployed instance can use whichever multiplexer the host
provides (tmux or herdr), selected by the admin `chat.multiplexer` instance setting with PATH
auto-detection (ADR 0008).

## Known security limitation — shared-uid

All live chat sessions run as **one OS user** (the shared uid the API/worker process runs as). This
has two distinct boundaries:

- **The agent path is contained.** An injected prompt reaching the CLI has no native file or shell
  primitive: every session launches with `--tools ""` / an MCP allowlist + `--strict-mcp-config`, so
  the model can only reach the allowlisted `mcp__jarvis__*` tools (themselves RLS-scoped to the
  acting user). `sanitizeInput` strips the leading-`!` shell escape on the programmatic input path.
- **The human-attach path is NOT contained by uid.** A human who **already holds a shell as the
  shared uid** can `attach` to any live session and read any user's neutral dir / CLI auth material.
  This is inherent to running every user's session under one OS account.

**Mitigations today:** host-shell access is the operator's own (the operator already controls the
box); per-user neutral dirs are created with mode `0700`; connector/AI secrets are AES-256-GCM
encrypted at rest and never placed in prompts, pg-boss payloads, logs, or exports.
Codex MCP tokens are written to a per-session env file under the neutral dir with mode `0600`,
referenced by path from the launch command, and removed when the session is killed.

**The real fix is the deferred uid-per-user milestone** — true OS-user isolation per chat user. The
`0700` neutral dirs and the `TmuxIo` env/cwd + `transcriptGlobDir` homeBase seams are the
forward-compatibility hooks for that work.

See `docs/superpowers/specs/2026-06-12-p2-portable-cli-chat-adapter-design.md` §8.

## Assistant action restart cleanup

Pending write/destructive tool approvals are in-memory waits. On API startup, Jarv1s cancels
pending action requests older than the startup grace window so a restart leaves visible terminal
`cancelled` rows instead of approvals that can never resume. Fresh pending rows stay pending.

## Cold-start replay

A fresh provider session replays the conversation's accepted summary plus every stored turn the
summary does not cover. Nothing is dropped silently: if that does not fit the launch budget, the
launch refuses with an actionable message and queues a summary run.

- `JARVIS_CHAT_REPLAY_K` (default 40): newest uncovered turns kept raw when a summary run is planned.
  A run starts once more than twice this many turns, or more than the raw token allowance, sit
  outside the summary.
- `JARVIS_CHAT_REPLAY_TOKENS` (default 8000): replay budget. Raw turns kept beside a summary stay under half of it,
  and never more than a launch with a full seed and summary can still fit.

A live provider session also hands off on its own. The app estimates everything one session was
sent and returned: launch input, seeded context, prepared turns and every transcript record,
tool output included. Reported output usage can raise that count but never lower it. Before a
turn would pass the budget, the next admitted turn relaunches that exact session for the same
owner, conversation and provider, replaying the accepted summary plus every uncovered turn. With no
accepted summary, or a replay that would not fit, the healthy session keeps serving and a summary
run is requested. Private chats never hand off. This is the app's own handoff; it does not detect
or handle a vendor's context limit.

- `JARVIS_CHAT_SESSION_BUDGET_TOKENS` (default 64000): app-counted tokens one provider session may
  hold. It sits well under the smallest supported economy model window because vendor system
  prompts and tool definitions use context the app cannot see.

## Deferred — agent-path PreToolUse policy

A Claude Code `PreToolUse` hook (deny any tool call that is not an allowlisted `mcp__jarvis__*` call),
provisioned into the anthropic neutral dir, as **defense-in-depth behind the already-locked
`--tools ""` / `--allowedTools` launch flags**.

This is **deferred from v1** because:

- The programmatic input path is already neutralized — `sanitizeInput` strips the `!`-escape.
- Native tools are already denied at launch flags (`--tools ""` / the MCP allowlist).
- It is provider-specific (Claude only — Codex `--sandbox read-only` and Gemini
  `--allowed-mcp-server-names jarvis` already block at launch).
- Fail-closed semantics + cross-engine scope need their own design.

Tracked as a follow-up issue under epic #47.

## Private chat support scope

Private chat mode currently supports Claude and interactive Codex only. Gemini and the
non-interactive Codex/Codex-exec cleanup gap are tracked separately in #868 (Part of #744).
