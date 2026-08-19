# Plan — #1254: approval-card action label

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (read by section
across relay 1/2, not re-read in full for this plan)
**Issue:** #1254, lane C
**Risk tier:** sensitive
**Branch:** `w5c-chat-surface` (worktree, no commits yet)

## Problem (verified against branch)

`packages/ai/src/gateway/gateway.ts:613-627` — `summaryFor()` falls back straight from
`tool.summarize?.()` to `tool.description` (`gateway.ts:626`). A module tool can never supply
`summarize` (module manifests are JSON, `summarize` is a function field) — so every module-declared
write action shows its raw `description` on the approval card, e.g. `"job-search.criteria.set (2
field(s))"` instead of a human-authored label like `"Update your job search criteria"`.

## Design decision (confirmed by coordinator, relay 1 — do not re-litigate)

New priority chain:

```
tool.summarize?.() ?? tool.actionLabel ?? tool.name
```

## Seams check (file:line, verified fresh on this branch before writing this plan)

- `packages/module-sdk/src/index.ts:517-570` — `ModuleAssistantToolManifest`. `description` is a
  **required** `string` (line 519); `summarize?: ToolSummarize` already optional (line 534). Add
  `actionLabel?: string`.
- `packages/module-sdk/src/external-module.ts:179-192` — `ExternalModuleAssistantToolDeclaration`.
  `description` likewise required (line 181). Add the same `actionLabel?: string` plain field.
- `packages/module-registry/src/external/tool-manifests.ts:29-65` —
  `createExternalToolManifests()` remaps `ExternalModuleAssistantToolDeclaration` →
  `ModuleAssistantToolManifest`-shaped object field-by-field at lines 48-63. **Confirmed:
  `actionLabel` is not in the field list** — without adding it, a job-search-declared label is
  silently dropped before `summaryFor()` ever sees it. **Coordinator has approved this file for
  Lane C this run** (outside Lane C's originally declared glob `module-sdk/*`, `shared/*-api.ts`,
  `action-request-card.tsx`) — tracked in the coordinator's manifest collision map so Wave 4 lane C
  (#1274/#1275/#1279, security tier, not yet spawned) rebases on this change.
- `packages/module-registry/src/external/validate.ts:630-661,967-969` — per-tool validation
  accepts `actionLabel` only as trim-nonempty plain text: at most 80 JavaScript UTF-16 code units
  and no C0/DEL controls (`U+0000`-`U+001F`, `U+007F`). The manifest reshape at 967-969 casts
  `obj.assistantTools` wholesale, so no separate allowlist change is needed.
- `packages/ai/src/gateway/gateway.ts:613-627` — `summaryFor()`, the fallback site. Signature
  unchanged (`tool`, `input`, `ctx` → `string`).
- `packages/ai/src/gateway/gateway.ts:512-611` — `confirmAndRun()` calls `this.summaryFor(...)` at
  line 537 only; no signature or call-site change.
- `apps/web/src/chat/action-request-card.tsx` (135 lines) — **no source change**. It already
  renders `props.summary` verbatim at line 85; the change is entirely which string the server sends
  as `summary`. `tests/unit/action-request-card-preview.test.tsx` line ~51-63 (commit `2493b3da`)
  asserts the **heading** (`"Needs your approval"` / `"Approved"` / `"Not approved"`, lines 79-84)
  never leaks a raw tool identifier — that's a different string (the eyebrow label) than
  `props.summary` and is untouched by this chain. Run unchanged as a regression check.
- `apps/web/src/chat/message-row.tsx:150-168` — `RecordRow()` already passes `record.summary ??
text` through unchanged (line 161). No change needed; the summary field is already wired
  end-to-end from `ChatGatewayNotifier` (confirmed by `tests/unit/gateway-notifier.test.ts:31-53`,
  which asserts `record.summary` round-trips from `notifier.emit(...)`'s `summary` field).
- `apps/web/src/chat/use-chat-stream.ts` — Lane A (#1449, concurrently building). **Not touched.**
  No new wire field is introduced; `summary` already flows through `TranscriptRecord`.
- `packages/shared/src/ai-audit-api.ts:99-103` — `ActionAuditInputSummary` (Lane-C-owned glob).
  Confirmed unaffected: the audit row persists `inputSummary` (key-names-only), never the display
  summary string. No change.
- `packages/shared/src/ai-types.ts:144-153` (`AiAssistantToolDto`), `:181-194`
  (`AiAssistantActionDto`) — does not match the `*-api.ts` glob. **Resolved out of scope, no
  change**: these DTOs back the REST tool-list/action-list endpoints (consumers confirmed via
  grep: `apps/web/src/api/client.ts`, `packages/ai/src/routes.ts`,
  `packages/ai/src/assistant-tools.ts`, `packages/chat/src/mcp-transport.ts`,
  `apps/web/src/briefings/briefing-settings-model.ts`) — a separate surface from the live SSE
  `action_request` card path, which flows through `ChatGatewayNotifier` → `TranscriptRecord`
  and carries `summary` as a plain string already, independent of these DTOs.

## Changes (contracts only)

### 1. `packages/module-sdk/src/index.ts` — `ModuleAssistantToolManifest`, after line 534

```ts
readonly summarize?: ToolSummarize;
/**
 * Optional human-authored label for the approval-card summary (e.g. "Update your job search
 * criteria"), used when the tool declares no `summarize` function. Falls back to the tool's
 * `name` when unset — see gateway.ts `summaryFor()`.
 */
readonly actionLabel?: string;
```

### 2. `packages/module-sdk/src/external-module.ts` — `ExternalModuleAssistantToolDeclaration`, after line 181 (`description`)

```ts
readonly description: string;
readonly actionLabel?: string;
```

### 3. `packages/module-registry/src/external/tool-manifests.ts` — field passthrough, inside the map at lines 50-62

```ts
return {
  name: tool.name,
  description: tool.description,
  actionLabel: tool.actionLabel,
  permissionId: tool.permissionId,
  // ...unchanged fields below
```

### 4. `packages/ai/src/gateway/gateway.ts` — `summaryFor()`, replace lines 618-626

```ts
private summaryFor(
  tool: ModuleAssistantToolManifest,
  input: Record<string, unknown>,
  ctx: ToolContext
): string {
  if (typeof tool.summarize === "function") {
    return tool.summarize(input, ctx);
  }
  return tool.actionLabel ?? tool.name;
}
```

`description` remains required metadata, but it is not approval-card fallback copy. When neither
`summarize` nor `actionLabel` exists, the runtime deliberately displays the tool's `name`.

## Test cases

### `tests/unit/gateway-summary-action-label.test.ts` (new file, harness copied from

`tests/unit/gateway-action-preview.test.ts`'s `buildGateway` helper)

1. **"uses actionLabel over description when the tool declares no summarize"** — module tool has
   `actionLabel: "Send the calendar invite"`, `description: "calendar.write (2 field(s))"`, no
   `summarize`. Assert the emitted `action_request` record's `summary` is exactly `"Send the
calendar invite"`. Fails against current code (returns the description string).
2. **"falls back to tool name when actionLabel is undeclared"** — no `actionLabel` on the tool.
   Assert `summary` equals `tool.name` verbatim.
3. **"summarize still wins over actionLabel when both are declared"** — tool declares both
   `summarize: () => "computed summary"` and `actionLabel: "static label"`. Assert `summary` is
   `"computed summary"`. Proves the chain is additive, not a reordering.

### `tests/unit/external-tool-manifests.test.ts` (existing file, add one case)

4. **"passes actionLabel through the field-by-field remap"** — `createExternalToolManifests()`
   given a discovery whose `assistantTools[0].actionLabel = "Update your criteria"`; assert the
   returned manifest's `assistantTools[0].actionLabel === "Update your criteria"`. Fails against
   current code (field silently dropped at the map in tool-manifests.ts:50-62).

### `tests/integration/external-module-gateway.test.ts` (existing file, add one case — DB-touching, proves the full wire, not just each unit)

5. **"threads a declared actionLabel from the external manifest to the action_request summary"** —
   extend the existing discovery fixture pattern (mirrors the test at line 33) with
   `assistantTools[0].actionLabel = "Send the write"`; call the tool; assert the emitted
   `action_request` record's `summary === "Send the write"`. Fails against current code (manifest
   passthrough drops the field before `summaryFor()` runs), and would also fail if only the gateway
   were fixed without the `tool-manifests.ts` passthrough — this is the case that proves both
   layers are wired together, not just individually correct.

### Regression check, no new case

`tests/unit/action-request-card-preview.test.tsx` — run unchanged. Confirms the heading-never-
leaks-tool-identifier assertion still passes (it targets a different string than `summary`).

### `tests/unit/external-validate.test.ts` (existing manifest-validation seam)

6. Accept an 80-code-unit `actionLabel` and reject 81 code units.
7. Reject every C0/DEL control character in `actionLabel`; existing cases retain the
   trim-nonempty and string-type checks.

## Why no new Playwright/e2e case

No UI/UX surface changes — `action-request-card.tsx` is untouched, already renders
`props.summary` today. This plan changes only which string the server computes for that existing
prop. Wiring is proven end-to-end by integration test case 5 (real DB, real
`createExternalToolManifests` → `AssistantToolGateway` → notifier emit path), which is the
determinism-boundary-relevant proof here: the card still renders deterministically from the
persisted/emitted record, never from a model turn — that invariant is unchanged by this plan.

## Verification

```bash
pnpm vitest run tests/unit/gateway-summary-action-label.test.ts tests/unit/external-tool-manifests.test.ts tests/unit/action-request-card-preview.test.tsx tests/unit/external-validate.test.ts > /tmp/1254-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` **and** a non-empty log containing a `Tests N passed` line — do not accept `EXIT=0`
alone as proof (see `pnpm-filter-test-is-a-false-green` memory: a `pnpm --filter <pkg> test` form
can exit 0 having run zero tests because workspace packages declare no `test` script; root
`pnpm vitest run tests/unit/<file>.test.ts` is the confirmed-real form).

Integration test (requires isolated gate DB — via `verify-gate` skill, never run bare):

```bash
# run via verify-gate skill, not directly
pnpm vitest run tests/integration/external-module-gateway.test.ts > /tmp/1254-integration.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, log contains `Tests N passed`.

Full gate at wrap-up (`verify-gate` skill, isolated DB, unpiped):

```bash
pnpm verify:foundation > /tmp/1254-gate.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

## Kill gate

Single phase — the action-label contract, passthrough, runtime fallback, external validation, and
their focused tests/docs. If test case 5 (the integration wire-proof) cannot
be made to fail against current `main` before the fix and pass after, stop and escalate to
`Coordinator` rather than ship an unverified wire — owner: this build agent. No phase 2 is planned;
this is the whole fix.

## Open items resolved by this plan (do not re-flag)

- `tool-manifests.ts` ownership: **approved for Lane C this run**, per relay 3 boot brief.
- `ai-types.ts` (`AiAssistantToolDto`/`AiAssistantActionDto`): **out of scope**, confirmed separate
  surface (see seams check above).
- `validate.ts`: actionLabel is now bounded plain text; the wholesale per-tool cast remains safe
  because validation runs before the cast.
