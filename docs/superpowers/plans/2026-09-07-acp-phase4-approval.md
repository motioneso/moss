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
  (`toolCallId`, optional `kind`, `locations`, `rawInput`, `title`, declared
  `_meta`), and `options` (SDK `types.gen.d.ts`, `RequestPermissionRequest`).
  The stock adapter sends only `toolCallId`, `rawInput`, `title` plus
  allow/reject options (adapter `dist/acp-agent.js`, `canUseTool`) — no tool
  name, and the title is model-written, so nothing in the stock payload can
  identify the tool. Our pnpm patch (`patches/@zed-industries__claude-code-acp@0.16.2.patch`)
  adds `_meta: { toolName }` from the adapter's own `canUseTool` argument;
  `_meta` is a declared protocol field, so it survives the SDK receive-side
  validation that strips undeclared fields. Absent name refuses, by design.
- `@moss/acp` has no workspace dependencies (`packages/acp/package.json`); adding
  `@moss/ai -> @moss/acp` introduces no cycle.

## Decisions

- New `packages/acp/src/permissions.ts` (pure, no DB, no fs):
  - `classifyAcpPermission(request: AcpBuiltInRequest, cwd: string): "allow" | "ask" | "deny"`.
    Identity is the real name from `toolCall._meta` only — never the title.
    Named read-only tools allow; named writes allow only when every referenced
    path sits inside `cwd`, else ask; shell, subagent (`Task`), and mode changes
    always ask; absent or unlisted name denies without asking.
  - Explicit lists: `ACP_READ_TOOL_NAMES`, `ACP_WRITE_TOOL_NAMES`,
    `ACP_ASK_TOOL_NAMES`, `ACP_DESTRUCTIVE_TOOL_NAMES` (card seriousness),
    `ACP_PATH_INPUT_KEYS` (`file_path`, `notebook_path`, `path`). Lexical cwd
    containment only; links are not resolved. The runner block list switches
    built-in writing off entirely today, so the in-folder write allow cannot
    fire until phase 5 turns the feature on — the rule is written for that
    shape, not today's.
  - `selectAllowOptionId(options): string | null` picks the least-privilege allow
    choice (first `allow_once`, else first `allow*` kind); null means deny.
- `packages/acp/src/client.ts`: new optional `AcpPermissionDecider`
  (`decide(request): Promise<RequestPermissionResponse>`) on the client events;
  per-session cwd remembered at open. No decider keeps today's deny-closed
  behavior. Allow answers select the decider's option; deny answers `cancelled`.
- `packages/ai/src/gateway/acp-permission.ts`: new
  `requestAcpBuiltInPermission(deps, token, input)` where input carries `cwd`,
  `sessionId`, `toolCallId`, `title`, `rawInput`, the real `toolName`, plus
  optional `kind`. Verifies the token (owner attribution), classifies via
  `@moss/acp`, then: allow returns without a row; deny returns without a row
  (including null name); ask creates the same pending row and emits the same
  `action_request` event as the native path, awaits the same registry, emits
  `action_result` (`allowed`, or `denied` with `APPROVAL_REFUSED_REASON` on
  deny/timeout), and `markDone`s. The row's `inputSummary` carries the agent
  session and folder as plain identifiers (values stay out); the card is marked
  destructive for shell, subagent, delete, move, and execute. The class keeps a
  thin delegate so `gateway.ts` stays under the size gate. No second policy,
  no second wording, enforcement point unchanged.
- Exports: `permissions.ts` from `packages/acp/src/index.ts`; gateway method plus
  its input/output types from `packages/ai/src/gateway/index.ts`. Workspace dep
  `@moss/ai -> @moss/acp` declared in `packages/ai/package.json`.
- No app-map change in this phase: the card, screens, settings, and errors are
  unchanged; phase 5 carries the workshop map entries.

## Test cases (behavior plus what breaks them)

- `packages/acp/src/permissions.test.ts`: every verdict test feeds the exact
  adapter payload (id, input, title, `_meta` name) — never kind or locations.
  Covers: absent name refuses whatever the title claims; unlisted name refuses;
  named reads allow; named writes inside allow and outside ask; shell, subagent,
  and mode changes ask; traversal asks; a `Task` titled like a read asks with
  the real name and refuses without it; picker prefers `allow_once`, null when
  none allows. Each fails if the name lists, extraction, or containment regress.
- `packages/acp/src/client.test.ts` additions: wired decider answering allow
  produces a `selected` outcome on the permission id; absent decider keeps the
  `cancelled` default (existing test). Fails if the hook is bypassed.
- `tests/unit/acp-builtin-permission.test.ts`: ask path creates a pending row owned
  by the token's actor and emits `action_request` matching the native shape, with
  agent session and folder saved as identifiers and no command content;
  confirming through `gateway.resolveActionRequest` (the function the Approve route
  calls) returns allow; timeout returns deny with `APPROVAL_REFUSED_REASON`;
  allow/deny paths create no row; read-mimicking title with no name refuses with
  no row; `Task` asks marked destructive; bad token throws. Fails if a second
  event shape, wording, or attribution path appears.
- Phase E2E (in the same unit file, no DB): scripted agent permission request →
  client decider → gateway ask → `resolveActionRequest` as owner → agent receives
  `selected/allow`. This is the attended-approval path with the human step played
  through the exact function the UI calls; in-browser proof lands with phase 5 UAT.

## Determinism boundary

Permission answers are protocol outcomes, never chat text. The card renders from
the persisted pending row and notifier events, never from agent output.

## Verification (unpiped, expected exit 0)

- `vitest run packages/acp/src tests/unit/acp-builtin-permission.test.ts` exit 0
- `pnpm --filter @moss/acp typecheck` and root `tsc --noEmit` exit 0
- `eslint` on touched files `--max-warnings=0` exit 0; `prettier --check` exit 0
- No DB-touching tests; no full gate (verify-gate skill owns that path).
