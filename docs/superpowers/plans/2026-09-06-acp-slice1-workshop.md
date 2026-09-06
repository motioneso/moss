# Plan: ACP slice 1 — Workshop builds through an outside agent (issue 2369)

Spec: `docs/superpowers/specs/2026-09-06-acp-client-design.md` (sections 3, 4, 6, 7, 11 item 1).
Lane: `work/acp-slice1`. Neighbor lane `work/workshop-prb` owns the chat renderer and Workshop
project pages; this plan never touches them.

## Premises verified on this branch

- No adapter package exists (`ls packages/` shows no acp entry).
- No Workshop project folder exists (no folder/cwd concept in `packages/workshop/src/`).
- Approval hold is 150 s (`packages/chat/src/live/claude-permission-hook.ts:19`,
  `NATIVE_CONFIRM_TIMEOUT_MS`), gateway confirm path is
  `packages/ai/src/gateway/gateway.ts:715` (`confirmAndRun`).
- MCP tool server is `packages/chat/src/mcp-transport.ts:52` (`registerMcpTransportRoute`),
  plain JSON-RPC over HTTP POST, Bearer `jst_` tokens minted by
  `packages/ai/src/gateway/session-tokens.ts:81`.
- Runner spawns per-user UIDs (`packages/cli-runner/src/uid-allocator.ts:32`), dispatches RPC in
  `packages/cli-runner/src/connection.ts:306`, token crosses only in launch payload
  (`packages/chat/src/live/rpc-contract.ts:283`).
- Dependency facts (npm, 2026-09-06): client SDK is `@agentclientprotocol/sdk` (adapter
  `0.16.2` pins `0.14.1`, protocol v1); agent binary is `@zed-industries/claude-code-acp`
  (`claude-code-acp` bin, ACP on stdio). Adapter honors `mcpServers [{type,url,headers}]`,
  `_meta.disableBuiltInTools`, client caps `fs`/`terminal`, and asks the client on every
  unapproved tool via `requestPermission`. The Claude Agent SDK bundle references
  `progressToken` and `notifications/progress`, so the section 6 heartbeat has a live reader.
- Timing gate from the issue holds: 2364, 2365, 2358 are all in this branch history.
- Denial wording is asserted by `tests/integration/chat-mcp-transport.test.ts`,
  `tests/integration/mcp-gateway.test.ts`, `tests/unit/mcp-transport.test.ts`,
  `tests/unit/gateway-notifier.test.ts`; the section 6 rewording updates them in the same PR.

## Decisions

- New package `packages/acp`, npm name `@moss/acp`. Pins `@agentclientprotocol/sdk 0.14.1`
  (the exact line the adapter speaks) and sends `protocolVersion: 1` at `initialize`; a
  response other than 1 fails closed with a plain-English error. No other package imports
  the ACP SDK directly.
- The runner is a process spawner plus line pipe, nothing more. New RPC methods `acpSpawn`,
  `acpSend`, `acpRead` (sequence cursor, poll), `acpKill`, `acpExecStart`, `acpExecPoll`,
  `acpExecKill`, dispatched in `connection.ts` beside `launch`. All ACP intelligence
  (Client requests, permission policy, session state) lives API-side in `@moss/acp`, because
  the runner has no policy or database access.
- `acpSpawn` runs the adapter as the user's UID with scrubbed env, HOME set to the per-user
  home, cwd set to a runner-side `<home>/workshop/<projectId>/` directory created 0700 on
  spawn. The session Bearer travels only inside the `session/new` payload over the RPC
  socket (same rule as `RpcLaunchParams.mcpToken`), never argv or env. `cli-runner`
  gains an npm dependency on `@zed-industries/claude-code-acp 0.16.2`, spawned through
  `process.execPath`.
- Client capabilities advertised: no `fs`, no `terminal` (files and commands are Moss tools,
  per the spec table, so a v2 migration never touches file handling).
- Capability gate at adapter start, per surface rows from spec section 7. Workshop needs:
  initialize/session/prompt/cancel, `mcpCapabilities.http`, headless stored login. The
  chat row (built-in switch-off) ships as the same check function, used in slice 2.
- Agent built-in permission policy (spec 6.4): read-only built-ins allow; writes inside the
  session cwd allow as normal use; destructive or outside-cwd asks through the shared card;
  unknown tools deny. The classifier is an explicit tool-name plus path-prefix list, unit
  tested.
- Approval card (spec 6.3): one card. MCP tool holds keep the gateway `confirmAndRun` path
  unchanged as the enforcement point. Agent built-in asks that need a person create a
  gateway pending action and emit the same `action_request` event, then answer the ACP
  request from the resolution. No second policy.
- Approval heartbeat (spec 6.1): `tools/call` responses stream SSE when the caller accepts
  it, emitting `notifications/progress` every 20 s (echoing the caller's `progressToken`)
  while the gateway hold runs the full 150 s; the stream closes with the result. No token
  or no SSE accept means today's held response (never worse).
- Denial wording (spec 6.2): timeout and deny both return
  "This action was not approved. Do not retry; tell the user."
- Fork A tool: `workshop.runCommand`, input `{command, timeoutMs?}`, cwd locked runner-side
  to the session project directory, output cap 256 KB with truncation note, default timeout
  300 s returning partial output on timeout. Partial output streams as MCP progress through
  a new optional `ToolContext.reportProgress`; the transport wires an SSE sink, no-op
  otherwise. Session tokens for Workshop carry an allowlist including it
  (`SessionTokenRegistry` already supports `allowedToolNames`).
- Workshop wiring: `attemptProjectReply` (`packages/workshop/src/project-reply.ts:170`) gains
  an ACP path used when the `workshop.agent` setting selects the ACP agent; otherwise
  today's behavior byte for byte. Session key `workshop:<userId>:<projectId>`. History is
  replayed from Postgres feed rows into the prompt; the reply is persisted with
  `appendAssistantReply` and the function keeps its never-throws contract.
- Settings: registry keys `workshop.agent` and `chat.agent` (plain strings in
  `packages/settings/src/instance-settings-keys.ts:17`, no migration), admin default per
  surface in the Assistant & AI pane (`apps/web/src/settings/settings-ai-admin-pane.tsx`),
  listing only agents that pass the section 7 gate for that surface, with the shared-login
  sentence beside CLI providers. User-level override follows in slice 2 with chat.
- App map, append-only: Workshop manifest `features` gains the build-agent behavior plus
  the "not approved, ask the user" error and remediation; core `app-map-core.ts` gains the
  matching error entry at the end of its errors list. Nothing reordered or reformatted.
- Persona budget: `PROJECT_REPLY_PERSONA_TEXT` plus at most two short build sentences,
  under 150 words of guidance total.

## Determinism boundary

Every visible answer renders from the record: Postgres feed rows and notifier events, never
raw model text. The agent gets two jobs: answer the project message, and pick tools inside
the turn. No turns are injected into host chat. Model text crosses into user data only
through `appendAssistantReply`.

## Phases (each lands green; phase 1 alone decides go/no-go)

1. Adapter plus runner tunnel. `@moss/acp` client (open, prompt, cancel, close, capability
   gate), runner spawn plus line pipe, settings-file scoping in the per-user home.
   E2E: a prompt answered through the runner on dev, no tools.
2. Tool server handoff plus heartbeat. `mcpServers` entry at `session/new`, SSE progress on
   held calls, denial rewording plus the four test-file updates.
   E2E: a 65 s held approval emits 3+ progress frames then the result, against a harness
   client; wording asserted in unit tests.
3. `workshop.runCommand`. Runner exec in the project directory, progress streaming, token
   allowlist.
   E2E: a real build command runs in a scratch project directory on dev and streams output.
4. Approval card wiring. Shared card for agent built-in asks, auto-answer policy, audit
   attribution by token.
   E2E: an attended approval answered by a person on dev finishes end to end.
5. Workshop wiring, settings, app map, UAT. ACP reply path behind the setting, admin pane
   agent choice, append-only map entries, `tests/uat/specs/2369-acp-workshop-build.uat.spec.ts`
   plus a trigger-map row for the touched Workshop and settings files.
   E2E/UAT: the slice live-path proof — a real project, a real build command, a real
   approval card answered by a person on dev.

## Kill gate

After phase 1: if `spawn, initialize, newSession, prompt` cannot complete against the real
adapter on dev (login, environment, or transport), stop and re-slice. Owner: coordinator.
The spec's slice gate (attended write under 30 s end to end) is the slice exit, also owned
by the coordinator.

## Verification (unpiped, expected exit 0 unless noted)

- `pnpm --filter @moss/acp test > /tmp/acp-test.log 2>&1` (new unit tests: policy
  classifier, capability gate, NDJSON request matching).
- `pnpm vitest run packages/ai packages/chat packages/workshop > /tmp/slice1-unit.log 2>&1`
  (rewording updates plus runCommand and reply-path tests).
- `pnpm format:check > /tmp/fmt.log 2>&1; echo EXIT=$?`, then `pnpm lint`, then
  `pnpm typecheck`, each unpiped, before every push.
- Full gate only through the `verify-gate` skill, never a bare command.
- UAT spec runs through the coordinator's UAT harness on a live dev instance.

## Open questions for the coordinator

1. The Workshop approval card must appear while `work/workshop-prb` rewrites the project
   pages, which this lane cannot touch. Proposal: emit the existing `action_request` event
   and let their new chat window render it; needs their confirmation.
2. User-level agent override: propose admin default only in slice 1, user override with
   chat in slice 2. Confirm.
3. Confirm the pins: `@agentclientprotocol/sdk 0.14.1`,
   `@zed-industries/claude-code-acp 0.16.2`.
