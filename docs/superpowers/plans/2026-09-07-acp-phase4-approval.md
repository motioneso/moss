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
  (`toolCallId`, optional `kind`, `locations`, `rawInput`, `title`), and `options`
  (`packages/acp` SDK `types.gen.d.ts`, `RequestPermissionRequest`).
  The Claude Code adapter sends only `toolCallId`, `rawInput`, `title` plus
  allow/reject options (adapter `dist/acp-agent.js`, `canUseTool`), so the policy
  must classify from `kind`/`locations` when present and from `rawInput`/`title`
  otherwise. Verified against adapter `dist/tools.js` title table.
- `@moss/acp` has no workspace dependencies (`packages/acp/package.json`); adding
  `@moss/ai -> @moss/acp` introduces no cycle.

## Decisions

- New `packages/acp/src/permissions.ts` (pure, no DB, no fs):
  - `classifyAcpPermission(request: AcpBuiltInRequest, cwd: string): "allow" | "ask" | "deny"`.
    Read-only kinds (`read`, `search`, `fetch`, `think`) allow. `edit` allows only
    when every referenced path sits inside `cwd`, else asks. `delete`, `move`,
    `execute`, `switch_mode` always ask. Anything unrecognised denies.
  - Explicit lists: `ACP_READ_ONLY_KINDS`, `ACP_WRITE_KINDS`, `ACP_ASK_KINDS`,
    `ACP_PATH_INPUT_KEYS` (`file_path`, `notebook_path`, `path`), and a
    title-prefix table recovering the built-in name when `kind` is absent
    (adapter sends no kind). Lexical cwd containment only; symlink escape stays
    contained runner-side by owned dirs plus the settings deny.
  - `selectAllowOptionId(options): string | null` picks the least-privilege allow
    choice (first `allow_once`, else first `allow*` kind); null means deny.
- `packages/acp/src/client.ts`: new optional `AcpPermissionDecider`
  (`decide(request): Promise<RequestPermissionResponse>`) on the client events;
  per-session cwd remembered at open. No decider keeps today's deny-closed
  behavior. Allow answers select the decider's option; deny answers `cancelled`.
- `packages/ai/src/gateway/gateway.ts`: new
  `requestAcpBuiltInPermission(token, input)` where input carries `cwd`,
  `sessionId`, `toolCallId`, `title`, `rawInput`, plus optional `kind`/`locations`.
  Verifies the token (owner attribution), classifies via `@moss/acp`, then:
  allow returns without a row; deny returns without a row; ask creates the same
  pending row and emits the same `action_request` event as the native path, awaits
  the same registry, emits `action_result` (`allowed`, or `denied` with
  `APPROVAL_REFUSED_REASON` on deny/timeout), and `markDone`s. No second policy,
  no second wording, enforcement point unchanged.
- Exports: `permissions.ts` from `packages/acp/src/index.ts`; gateway method plus
  its input/output types from `packages/ai/src/gateway/index.ts`. Workspace dep
  `@moss/ai -> @moss/acp` declared in `packages/ai/package.json`.
- No app-map change in this phase: the card, screens, settings, and errors are
  unchanged; phase 5 carries the workshop map entries.

## Test cases (behavior plus what breaks them)

- `packages/acp/src/permissions.test.ts`: read/search/fetch/think allow; edit with
  all paths inside cwd allows; edit with one path outside asks; edit with no paths
  asks; Bash command rawInput asks; ExitPlanMode title asks; unknown title denies;
  `..` traversal against cwd asks; picker prefers the `allow_once` id and returns
  null when no allow option exists. Each fails if the kind lists, key lists, or
  containment check regress.
- `packages/acp/src/client.test.ts` additions: wired decider answering allow
  produces a `selected` outcome on the permission id; absent decider keeps the
  `cancelled` default (existing test). Fails if the hook is bypassed.
- `tests/unit/acp-builtin-permission.test.ts`: ask path creates a pending row owned
  by the token's actor and emits `action_request` matching the native shape;
  confirming through `gateway.resolveActionRequest` (the function the Approve route
  calls) returns allow; timeout returns deny with `APPROVAL_REFUSED_REASON`;
  allow/deny paths create no row; bad token throws. Fails if a second event shape,
  wording, or attribution path appears.
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
