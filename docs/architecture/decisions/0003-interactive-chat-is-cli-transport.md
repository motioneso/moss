# 0003 — Interactive chat is a CLI-transport feature

- **Status:** Superseded in part (interactive transport) by `docs/superpowers/specs/2026-10-10-api-key-chat-design.md`
- **Date:** 2026-06-08
- **Context:** Jarv1s Chat (epic) — Phase 1 (live runtime). See `docs/superpowers/specs/2026-06-08-jarvis-chat-design.md`.

## Decision

Interactive ("live drawer") chat is implemented as a **CLI-transport** feature: a persistent per-user tmux session driving the user's configured **CLI** provider (`claude` / `codex` / `gemini`), with its JSONL transcript streamed to the drawer. It is **provider-agnostic across CLI providers** — the capability router selects the user's active `chat` model, and no provider is hardcoded — but it does **not** support the `api_key` / HTTP transport for the interactive path.

The `api_key` (HTTP) transport remains for **non-interactive** capability use (M-A3's `HttpApiAdapter`, future briefings) and is a possible _future, degraded (non-live)_ interactive fallback — explicitly out of scope for this epic.

## Why

The live experience (a persistent session, `/clear`, transcript tailing, launch-time persona injection that survives `/clear`) is intrinsic to the CLIs and does not generalize to a stateless HTTP call. Forcing the interactive path to be transport-agnostic would either cripple it or require a parallel per-transport implementation. The "Provider-agnostic AI" invariant is still honored _within the CLI transport class_ (router-selected, no hardcoded provider).

## Security posture (verified by spike, 2026-06-08)

The chat CLI is agentic and is launched **locked down** — it can act _only_ through the (future, Phase 2) Jarv1s MCP server, never via host shell/files:

- **`--permission-mode default`** — the host's `~/.claude/settings.json` defaults to `bypassPermissions`; we override it explicitly so the session is **not** in bypass mode.
- **`--tools ""`** (empty allowlist) disables ALL native built-in tools. A denylist (`--disallowedTools`) was empirically proven bypassable (the model reached a shell via the `Monitor` tool), so the allowlist form is mandatory.
- **`--append-system-prompt-file`** injects the Jarvis persona at launch (verified to survive `/clear`).
- **`--session-id <uuid>`** pins the transcript filename, so its path is known pre-launch (no fragile newest-file globbing).
- **`--strict-mcp-config`** prevents the operator's global MCP servers from loading.
- Forwarded input has a leading `!` stripped (the interactive bash-prefix escape hatch).

Read/lookup capability is added back only via _specific bounded_ MCP tools (Phase 2). Running arbitrary code is a future **sandboxed exec** MCP tool, its own spec.

## Consequences

- A user must have a configured **CLI** chat provider to use interactive chat; an `api_key`-only provider cannot drive the live drawer.
- Per-CLI behavior differences (launch flags, transcript format, `/clear`) are absorbed by per-provider engine adapters (`packages/chat/src/live/cli-chat-engine.ts`); only `anthropic` is verified/available today (codex/gemini throw a clear "not yet supported" until verified).
