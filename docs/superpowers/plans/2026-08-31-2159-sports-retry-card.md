# Plan: restore sports.retrySource action card (#2159)

Spec: `docs/superpowers/specs/2026-08-23-1909-sports-public-source-completion.md`
Parent plan: `docs/superpowers/plans/2026-08-23-1909-sports-public-source-completion.md`
Task issue: #2159 ("task: restore sports.retrySource action card in live UAT")

## What the issue actually reports

Live UAT for #2149 twice timed out at
`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts:228`: the assistant is told
(over MCP, real chat) to call `sports.retrySource` with a specific `sourceId`, and no matching
"Action request" card ever appears in the browser. No third live attempt has been run.

## Seams check (file:line, verified on this branch)

- Tool declared correctly: `packages/sports/src/manifest.ts:483-499` —
  `sports.retrySource`, `risk: "write"`, `actionFamilyId: "sports.sources"`,
  `selfOperationGrant: "confirm_always"`, handler `sportsRetrySourceExecute`.
- Family declared correctly: `packages/sports/src/manifest.ts:303-309` — `sports.sources`
  family, `defaultTier: "ask_each_time"`, `allowedTiers` excludes `trusted_auto`, so
  `resolvePolicy` (`packages/ai/src/gateway/policy.ts:30-59`) can only return `"confirm"` for it —
  never `"run"`.
- Summary text matches what the UAT selector expects: `packages/sports/src/chat-tools.ts:276-277`
  produces exactly `Retry sports source ${sourceId}`, matching the UAT's
  `new RegExp('Retry sports source ' + failing.id)` at
  `tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts:323`.
- Tool listing has no permission/tier filter that could hide a `confirm_always` tool:
  `packages/ai/src/gateway/gateway.ts:836-881` (`executableTools`) only excludes tools missing an
  `execute` function, centrally self-operation-excluded tools, read tools that wrongly declare
  services, or tools whose declared services are unavailable — none apply to `sports.retrySource`.
- MCP transport passes the listed/dto tool straight through with no additional filter:
  `packages/chat/src/mcp-transport.ts:100-111` (`tools/list`), `:113-133` (`tools/call`).
- The confirm path that should create the pending row and emit the card is
  `packages/ai/src/gateway/gateway.ts:701-751` (`confirmAndRun`): creates the pending action,
  awaits resolution, emits `notifier.emit(..., { kind: "action_request", ... })` with the summary.
- The frontend card component that must render on that event is
  `apps/web/src/chat/action-request-card.tsx:59-126` — generic, shared by every action family,
  no sports-specific branch.
- A real (non-fixture) integration pattern already exists for driving the sports manifest
  through the actual gateway without a live model:
  `tests/integration/mcp-gateway-self-operation.test.ts:295-376` builds a gateway with
  `resolveActiveModules: async () => [sportsModuleManifest]` and calls
  `sportsGateway.callTool(token, "sports.followTeam", {...})` directly.

**Conclusion of the seams check:** every piece of manifest/policy/summary wiring that can be read
statically is correct. Nothing in the reachable source explains a missing card. The defect is
therefore either (a) something that only shows up when the tool is actually invoked end-to-end
(a runtime path not covered by any existing test), or (b) the model never calls the tool at all
during a live turn (a tool-selection/discovery problem outside this repo's deterministic code,
e.g. prompt guidance or `ToolSearch` behavior). Exit criteria in the handoff doc call this "the
split" — no existing test currently distinguishes these two cases, which is the gap this plan
closes first.

## Phase 1 — smallest regression check that proves the actual boundary

**New file:** `tests/integration/sports-retry-source-card.test.ts`

Follows the `mcp-gateway-self-operation.test.ts:295-376` pattern (real `sportsModuleManifest`,
real `AssistantToolGateway`, real `ConfirmationRegistry`, no live LLM, no browser) plus the real
MCP HTTP transport from `chat-mcp-transport.test.ts`, so it exercises exactly the two seams the
UAT cannot isolate:

1. `tools/list` over the real `/api/mcp` route (via `registerMcpTransportRoute`) for an actor with
   an installed Sports module, with a seeded `sports.sources` row in state `failing` (reuse the
   `sports-sources-repository.test.ts` seeding helpers if present, else the minimal insert the
   existing sports integration tests already use) — asserts the returned tool list contains an
   entry named exactly `sports.retrySource` with an `inputSchema` requiring `sourceId`.
   **This is the "no pending row" branch of the split**: if this assertion fails, tool
   availability/selection is the broken boundary, and Phase 2 targets manifest/gateway listing.
2. `tools/call` for `sports.retrySource` with that source's id, asserting, in order:
   - `notifier.emit` (a `vi.fn()` double passed into the gateway, same shape as
     `mcp-gateway-self-operation.test.ts` uses) is called with
     `{ kind: "action_request", toolName: "sports.retrySource", summary: expect.stringMatching(/^Retry sports source /) }`
     before the call resolves.
   - The pending row is queryable via `AiRepository` (or via the resolve route, following
     `chat-mcp-transport.test.ts`'s `registerResolveRoute` helper) with `status: "pending"`.
   - Resolving it `"confirmed"` lets `tools/call`'s in-flight promise settle with the retry's real
     result, and a second `notifier.emit` call with `kind: "action_result"`, `outcome: "executed"`.
   **This is the "row exists" branch of the split**: if step 1 passes but any assertion in step 2
   fails, the defect is in `confirmAndRun`/notifier/stream delivery, not tool selection, and
   Phase 2 targets `gateway.ts:701-751` or the SSE stream that carries `action_request` to the
   browser (`packages/chat/src/routes.ts` — not yet read in this pass; Phase 2 reads it only if
   this branch is the one that fails).

Verification:
```bash
# via verify-gate only — this is a DB-touching test
```
Expected: the coordinator/verify-gate skill runs this file in isolation; expected exit code 0 if
the gateway-level path is intact, non-zero with a specific assertion failure otherwise. Either
outcome is informative — this phase's job is the signal, not a guaranteed pass.

## Kill gate after Phase 1

**Owner: this session, reported to the coordinator before any Phase 2 code changes.**

- If Phase 1's test **passes end-to-end** (both branches green): the gateway/notifier/DB path is
  provably intact, so the defect is outside this repo's deterministic surface — most likely the
  live model's tool selection during a real turn, or an SSE/stream wiring issue that only exists
  in the real chat route (not the direct-gateway test double). Report this finding to the
  coordinator with the passing test as evidence before writing any further code — this may turn
  into a documentation/prompt-guidance fix rather than a gateway fix, which is a fork the
  coordinator should confirm before Phase 2 proceeds.
- If Phase 1's test **fails**: the failure's assertion + stack trace names the exact broken
  boundary. Phase 2 is scoped narrowly to that one boundary (tool listing vs. confirm/notify path)
  and is planned in a follow-up message to the coordinator once the failure is in hand — not
  guessed now.

## Phase 2 (scope to be confirmed against Phase 1's result before writing code)

Not planned in detail yet, per the kill gate above. Candidate fix locations already identified by
the seams check, for whichever branch Phase 1 implicates:
- Tool availability/selection: `packages/ai/src/gateway/gateway.ts:836-881`,
  `packages/chat/src/mcp-transport.ts:100-111`.
- Notifier/stream/card delivery: `packages/ai/src/gateway/gateway.ts:701-751`,
  `packages/chat/src/routes.ts` (SSE stream — read before editing).

## Live-path re-proof (after Phase 2's fix, only)

Re-run the matched UAT (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts`) via
`verify-gate`, with its own isolated database/ports/browser/renderer resources — the prior two
attempts (`/tmp/2149-uat.log`, `/tmp/2149-uat-retry.log`) are evidence of the failure, not runs to
repeat unchanged.

## Collision notes carried from the handoff

- `gateway.ts`, `confirmation-registry.ts`, chat transport, and owner-scope tests overlap PR 2158
  (parked, do not touch/reuse). If Phase 2 must land in `gateway.ts`, call out the overlap to the
  coordinator explicitly before editing — 2159 lands first, PR 2158 rebases after.
- No migration expected; none added unless Phase 1's finding proves the current data model can't
  represent the correct state, and the coordinator approves that as a design change.
