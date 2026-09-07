# Plan: ACP slice 1 phase 4 — one approval card for the agent's own tools (issue 2380)

## Seams check (all cited from this branch)

- Approval card enforcement point: `AssistantToolGateway` creates a pending row then
  emits `action_request` on the session notifier and awaits the confirmation registry.
  Native-tool path: `packages/ai/src/gateway/gateway.ts:401` (create),
  `:418` (emit `action_request`), `:413` (await). MCP-tool path: same file `:740`,
  `:776`, `:752`. The Approve/Deny route calls back into
  `gateway.resolveActionRequest` (`packages/ai/src/routes.ts:612`), which the web card
  triggers (`apps/web/src/chat/action-request-card.tsx:23`).
- Pending-row write: `AiRepository.createPendingAssistantAction`
  (`packages/ai/src/repository.ts:1821`); owner comes from the data-context actor,
  which the gateway derives from the verified session token.
- Token identity: `SessionTokenRegistry.verify`
  (`packages/ai/src/gateway/session-tokens.ts:106`) returns `actorUserId`,
  `chatSessionId`, `allowedToolNames`. Denial wording:
  `APPROVAL_REFUSED_REASON` (`packages/ai/src/gateway/gateway.ts:61`).
- Current ACP posture denies everything with no policy:
  `packages/acp/src/client.ts:79` (`denyPermission`) wired at `:194`.
- Protocol shape: `RequestPermissionRequest` carries `sessionId`, `toolCall`
  (`toolCallId`, `rawInput`, `title`), and `options` (SDK `types.gen.d.ts`).
  The question names nothing — the name arrives earlier, in the agent's
  `tool_call` progress announcement for the same tool call id, which carries
  the raw input, kind, file locations, and the real name under
  `_meta.claudeCode.toolName` (adapter `dist/acp-agent.js`, announcement
  builder plus `canUseTool`). `_meta` is declared, so it survives receive-side
  validation; a bare custom field would be stripped. The title is model-written
  and never decides. Question without announcement refuses, by design.
- `@moss/acp` has no workspace dependencies (`packages/acp/package.json`); adding
  `@moss/ai -> @moss/acp` introduces no cycle.

## Decisions

- Identity: the client remembers each session's announcements (id → name, kind,
  locations, raw input; 256 per session, cleared on close) and matches each
  question by tool call id, waiting a bounded 2 s for a late announcement.
  Unannounced or unnamed asks are UNKNOWN and refuse with a log line.
- One table `packages/acp/src/tool-table.ts` (family, chat/workshop surfaces per
  row; Moss prefix; launch off-lists). Policy, launch list, and runner deny
  list all derive from it; tests lock the agreement.
- Rule by family (`packages/acp/src/permissions.ts`, pure, no DB, no fs):
  - READ: inside folder allows except secret-shaped names, which ask; home
    corners and system folders refuse; anywhere else asks; bare Reads refuse.
  - WRITE: session-folder writes allow as ordinary use; home corners and system
    folders refuse; anywhere else asks; with no path, ask.
  - WEB: public fetches allow, loopback/private/bare names ask; Moss tools
    allow at once. MODE and NOT OFFERED refuse.
  - Forbidden zone is the agent home subtree plus `/proc`, `/sys`, `/dev`,
    `/run`; the session folder is checked first and always wins. A request
    naming several files is judged by its most sensitive one. The runner
    block list switches built-in writing off entirely today, so the in-folder
    write allow cannot fire until phase 5 turns the feature on — the rule is
    written for that shape.
  - Known limits (spec section 4): containment is lexical, so a link inside
    the folder pointing at a secret passes; the login credential is inside the
    agent's own process regardless of any path rule; the per-user account is
    the containment that does not care about paths, and only exists with the
    per-user identity option on.
- Home reaches the decider beside the folder: `spawn` returns the HOME handed
  to the agent (`acp-host.ts`, RPC contract, tunnel, client handle).
- `packages/ai/src/gateway/acp-permission.ts`:
  `requestAcpBuiltInPermission(deps, token, input)` verifies the token (owner
  attribution) and decides via `@moss/acp`. Allow returns without a row; deny
  returns without a row; ask creates the same pending row and emits the same
  `action_request` event as the native path, awaits the same registry, emits
  `action_result`, and `markDone`s. The row's `inputSummary` and every audit
  line carry an `agent` block (`ActionAuditAgentSummary` in `@moss/shared`):
  session id, tool call id, real tool name, folder, the paths a read or write
  named (5 at most, 200 chars each), and the decision word with the refusal
  reason; never a command. The card is marked destructive for shell, delete,
  move and execute; write for writes; outbound for reads and fetches that reach
  a person. Card text is the real name plus the paths, address or command
  (`acpCardText`); the model's title appears only labelled as its own
  description. An audit line is written for every ask outcome and every
  refusal (reason word as error class); silent allows write none. The class
  keeps a thin delegate so `gateway.ts` stays under the size gate. No second
  policy, no second wording, enforcement point unchanged.
- Exports: `permissions.ts` from `packages/acp/src/index.ts`; gateway method plus
  its input/output types from `packages/ai/src/gateway/index.ts`. Workspace dep
  `@moss/ai -> @moss/acp` declared in `packages/ai/package.json`.
- No app-map change in this phase: the card, screens, settings, and errors are
  unchanged; phase 5 carries the workshop map entries.

## Test cases (behavior plus what breaks them)

- `packages/acp/src/permissions.test.ts` plus `tool-table.test.ts`: verdict tests
  feed announced names (kind/locations carried, never decisive) and adapter-built
  fixtures from the adapter's own mapping. Covers: absent/unlisted name refuses;
  mode/not-offered refuse; reads inside allow, secrets ask, home corners and
  system folders refuse with reason words, bare Reads refuse; writes inside
  allow, outside ask, forbidden refuse; public fetches allow, private ask;
  Moss tools allow; traversal asks; subagent titled like a read refuses without
  asking. Each fails if the table, extraction, or zones regress.
- `packages/acp/src/client.test.ts` additions: announcement-then-question and
  question-then-announcement both decide by the announced name; no announcement
  refuses after the bound; nameless announcement refuses. Fails if the hook,
  the wait, or the folder handover breaks.
- `tests/unit/acp-builtin-permission.test.ts`: ask path creates a pending row owned
  by the token's actor and emits `action_request` matching the native shape, with
  agent session and folder saved as identifiers and no command content;
  confirming through `gateway.resolveActionRequest` (the function the Approve route
  calls) returns allow; timeout returns deny with `APPROVAL_REFUSED_REASON`;
  allow/deny paths create no row; read-mimicking title with no name refuses with
  no row and untouched confirmations; audit lines land for every ask and every
  refusal with the reason words, none for silent allows; bad token throws.
  Fails if a second event shape, wording, or attribution path appears.
- `tests/unit/cli-runner-acp-host.test.ts`: settings deny equals the table's
  shell/write rows plus the zone rules, exactly.
- Phase E2E (in the same unit file, no DB): scripted agent permission request →
  client decider → gateway ask → `resolveActionRequest` as owner → agent receives
  `selected/allow`. This is the attended-approval path with the human step played
  through the exact function the UI calls; in-browser proof lands with phase 5 UAT.

## Handoff to phase 5 (turning built-ins on)

- Replace the client's blanket `disableBuiltInTools` flag with
  `launchOffList(surface)` from the tool table, passed to the adapter as
  `_meta.claudeCode.options.disallowedTools` (the adapter merges that list).
- Live checks the unit tests cannot give: the first tool call of a session
  must show a real name in the API log, otherwise the adapter changed under
  us and everything refuses; ask the agent to read the token file and expect
  the runner's native deny rule to refuse it by name (the vendor's matcher is
  what protects the built-in Read, so a unit test here proves nothing); count
  the agent-side prompts raised by Moss tool calls under the runner's clean
  home — if they occur and the Moss row were ever dropped from the table,
  every Moss call would die looking like a tool-server failure.
- Wire `MossAcpClient` with a decider that calls
  `gateway.requestAcpBuiltInPermission` once; the gateway already runs the
  policy, so the decider must not classify a second time.

## Determinism boundary

Permission answers are protocol outcomes, never chat text. The card renders from
the persisted pending row and notifier events, never from agent output.

## Verification (unpiped, expected exit 0)

- `vitest run packages/acp/src tests/unit/acp-builtin-permission.test.ts` exit 0
- `pnpm --filter @moss/acp typecheck` and root `tsc --noEmit` exit 0
- `eslint` on touched files `--max-warnings=0` exit 0; `prettier --check` exit 0
- No DB-touching tests; no full gate (verify-gate skill owns that path).
