# #1554 Phase-0 spike — per-turn MCP churn vs. a persistent CLI child

**Date:** 2026-08-10 · **Environment:** dev box only, no prod contact · **CLI:** `claude` 2.1.227
**Scope:** Leg A (prove churn on the one-shot path) and Leg B (prove the persistent alternative).
The bounded-DB-replay leg is out of scope — it belongs to #1553's regression test.

---

## Verdicts

| Leg          | Claim                                                                                        | Verdict                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A            | Per-turn process teardown causes a full MCP client re-handshake every turn                   | **CONFIRMED**                                                                                               |
| B            | One long-lived child serves N turns with a single MCP handshake and working tools throughout | **CONFIRMED**, with one sub-claim refuted                                                                   |
| B, sub-claim | "exactly one `system/init` event total"                                                      | **REFUTED** — a persistent child emits one `init` per turn                                                  |
| Hypothesis   | Lifecycle notices leak into assistant prose                                                  | **CONFIRMED but re-explained** — the prose is model-generated, not a CLI notice. See "What actually leaks". |

---

## Method and one deliberate substitution

The production spawn seam is `packages/chat/src/live/claude-print-chat-engine.ts` —
`buildCommand()` (~:245-283) for the one-shot path, `launchStructured()` (~:84-110) for the existing
persistent transport.

**Substitution:** I did not use the live dev `/api/mcp` endpoint. Its `jst_` tokens are minted
in-process by `SessionTokenRegistry` (`packages/ai/src/gateway/session-tokens.ts`) and are not
obtainable from outside the API, and there is a standing rule against minting one to probe the MCP
surface. Instead I ran a **local instrumented HTTP MCP server on 127.0.0.1** using the byte-identical
config shape `writeClaudeMcpConfig()` writes (`type: "http"`, `Authorization: Bearer <token>`,
`timeout: 180000`), with a locally generated `jst_`-shaped bearer that is not a real credential.

This is strictly better evidence for the question at hand: it lets me count `initialize` handshakes,
`tools/list` calls and TCP connections **server-side**, which the real endpoint could not have told
me. It does mean the spike proves the _CLI-side transport lifecycle_, not the behaviour of Moss's own
MCP handler. Nothing here depends on the server implementation.

The permission-hook settings file is a shape-faithful stand-in for
`writeClaudeOneShotPermissionHook()` — same `--settings` file with a `PreToolUse` command hook, but
the hook always returns `allow` instead of running the real vault-root decision. Lifecycle is
unaffected.

All artifacts (stream JSONL per turn, server log, ps snapshots) are under the session scratchpad at
`…/scratchpad/spike/logs/`.

---

## Leg A — one-shot path, three sequential turns

Three separate processes, each shaped like `buildCommand()`: `-p`, `--session-id <uuid>` on turn 1
then `--resume <uuid>`, `--permission-mode dontAsk`, `--mcp-config`, `--settings`,
`--allowedTools 'mcp__jarvis__*'`, `--append-system-prompt-file`, `--strict-mcp-config`. I appended
`--output-format stream-json --verbose` purely to capture the event stream; it changes stdout
serialization only, not process or MCP lifecycle.

**Client-side, per turn:**

| Turn | Session flag   | `system/init` events | `mcp_servers` at init   | tools exposed | tool call                            |
| ---- | -------------- | -------------------- | ----------------------- | ------------- | ------------------------------------ |
| 1    | `--session-id` | 1                    | `[{jarvis, connected}]` | 31            | `mcp__jarvis__moss_ping`             |
| 2    | `--resume`     | 1                    | `[{jarvis, connected}]` | 31            | none (answered from resumed context) |
| 3    | `--resume`     | 1                    | `[{jarvis, connected}]` | 31            | `mcp__jarvis__moss_ping`             |

**Server-side, whole leg (3 claude processes):**

| Metric                                 | Count |
| -------------------------------------- | ----- |
| `initialize` handshakes                | **3** |
| `tools/list` calls                     | 3     |
| distinct TCP connections               | 3     |
| graceful `DELETE` session terminations | **0** |

Each process ran the complete handshake — `server/discover` → `initialize` →
`notifications/initialized` → `tools/list` — then dropped the TCP connection when the process exited.
Turn 2 performed the full handshake even though the model never called a tool, so **the churn is
unconditional: one connect/teardown per turn regardless of whether MCP is used.**

Per-turn handshake cost measured against a localhost server was ~90 ms. Against a real network
endpoint it is larger, and it is paid on every turn.

---

## Leg B — one persistent child, three sequential turns

One child launched with the `launchStructured()` shape merged with `buildCommand()`'s MCP arguments,
fed three user frames over stdin, each awaiting its `result` event before the next.

Merge decisions, all deliberate:

- **dropped `--no-session-persistence`** — the task calls for persistence on, and it is what makes the
  session resumable after a crash.
- **dropped `--tools ""`** — replaced by `--allowedTools 'mcp__jarvis__*'` from the one-shot path.
- **dropped `--json-schema`** — structured-output machinery, orthogonal to this spike, and it would
  have forced JSON-shaped replies.
- **added `--session-id <uuid>`** — so the transcript is addressable, matching one-shot behaviour.

### The exact working launch line

```
cd '<neutralDir>' && claude \
  --print \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --session-id <uuid> \
  --permission-mode dontAsk \
  --mcp-config '<neutralDir>/.jarvis-claude-mcp.json' \
  --settings '<neutralDir>/.jarvis-claude-settings.json' \
  --allowedTools 'mcp__jarvis__*' \
  --append-system-prompt-file '<neutralDir>/persona.md' \
  --strict-mcp-config
```

Input frame per turn, one JSON object per line on stdin:

```
{"type":"user","message":{"role":"user","content":"<text>"}}\n
```

Prefix with `CLAUDE_CODE_OAUTH_TOKEN="$(cat <credentialFile>)"` exactly as `buildCommand()` does when
a credential file is configured. `--append-system-prompt-file` is real and works on 2.1.227 despite
being absent from the top-level `--help` option list (it appears only in prose).

### Evidence

| Check                                                | Result   | Evidence                                                                                                                                                                                  |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. exactly one child PID for all 3 turns             | **PASS** | pid `1232707` (ppid `1232699`) is the only process carrying the session UUID at all five `ps` snapshots: before turn 1, after each turn, before kill                                      |
| 2. exactly one `system/init` event total             | **FAIL** | 3 init events, one per turn                                                                                                                                                               |
| 2′. exactly one MCP handshake total                  | **PASS** | server-side: **1** `initialize`, **1** `tools/list` for the whole leg                                                                                                                     |
| 3. MCP tool call succeeds on turn 1 and turn 3       | **PASS** | `mcp__jarvis__moss_ping` invoked and returned `MCP_PING_OK` on both; server logged 2 `tool_call`s                                                                                         |
| 4. no lifecycle/disconnect notice in assistant prose | **PASS** | all three replies were exactly the marker string; a regex sweep for disconnect/unavailable/reconnect wording across both legs' streams found zero matches                                 |
| Context continuity                                   | **PASS** | turn 2 answered from conversation memory without a tool call                                                                                                                              |
| Clean teardown                                       | **PASS** | `SIGTERM` to the process group exited gracefully (code 143) within 1.5 s, no `SIGKILL` needed; no process carries the session UUID afterwards; the child's own stderr was empty (0 bytes) |

**Do not misread the TCP connection count.** Leg B shows 3 TCP connections but only 1 `initialize`.
Connections 6 and 7 carried a bare `tools/call` with no handshake — that is HTTP keep-alive idle
expiry recycling the socket underneath a _live_ MCP session. TCP connection count is not a churn
metric; `initialize` count is.

---

## What actually leaks — the hypothesis needs restating

The issue frames the symptom as "ambient lifecycle notices leak into assistant prose". I could not
find any CLI-emitted notice string. I ran the failure case directly instead: one one-shot turn with
the MCP server down.

```
init mcp_servers: [{"name": "jarvis", "status": "failed"}]
init tools contains mcp__jarvis__*: False
ASSISTANT TEXT: "I can't do that — there's no `moss_ping` MCP tool available in this session,
  so there's no marker string to return. If you expected it to be here, the MCP server
  providing it isn't connected or configured."
result subtype: success   is_error: False   exit code: 0
```

So the mechanism is: **when the MCP server is unreachable at handshake time, the tools vanish from
the model's tool list entirely, and the model narrates their absence in its own words.** There is no
notice string to filter out. This matters for the spec because it rules out "strip the notice text"
as a fix — the only fix is to stop producing the failure window.

Three consequences worth carrying into the spec.

**The one-shot path cannot detect this at all.** The turn exits `0` with `result.subtype: "success"`
and `is_error: false`. And production's `readNew()` parses the transcript JSONL, not the event
stream — I checked the transcript file for the Leg A session and it contains **zero** `mcp_servers`
records (record types present: `queue-operation`, `attachment`, `user`, `last-prompt`, `assistant`,
`mode`). The engine is structurally blind to MCP connect failure; the only trace that reaches it is
the assistant's prose. Every turn independently rolls this dice.

**The persistent path degrades far more gracefully.** I killed the MCP server between turns on a live
persistent child (Leg B2):

| Turn | Server     | Tools exposed | Model output                                                                                                                                   |
| ---- | ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | up         | yes           | `MCP_PING_OK server=spike-jarvis-mcp`                                                                                                          |
| 2    | **killed** | **yes**       | attempted the call, got a connection error, said _"The moss_ping call failed with a connection error, so I can't retrieve the marker string."_ |
| 3    | restarted  | yes           | `MCP_PING_OK server=spike-jarvis-mcp` — recovered automatically, same process, no relaunch                                                     |

The tool never disappeared, so the model reported a **transient tool failure** rather than a missing
capability, and it self-healed when the server returned. That is a materially better user-facing
failure mode than "the MCP server isn't connected or configured".

**But `init.mcp_servers` goes stale on the persistent path.** On turn 2, with the server confirmed
dead, init still reported `status: "connected"`. The status is captured at handshake and not
refreshed. A persistent runtime therefore must **not** use `init.mcp_servers` as a live health
signal — it is accurate only on the first turn.

---

## Other surprises that should shape the spec

- **`--allowedTools` is a permission allowlist, not a tool-set restriction.** Both legs reported
  **31 tools** exposed to the model despite `--allowedTools 'mcp__jarvis__*'`. All the built-in tools
  are visible; only the `PreToolUse` hook stops them being used. If the intent is that Moss chat sees
  _only_ MCP tools, `--allowedTools` does not deliver it and the permission hook is the sole guard.
- **`init` per turn is stream framing, not lifecycle.** Any regression test must assert on
  `initialize` count observed by an MCP server (or on process identity), never on `system/init` count
  — that check would have falsely failed the correct design.
- **No graceful MCP session termination.** Neither path ever sent a `DELETE`. The client just drops
  the socket, so a server-side session store must rely on TTL, not on client teardown.
- **`--strict-mcp-config` does not fail closed on an unreachable server.** It restricts _which_
  configs load; a configured-but-dead server yields a silent, successful, tool-less turn.
- **Useful `result` fields for a persistent runtime**, available per turn on the same process:
  `subtype`, `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `stop_reason`,
  `terminal_reason`, `permission_denials`, `usage`, `modelUsage`, `total_cost_usd`, `session_id`,
  `uuid`. `permission_denials` and `is_error` are the natural per-turn health signals to replace the
  transcript-scraping the one-shot path does today.
- **`claude -p` stalls ~3 s waiting on stdin** unless stdin is closed. Production is safe here — it
  spawns with `stdio: "ignore"` — but any script-level reproduction needs `< /dev/null` or it pays
  3 s per turn and logs a warning to stderr.
- **Turn serialization is the caller's job.** I waited for each `result` before writing the next
  frame. The spike did not test concurrent frames, so queueing/interleaving behaviour on the stdin
  transport is unknown and the spec should either serialize explicitly or test it.

---

## Cleanup

Instrumented MCP server killed, port released, no claude child left carrying either spike session
UUID. No repo files were modified; this document is the only addition. No prod stack, container or
network was contacted — all traffic was 127.0.0.1.

One incident worth recording: `pkill -f "spike/mcp-server.mjs"` matched **its own shell's** command
line and killed the cleanup script mid-run (exit 144). The kill still landed. Use `pgrep` into an
explicit PID loop, or split the pattern string, when cleaning up by command-line match.
