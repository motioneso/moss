# Plan: ACP slice 1, chat (issue 2424)

Spec: `docs/superpowers/specs/2026-09-06-acp-client-design.md` (approved by Ben 2026-09-07; amended
the same day for chat first, sections 3, 4, 6, 7, 9, 10, 13 item 1, 14). Task issue: #2424
(supersedes #2369). Lane branch: `build/acp-slice1-chat`. Slice 2 (unattended callers, terminal
login path, agy) and slice 3 (the Workshop and its panel) get their own plans after this slice
passes its live proof.

Revision 2 (2026-09-07): chat replaces the Workshop as slice 1 (Ben); Reviewer's findings on
revision 1 folded in (runner restored as it was, chat profile only, spec 7 point 3 deferred with a
reason, model list reconciliation decided, reload and queueing named, evidence rules, two missed
restores, release note); the behind-the-scenes task added (spec section 14); OpenCode as the second
live-proof provider pending Scout.

## Premises verified on `main` at e32222640 (2026-09-07)

- The protocol package `packages/acp` (client, capability check, permission classifier, tool
  table, stream, tunnel, unit tests), the runner's ACP host with its seven RPC cases (`acpSpawn`,
  `acpSend`, `acpRead`, `acpKill`, `acpExecStart`, `acpExecPoll`, `acpExecKill`), the tool
  server's session handoff, the gateway's built-in permission policy and their tests all exist in
  history at commit `bb59e0700` (the parent of the removal commit). Every restore names that commit.
  The removal also dropped `"@moss/acp": "workspace:*"` from `packages/ai/package.json` and
  changed the denial wording asserted in `tests/unit/mcp-gateway-recovery.test.ts` to "Timed out
  awaiting confirmation."; both come back (Reviewer finding 8).
- Chat's engine is chosen in `packages/chat/src/live/engine-selection.ts` and handed to the
  session manager (`packages/chat/src/live/chat-session-manager.ts`: idle watchdog 180 s at line
  107, idle reaper at line 880, the "Chat session was lost, reconnecting" record at line 282,
  resume at line 674) through `packages/chat/src/live/runtime.ts` and `routes.ts`
  (`selectEngineFactory`). The bridge engines live beside it in `packages/chat/src/live/`.
- Runner RPC dispatch is the `switch` in `packages/cli-runner/src/connection.ts` (line 307 on
  main: `launch`, `submit`, `readNew`, `kill`, `probeProvider`, `listProviderModels` at 434, the
  login and terminal cases). Model lists come from `packages/cli-runner/src/model-list-adapters.ts`.
- MCP tool server: `packages/chat/src/mcp-transport.ts`; bearer tokens in
  `packages/ai/src/gateway/session-tokens.ts`; approval hold `confirmAndRun` in
  `packages/ai/src/gateway/gateway.ts`.
- The drawer's per-turn "Thinking" fold is `packages/ui/src/chat-thread.tsx` (a details element
  fed by transcript records, `activityVerb` per line), styled in
  `packages/ui/src/styles/components-chat.css` (`chatd-peek*`). The reply row is
  `apps/web/src/chat/message-row.tsx`. Chat's app-map surface is the `features` block of
  `packages/chat/src/manifest.ts`; core screens and errors are `packages/shared/src/app-map-core.ts`.
- Registry pins (spec section 9): Claude `@agentclientprotocol/claude-agent-acp@0.75.1`, Codex
  `@agentclientprotocol/codex-acp@1.10.0`, OpenCode registry entry `opencode` (pinned in task 2
  once Scout's check passes), SDK `@agentclientprotocol/sdk` newest v1 line at build time.
- Token usage: each turn's reply carries a usage block (input, output, cached read, cached write,
  total) built by the Claude adapter from its own tally and shaped like the Codex adapter's
  (Scout read both, 2026-09-07). Codex's live numbers are unproven until its account usage returns
  on 2026-09-11; OpenCode's are Scout's pending check. There is no turn-duration field.

## Decisions

- **One adapter, one profile built.** `@moss/acp` keeps a `profile` type with three values
  (`chat`, `workshop`, `unattended`) so the table in `tool-table.ts` has its columns, but slice 1
  builds, tests and wires only `chat`: scratch folder, shell and file writes off, tool server on.
  The other two values are declared and rejected with "not built yet" until their slices.
- **Provider rows are code, versions are pinned.** `packages/acp/src/providers.ts` holds one row per
  provider kind (`anthropic`, `openai`, `google`, `opencode`): launch command, login mechanism,
  model mechanism, built-in off-list mechanism, capability requirements per profile. `google` is
  present and marked unavailable with the reason (slice 2). `opencode` is present only if Scout's
  check passes before task 2 starts; otherwise it is added in a later task of this slice with its
  own dev check.
- **Runner: add, don't rewrite.** The ACP host and its seven RPC cases come back from
  `bb59e0700` exactly as they were, beside the existing cases; no existing case is touched, no
  mode flag is introduced. Chat uses four of the seven (spawn, send, read, kill); the three exec
  cases are restored with their tests because the file is restored whole and slice 3 needs them,
  and they are not reachable from any chat path. The old chat paths in the runner stay live until
  task 9 deletes the bridge API-side; the runner's own dead cases come out in slice 2 with a runner
  audit as its own task there (PM's ruling on Ben's question, 2026-09-07).
- **Model choice.** Chat keeps today's resolution (per-user pin, else the instance default
  provider's default model). The resolved provider kind picks the row; the model id is sent with
  `session/set_config_option` on the `category: "model"` option after `session/new` where the
  agent advertises it, else the row's launch mechanism, else the session stays on the login's
  default and the reply record says so.
- **Model list reconciliation, decided (Reviewer finding 5).** The "Refresh models" list in
  settings keeps today's per-CLI adapter as its only source. The protocol's `configOptions` is
  used to set the model and, at session start, to confirm the chosen id is one the agent accepts;
  a mismatch is recorded on the reply and shown as the provider's status line, never merged into
  the list. One list, one place it comes from.
- **Gateway hold through the protocol card, deferred (Reviewer finding 4, spec 7 point 3).** In
  chat the gateway's approval card already renders in the drawer, so surfacing the same hold
  through `session/request_permission` would be a second render of one hold on one screen. Deferred
  to slice 3, where the Workshop panel is the screen that needs it. Recorded here, and in the spec's
  review record by the lane PR.
- **Sessions (spec section 6).** One process per (user, chat, conversation), keyed
  `chat:<userId>:<conversationId>`, working folder `<per-user home>/chat/<conversationId>/` created
  0700, reaped by the existing 180 s idle watchdog. A browser reload replays from Postgres; live
  reattach (`session/load`) is used only where the agent advertises it and is not required to
  pass. One prompt at a time: a second send while a turn runs is queued by the session manager and
  sent after the stop reason arrives; the composer shows it as queued.
- **Approval card:** the gateway hold stays the enforcement point; heartbeat every 20 s on held
  calls; denial wording "This action was not approved. Do not retry; tell the user."; the agent's
  built-in asks are answered from the restored policy keyed on real tool name and tool call id;
  `session/cancel` (the drawer's stop button) answers every pending ask `cancelled`.
- **Login check at start.** `initialize` then `session/new`; an `auth_required` error becomes the
  provider's "Not logged in" status and a plain reply in the drawer, never a stack trace.
- **Behind the scenes (spec section 14).** Thoughts, tool calls, approvals and results become
  transcript records that feed the existing Thinking fold; the stats strip under the reply shows
  Moss's elapsed clock and the usage block's numbers when present. Mockup:
  `docs/superpowers/specs/assets/2026-09-06-acp-client/behind-the-scenes.html`. Ben sees it before
  task 8 starts.
- **Evidence rules (Reviewer finding 7).** Every dev check and the live proof record exit codes,
  test assertions, audit lines and bounded logs on the lane PR. No screenshots.
- **Release note (Reviewer finding 9).** Written once on the lane PR: Category Changed, "Chat
  answers through the agent protocol; each reply shows what happened behind the scenes and what it
  cost."
- **Determinism boundary:** every visible answer renders from Postgres transcript records and
  notifier events, never raw protocol frames.

## Tasks (each one session; each lands green on the lane branch before the next starts)

Every task runs, unpiped, before every push: `pnpm lint`, `pnpm format:check`,
`pnpm check:file-size`, `pnpm typecheck`, plus the scoped unit run named in the task. The full gate
runs only through the `verify-gate` skill, at the end of tasks 5, 7 and 9. No `git add -A`; commit
by path (`shared-checkout` skill). Every product-facing task (6 to 9) updates the app map in the
same commit range.

### Task 1. Restore the protocol package from history, nothing else

- **Builds:** `packages/acp/` exactly as at `bb59e0700` (`git checkout bb59e0700 -- packages/acp`)
  plus the wiring that made it a workspace member at that commit. No behaviour change, no rename.
- **Files:** `packages/acp/**`, `tsconfig.json`, `vitest.config.ts`, `scripts/test-unit.ts`,
  `pnpm-lock.yaml`, `tests/unit/test-unit-plan.test.ts`, `packages/ai/package.json` (the
  `@moss/acp` workspace dependency).
- **Tests:** the restored `capabilities`, `client`, `permissions`, `tool-table` unit tests pass
  unchanged.
- **Gate:** the four checks; `pnpm --filter @moss/acp test`.

### Task 2. Provider rows, the chat profile and the current pins

- **Builds:** `providers.ts` (rows above); `AcpSurface` becomes `AcpProfile`, only `chat` accepted
  at run time; `checkAgentCapabilities` checks a row's requirements for `chat`; SDK bumped to the
  newest v1 line, agent packages moved to the registry entries, spawned through
  `process.execPath`; `setModel(sessionId, modelId)` using `session/set_config_option` with the
  per-row fallback and the accepted-id check; `initialize` sends `protocolVersion: 1` and fails
  closed in plain English on any other answer.
- **Files:** `packages/acp/src/{providers,capabilities,client,index}.ts`, `packages/acp/package.json`,
  `pnpm-lock.yaml`.
- **Tests:** row lookup by kind; profile gate passes Claude, Codex (and OpenCode if present) for
  `chat`, rejects `google` with its reason and `workshop`/`unattended` with "not built yet";
  `setModel` sends the option when advertised, falls back per row, records a mismatch; version
  mismatch fails closed.
- **Gate:** the four checks; `pnpm --filter @moss/acp test`.

### Task 3. Runner: restore the ACP host and its seven cases as they were

- **Builds:** `packages/cli-runner/src/acp-host.ts`, `exec-records.ts`, `owned-fs.ts` and the seven
  dispatch cases restored from `bb59e0700` beside the existing cases, unchanged; the RPC contract
  types and the API-side client restored to match. Per-user home, scrubbed env and the 0700 working
  folder on spawn; the bearer token crosses only inside the `session/new` payload.
- **Files:** `packages/cli-runner/src/{acp-host,exec-records,owned-fs,connection,engine-host}.ts`,
  `packages/cli-runner/package.json`, `packages/chat/src/live/{rpc-contract,chat-engine-rpc-client}.ts`,
  `packages/acp/src/tunnel.ts`.
- **Tests:** `tests/unit/cli-runner-acp-host.test.ts`, `cli-runner-acp-exec.test.ts`,
  `cli-runner-protocol.test.ts`, `cli-runner-startup-orphan-sweep.test.ts` restored unchanged and
  green; every existing runner test still passes unchanged.
- **Gate:** the four checks; `pnpm vitest run tests/unit/cli-runner-*`.

### Task 4. Dev handshake (first kill gate)

- **Builds:** one check script under `scripts/` that, on dev, asks the runner to spawn the Claude
  agent for the signed-in user, runs `initialize`, `session/new`, one `session/prompt` with no
  tools, and exits non-zero on any failure or after 60 s.
- **Files:** `scripts/acp-handshake-check.ts`.
- **Evidence (Builder, on the PR):** the script's exit code and its bounded log (last 40 lines).
- **Kill gate:** if the handshake cannot complete through the runner on dev, stop the slice and
  report to PM before any further task.

### Task 5. Tool server handoff, heartbeat, denial wording

- **Builds:** `mcp-transport.ts` session handoff restored (`mcpServers` entry with the `jst_` bearer
  header at `session/new`); progress notifications every 20 s on a held call; fixed-expiry session
  tokens; the denial wording in the gateway.
- **Files:** `packages/chat/src/mcp-transport.ts`, `packages/chat/src/gateway-services.ts`,
  `packages/ai/src/gateway/{gateway,session-tokens,index}.ts`.
- **Tests:** `tests/unit/gateway-tool-progress.test.ts`, `session-tokens-fixed-expiry.test.ts`,
  `mcp-transport.test.ts` restored; wording restored in `tests/unit/mcp-gateway-recovery.test.ts`
  and updated in `tests/integration/chat-mcp-transport.test.ts`, `tests/integration/mcp-gateway.test.ts`,
  `tests/unit/gateway-notifier.test.ts`, `tests/unit/mcp-gateway-units.test.ts`.
- **Gate:** the four checks; `pnpm vitest run tests/unit/gateway-* tests/unit/mcp-*`; full gate via
  `verify-gate`.

### Task 6. Approval wiring and the built-in permission policy

- **Builds:** `packages/ai/src/gateway/acp-permission.ts` restored (policy keyed on real tool
  name, matched by tool call id, zones from spec section 7, audit lines); agent asks that need a
  person create a gateway pending action and emit the existing `action_request` event, and the ACP
  request is answered from that resolution; every pending ask answered `cancelled` on
  `session/cancel`. The spec 7 point 3 deferral is written into the spec's review record.
- **Files:** `packages/ai/src/gateway/{acp-permission,gateway,native-tool-guard,index}.ts`,
  `packages/acp/src/permissions.ts`, `docs/superpowers/specs/2026-09-06-acp-client-design.md`.
- **Tests:** `tests/unit/acp-builtin-permission.test.ts` restored and extended for the cancel case.
- **App map:** `app-map-core.ts` gains the "not approved, ask the user" error and remediation.
- **Gate:** the four checks; `pnpm vitest run tests/unit/acp-* tests/unit/gateway-*`.

### Task 7. Chat answers through the protocol

- **Builds:** an ACP chat engine behind the session manager for the `chat` profile, chosen by
  `engine-selection.ts` for every conversation (no setting); session key and folder as decided;
  history replayed from Postgres into the prompt; the stop button sends `session/cancel`; a second
  send during a turn is queued and the composer says so; stop reasons surface as typed events; an
  `auth_required` answer becomes the provider's "Not logged in" status and the drawer reply "The
  <provider> sign-in has expired; an admin can log it in again under Settings, Assistant & AI";
  reply persisted through the existing transcript path.
- **Files:** `packages/chat/src/live/{engine-selection,runtime,chat-session-manager}.ts`, a new
  `packages/chat/src/live/acp-chat-engine.ts`, `packages/chat/src/manifest.ts`.
- **Tests:** engine unit tests (login failure text, replay shape, stop reason mapping, queue on
  busy, cancel answers pending asks); session manager tests for the queue.
- **App map:** chat manifest `features`: answers through the agent protocol, the sign-in expired
  message, queued sends.
- **Gate:** the four checks; `pnpm vitest run packages/chat`; full gate via `verify-gate`.

### Task 8. Behind the scenes: the fold and the stats strip

Starts only after Ben has seen the mockup (posted in the room 2026-09-07).

- **Builds:** transcript records for thought, tool call (real name, summarised arguments), result
  (capped), approved / not approved / refused lines, written as the protocol updates arrive so the
  open fold is the live view; the reply record stores elapsed ms and the usage block; the stats
  strip (`chatd-stats`, one new primitive in `components-chat.css`) under the reply: elapsed, then
  input, output, cached-read tokens with flat icons and word tooltips, each number shown only when
  the agent sent it.
- **Files:** `packages/shared/src/chat-api.ts`, `packages/chat/src/live/acp-chat-engine.ts`,
  `packages/ui/src/chat-thread.tsx`, `packages/ui/src/styles/components-chat.css`,
  `apps/web/src/chat/message-row.tsx`, `packages/chat/src/manifest.ts`.
- **Tests:** record mapping unit tests (each update kind to its line; usage absent shows time
  alone); a web test that the fold lists the lines in order and the strip renders the numbers
  given.
- **App map:** chat manifest `features`: the fold and the strip.
- **Design gate:** the invented-class audit from the `design-system` skill run on `apps/web/src/chat`
  and `packages/ui/src`, output on the PR.
- **Gate:** the four checks; `pnpm vitest run packages/chat packages/ui apps/web`.

### Task 9. Delete the bridge, settings wording, second gate

- **Measure first:** the spike's prompt set run through the ACP engine on dev, wall-clock per turn
  recorded on the PR next to the bridge's numbers from `spikes/acp-tool-call/RESULTS.md`. If ACP is
  not within the bridge's wall-clock, stop and report to PM before deleting anything.
- **Builds:** the bridge engines and their selection removed: `claude-print-chat-engine`,
  `gemini-print-chat-engine`, `codex-exec-session`, `claude-persistent-runtime`,
  `codex-persistent-runtime`, `persistent-runtime-*`, `cli-chat-engine*`, `claude-permission-hook`
  and the engine choice in `engine-selection.ts`. `cli-structured-adapter.ts` stays until slice 2
  because the unattended callers still use it (named here so nobody deletes it early). No fallback
  setting. Settings: each provider card's "Not logged in" state driven by the adapter's initialize
  check; a provider whose row cannot honour a model choice says so beside its list; OpenCode card if
  its row landed.
- **Files:** `packages/chat/src/live/**` (deletions), `packages/chat/src/routes.ts`,
  `apps/web/src/settings/settings-ai-admin-pane.tsx`, `packages/shared/src/app-map-core.ts`,
  the tests of the deleted engines.
- **Tests:** deleted engines' tests removed; a test that engine selection has one path; settings
  web test for the login state and the model-choice note.
- **App map:** `aiproviders` entry: login-check wording, model-choice note, OpenCode if present.
- **Gate:** the four checks; `pnpm vitest run packages/chat apps/web`; full gate via `verify-gate`.

### Task 10. Live proof and slice exit (Prover, not Builder)

- **Proof:** on dev, "add lunch with Sam on Thursday at noon" in the drawer, the approval card
  answered by a person, one event in the calendar, the fold open showing the tool call and the
  approval, the stats strip present; once on the instance default provider (Claude) and once on
  the second bound provider (OpenCode if its row passed, else Codex after 2026-09-11, recorded as
  pending on the PR until then). The first real turn on each provider records its usage block on
  the PR (real numbers or zeros).
- **Evidence:** `tests/uat/specs/2424-acp-chat-lunch.uat.spec.ts` (added by Builder in task 7,
  run by Prover) exit code and assertions, the audit lines, the bounded engine log. No screenshots.
- **Kill gate (slice exit):** the attended write finishes in under 30 s end to end on dev on the
  instance default provider. If it does not, the slice stops here and PM reassesses before slice 2.

## Order and hand-offs

1 → 2 → 3 → 4 (first kill gate) → 5 → 6 → 7 → 8 → 9 (second gate) → 10. Task 5 may run in
parallel with 3 and 4 if two builders are available; both land on the same lane branch and PR.
Reviewer reviews each task's commit range before the next task starts.

## Out of scope for this slice

The Workshop, its profile, its service key and its panel (slice 3); unattended callers, the
structured adapter's deletion, the terminal-type login path, agy (slice 2); the runner audit
(slice 2); the gateway hold through the protocol card (slice 3); user-level model override; ACP
`terminal/*`.
