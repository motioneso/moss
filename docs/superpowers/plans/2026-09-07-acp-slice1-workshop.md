# Plan: ACP slice 1, the Workshop (issue 2424)

Spec: `docs/superpowers/specs/2026-09-06-acp-client-design.md` (approved by Ben, 2026-09-07;
sections 3, 4, 5, 7, 9, 10, 13 item 1). Task issue: #2424 (supersedes #2369). Lane branch: `build/acp-slice1-workshop`. Slices 2 (chat) and 3 (unattended callers,
agy sign-in) have their own plans after this slice passes its live proof.

## Premises verified on `main` at e32222640 (2026-09-07)

- The protocol package `packages/acp` (client, capability check, permission classifier, tool
  table, stream, tunnel, and its unit tests), the runner's ACP host, the tool server's session
  handoff, the gateway's built-in permission policy and the Workshop run-command tool all exist in
  history at commit `bb59e0700` (the parent of the removal commit). Every restore in this plan
  names that commit.
- The Workshop answers each saved project message in `packages/workshop/src/project-reply.ts`
  (`attemptProjectReply`, line 170), which keeps a never-throws contract and persists the reply
  with `appendAssistantReply`. Project feed rows are the history record.
- Model routing: service keys are `AiServiceKey` in `packages/shared/src/ai-types.ts` (line 106,
  capabilities plus `module.*`); the stored blob is parsed in
  `packages/ai/src/service-binding-map.ts` with a recognised-keys filter; resolution is in
  `packages/ai/src/repository.ts` (around line 1170); the admin screen is
  `apps/web/src/settings/settings-ai-admin-pane.tsx`; the app-map entry is `aiproviders` in
  `packages/shared/src/app-map-core.ts` (line 176).
- Runner RPC dispatch is the `switch` in `packages/cli-runner/src/connection.ts` (line 307,
  `launch`, `submit`, `readNew`, `kill`, `probeProvider`, ...); engine host is
  `CliChatEngineHost` in `packages/cli-runner/src/engine-host.ts`; login adapters are loaded in
  `packages/cli-runner/src/login-adapters.ts`; the Claude token store is
  `packages/cli-runner/src/provider-token-store.ts`.
- MCP tool server: `packages/chat/src/mcp-transport.ts`; bearer tokens minted in
  `packages/ai/src/gateway/session-tokens.ts`; approval hold `confirmAndRun` in
  `packages/ai/src/gateway/gateway.ts`.
- Registry pins (spec section 9): Claude `@agentclientprotocol/claude-agent-acp@0.75.1`, Codex
  `@agentclientprotocol/codex-acp@1.10.0`; SDK `@agentclientprotocol/sdk`, newest v1 line at build
  time (the restored package pins `0.14.1` and the old Zed adapter; task 2 replaces both).

## Decisions

- **One adapter, launch profiles, no agent setting.** `@moss/acp` gains a `profile` argument
  (`workshop` | `chat` | `unattended`) that selects the working folder rule, the built-in tool
  off-list from `tool-table.ts`, and whether the tool server is attached. Slice 1 builds and
  tests all three values but wires only `workshop`.
- **Provider rows are code, versions are pinned.** `packages/acp/src/providers.ts` holds one row per
  provider kind (`anthropic`, `openai`, `google`): launch command, login mechanism, model
  mechanism, built-in off-list mechanism, and the capability requirements per profile. The
  `google` row is present and marked unavailable (sign-in path lands in slice 3), so the settings
  screen can say why.
- **The runner gains one small entry point; nothing it does today changes.** Three new RPC
  methods sit beside the existing `launch`, `submit`, `readNew`, `kill` and `probeProvider` cases:
  `acpSpawn` (provider kind, user, working folder, profile; returns a handle), `acpPipe` (send a
  line, read new lines by cursor, close: one method with an `op` field) and `acpExec` (run one
  command in the session's folder for the Workshop tool: start, poll, kill by `op`). Login and
  model refresh keep today's `probeProvider` and login adapters untouched. Everything that
  understands the protocol, the permission policy and session state stays API-side in `@moss/acp`;
  the runner never parses a message. `acpExec` exists only because Fork A puts command running in a
  Moss tool that must run where the folder is. The old chat paths in the runner stay live until
  slice 2 deletes the bridge; they come out there, with a runner audit as its own task in the slice
  2 plan (PM's ruling on Ben's question, 2026-09-07).
- **Model choice through the router.** New service key `workshop` (added to `AiServiceKey`, the
  recognised-keys filter, the resolver's fallback order, the admin screen's bindings list and the
  app map). Resolution order is unchanged: per-user pin, `workshop` binding, instance default
  provider. The resolved model's provider kind picks the provider row; the model id is sent with
  `session/set_config_option` on the `category: "model"` option after `session/new` where the
  agent advertises it, else the row's launch mechanism (Codex `CODEX_CONFIG`), else the session
  stays on the login's default and the reply metadata records that.
- **Working folder** is runner-side `<per-user home>/workshop/<projectId>/`, created 0700 on first
  spawn. Session key `workshop:<userId>:<projectId>`; one live process per key; reaped on project
  close or after the chat idle timeout.
- **Approval card:** the gateway hold stays the enforcement point (spec section 7); heartbeat every
  20 s on held MCP calls; denial wording "This action was not approved. Do not retry; tell the
  user."; the agent's built-in asks are answered from the restored policy keyed on real tool name
  and tool call id.
- **Login check at start.** `initialize` then `session/new`; an `auth_required` error surfaces as
  the provider's "Not logged in" status and a plain reply in the project feed, never a stack trace.
- **Determinism boundary:** every visible answer renders from Postgres feed rows and notifier
  events, never raw model text; model text enters user data only through `appendAssistantReply`.

## Tasks (each one session; each lands green on the lane branch before the next starts)

Every task runs, unpiped, before every push: `pnpm lint`, `pnpm format:check`,
`pnpm check:file-size`, `pnpm typecheck`, plus the scoped unit run named in the task. The full gate
runs only through the `verify-gate` skill, at the end of tasks 4, 7 and 8. No `git add -A`; commit
by path (`shared-checkout` skill).

### Task 1. Restore the protocol package from history, nothing else

- **Builds:** `packages/acp/` exactly as at `bb59e0700` (`git checkout bb59e0700 -- packages/acp`),
  plus the four wiring lines that made it a workspace member at that commit: its entry in
  `tsconfig.json`, `vitest.config.ts`, `scripts/test-unit.ts` and the lockfile. No behaviour
  change, no rename, no other file.
- **Files:** `packages/acp/**`, `tsconfig.json`, `vitest.config.ts`, `scripts/test-unit.ts`,
  `pnpm-lock.yaml`, `tests/unit/test-unit-plan.test.ts` (its expected-suite list).
- **Tests:** the restored `capabilities`, `client`, `permissions`, `tool-table` unit tests pass
  unchanged.
- **Gate:** the four checks above; `pnpm --filter @moss/acp test`.

### Task 2. Provider rows, profiles and the current pins

- **Builds:** `providers.ts` (three rows, `google` marked unavailable with the reason string);
  `AcpSurface` becomes `AcpProfile` with the three values; `checkAgentCapabilities` checks a row's
  requirements for a profile; SDK bumped to the newest v1 line and the agent packages moved to the
  registry entries above (`claude-agent-acp`, `codex-acp`), spawned through `process.execPath`;
  `setModel(sessionId, modelId)` on the session handle using `session/set_config_option`, falling
  back per row; `initialize` sends `protocolVersion: 1` and fails closed in plain English on any
  other answer.
- **Files:** `packages/acp/src/{providers,capabilities,client,index}.ts`, `packages/acp/package.json`,
  `pnpm-lock.yaml`.
- **Tests:** row lookup by provider kind; profile gate passes Claude and Codex for `workshop`, fails
  `google` with the reason; `setModel` sends the option when advertised and records the fallback
  when not; version mismatch fails closed.
- **Gate:** the four checks; `pnpm --filter @moss/acp test`.

### Task 3. Runner entry point: spawn, pipe, exec

- **Builds:** `packages/cli-runner/src/acp-host.ts` restored from `bb59e0700` and trimmed to the
  three methods above (the exec record store and owned-fs helper return only if `acpExec` needs
  them; if they return, say why in the PR); three new dispatch cases added to the `switch` in
  `connection.ts`, no existing case touched; the RPC contract types in
  `packages/chat/src/live/rpc-contract.ts` and the API-side client in
  `packages/chat/src/live/chat-engine-rpc-client.ts`; the per-user home, scrubbed env and 0700
  working folder on spawn; the bearer token crosses only inside the `session/new` payload.
- **Files:** `packages/cli-runner/src/{acp-host,connection,engine-host}.ts`,
  `packages/cli-runner/package.json`, `packages/chat/src/live/{rpc-contract,chat-engine-rpc-client}.ts`,
  `packages/acp/src/tunnel.ts`.
- **Tests:** restore and trim `tests/unit/cli-runner-acp-host.test.ts`,
  `cli-runner-acp-exec.test.ts`, `cli-runner-protocol.test.ts`,
  `cli-runner-startup-orphan-sweep.test.ts` to the three methods; a test that the three new methods
  dispatch and that every existing runner test still passes unchanged.
- **Gate:** the four checks; `pnpm vitest run tests/unit/cli-runner-*`.
- **Dev check (Builder, recorded in the PR):** `spawn, initialize, session/new, prompt` against the
  real Claude agent through the runner on dev, no tools. If this cannot complete, stop the slice
  and report (first kill gate).

### Task 4. Tool server handoff, heartbeat, denial wording

- **Builds:** `mcp-transport.ts` session handoff restored (`mcpServers` entry with the `jst_` bearer
  header at `session/new`); progress notifications every 20 s on a held call; fixed-expiry session
  tokens; denial wording in the gateway and the four test files that assert it.
- **Files:** `packages/chat/src/mcp-transport.ts`, `packages/chat/src/gateway-services.ts`,
  `packages/ai/src/gateway/{gateway,session-tokens,index}.ts`.
- **Tests:** `tests/unit/gateway-tool-progress.test.ts`, `session-tokens-fixed-expiry.test.ts`,
  `mcp-transport.test.ts` restored; wording updates in `tests/integration/chat-mcp-transport.test.ts`,
  `tests/integration/mcp-gateway.test.ts`, `tests/unit/gateway-notifier.test.ts`,
  `tests/unit/mcp-gateway-units.test.ts`.
- **Gate:** the four checks; `pnpm vitest run tests/unit/gateway-* tests/unit/mcp-*`; full gate via
  `verify-gate`.

### Task 5. The Workshop run-command tool (Fork A)

- **Builds:** `packages/workshop/src/run-command.ts` restored: working folder fixed to the session
  project folder, output cap 256 KB with a truncation note, default timeout 300 s with partial
  output, progress streamed through the tool context; tool declared in the Workshop manifest;
  Workshop session tokens carry an allowlist that includes it.
- **Files:** `packages/workshop/src/{run-command,manifest,index}.ts`,
  `packages/shared/src/workshop-api.ts`, `packages/module-sdk/src/index.ts`,
  `packages/shared/src/ai-audit-api.ts`.
- **Tests:** `tests/unit/workshop-run-command-tool.test.ts` restored;
  `tests/unit/self-operation-manifests.test.ts` and `module-dependency-allowlist.test.ts` updated.
- **App map:** the Workshop manifest's `features` gains the run-command behaviour in the same PR.
- **Gate:** the four checks; `pnpm vitest run packages/workshop tests/unit/workshop-*`.

### Task 6. Approval card wiring and the built-in permission policy

- **Builds:** `packages/ai/src/gateway/acp-permission.ts` restored (policy keyed on real tool
  name, matched by tool call id, zones from spec section 7, audit lines); agent asks that need a
  person create a gateway pending action and emit the existing `action_request` event, and the ACP
  request is answered from that resolution; pending permission requests answered `cancelled` on
  `session/cancel`.
- **Files:** `packages/ai/src/gateway/{acp-permission,gateway,native-tool-guard,index}.ts`,
  `packages/acp/src/permissions.ts`.
- **Tests:** `tests/unit/acp-builtin-permission.test.ts` restored and extended for the cancel case.
- **App map:** core `app-map-core.ts` gains the "not approved, ask the user" error and remediation
  at the end of its errors list, same PR.
- **Gate:** the four checks; `pnpm vitest run tests/unit/acp-* tests/unit/gateway-*`.

### Task 7. The `workshop` service key and the admin screen

- **Builds:** `workshop` added to `AiServiceKey` and the recognised-keys filter; resolver falls
  back per-user pin, `workshop` binding, instance default provider; the admin screen's bindings
  list shows a Workshop row offering only connected providers' models; each CLI provider card shows
  the shared-login sentence; a provider whose row cannot honour a model choice says so beside its
  list; the `google` provider shows the unavailable reason from its row.
- **Files:** `packages/shared/src/ai-types.ts`, `packages/ai/src/{service-binding-map,repository}.ts`,
  `apps/web/src/settings/settings-ai-admin-pane.tsx`, `packages/shared/src/app-map-core.ts`
  (`aiproviders` description and the new setting).
- **Tests:** resolver unit tests for the three fallback steps; parser keeps `workshop`; a web test
  that the Workshop row lists only connected providers.
- **App map:** same PR, as above.
- **Gate:** the four checks; `pnpm vitest run packages/ai tests/unit/service-binding*`; full gate
  via `verify-gate`.

### Task 8. Workshop wiring, login check, UAT

- **Builds:** `attemptProjectReply` answers through `@moss/acp` with the `workshop` profile and the
  model from the `workshop` key; no setting selects it, it is the only path; history replayed from
  feed rows into the prompt; `auth_required` becomes the feed reply "The <provider> sign-in has
  expired; an admin can log it in again under Settings, Assistant & AI" and the provider's status;
  stop reasons surface as typed events; cancel wired to the project's cancel; reply persisted with
  `appendAssistantReply`, never-throws kept.
- **Files:** `packages/workshop/src/{project-reply,project-service}.ts`, `packages/workshop/src/manifest.ts`
  (`features`: build through ACP, sign-in expired message), `tests/uat/specs/2369-acp-workshop-build.uat.spec.ts`
  and its trigger-map row.
- **Tests:** reply-path unit tests (login failure text, history replay shape, stop reason mapping);
  the UAT spec.
- **Gate:** the four checks; `pnpm vitest run packages/workshop`; full gate via `verify-gate`.

### Task 9. Live proof and slice exit (Prover, not Builder)

- **Proof:** on the dev instance, a real project, a real build command run through the Workshop
  by the model, a real approval card answered by a person, once on the instance default provider
  and once on a second connected provider bound to the `workshop` key. Evidence (screens and the
  audit lines) recorded on the lane PR.
- **Kill gate (slice exit):** an attended write must finish in under 30 s end to end on dev on the
  instance default provider. If it does not, the slice stops here and PM reassesses before slice 2.

## Order and hand-offs

1 → 2 → 3 (first kill gate) → 4 → 5 → 6 → 7 → 8 → 9. Tasks 5 and 7 may run in parallel with 4
and 6 respectively if two builders are available; both land on the same lane branch and PR (slices
share a worktree and PR). Reviewer reviews each task's commit range before the next task starts.

## Out of scope for this slice

Chat and the bridge deletion (slice 2); unattended callers and the print engines (slice 3); the agy
sign-in path (slice 3); user-level model override for the Workshop; advertising ACP `terminal/*`
(only if task 5's live check shows the tool cannot stream a build log, recorded here if so).
