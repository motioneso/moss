# w5c-chat-surface relay 2 — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (read by section only)
**Issue:** #1254, lane C, risk tier `sensitive`
**Branch/worktree:** `w5c-chat-surface`, clean, **still no commits — no code or plan file written yet**
**Coordinator:** Herdr label `Coordinator` — **re-resolve fresh, it has relayed at least twice**
(was `coord-relay2`, now `coord-waves36-r4` as of this write — do not reuse either name, re-resolve
by label + confirm exactly one pane holds it, per `herdr-pane-message`)

## State: design fork RESOLVED, seams check in progress, plan NOT started

Prior relay's flagged design fork is **confirmed by the coordinator**: priority chain is
`tool.summarize?.() ?? tool.actionLabel ?? tool.description ?? tool.name` (additive, does not
regress existing description fallback). This is settled — do not re-litigate it.

**Lane C owns (only):** `packages/module-sdk/src/index.ts`, `packages/shared/*-api.ts`, the
approval-card component (`apps/web/src/chat/action-request-card.tsx`).
**Must NOT touch:** `apps/web/src/chat/use-chat-stream.ts`, `apps/web/src/shell/app-shell.tsx`
(Lane A, #1449 — concurrently building).

## Seams confirmed this relay (file:line, on this branch)

- `packages/module-sdk/src/index.ts:517-570` — `ModuleAssistantToolManifest` has `summarize?:
  ToolSummarize`. Add `actionLabel?: string` here.
- `packages/module-sdk/src/external-module.ts:179-192` — `ExternalModuleAssistantToolDeclaration`,
  JSON-only (job-search etc). Add the same `actionLabel?: string` plain field for parity.
- `packages/ai/src/gateway/gateway.ts:613-627` — `summaryFor()`: currently `tool.summarize?.() ??
  tool.description`. Change to the confirmed 4-step chain. Not lane-owned; tentatively touchable
  per prior relay, unconfirmed explicitly but implied by the coordinator's design-fork approval
  (the fork *is* summaryFor's signature) — treat as in-scope, flag if coordinator objects.
- `packages/ai/src/gateway/gateway.ts:512-610` — `confirmAndRun()` — unchanged, calls
  `this.summaryFor(...)` at line 537; no signature change needed there.
- **NEW, not in original seams check:** `packages/module-registry/src/external/tool-manifests.ts:48-63`
  — `createExternalToolManifests()` maps `ExternalModuleAssistantToolDeclaration` →
  `ModuleAssistantToolManifest`-shaped object field-by-field (name/description/permissionId/risk/
  actionFamilyId/executionPolicy/selfOperationGrant/requiresConfirmation/inputSchema/outputSchema/
  execute). **Does not currently pass through `actionLabel`** — without adding it here, a
  job-search-declared label is silently dropped before it ever reaches `summaryFor()`. This file is
  outside Lane C's declared ownership (`module-sdk/*`, `shared/*-api.ts`, `action-request-card.tsx`)
  — **flagged to coordinator in this relay's outgoing message, unconfirmed as of write time.
  Check for a reply before touching this file; if none landed, re-flag fresh (same procedure as the
  original design-fork flag).**
- `packages/module-registry/src/external/validate.ts` — checked for a per-tool unknown-key
  allowlist (the pattern that strips top-level manifest fields at ~948-980). **None exists for
  individual `assistantTools[]` entries** — `obj.assistantTools` is cast wholesale at line 967-969,
  not rebuilt field-by-field. So `actionLabel` on a job-search tool survives validation with **no
  validate.ts change needed** — confirmed, do not add one.
- `packages/shared/src/ai-audit-api.ts:99-103` — `ActionAuditInputSummary` — IS Lane-C-owned
  (`*-api.ts` glob), metadata-only, unaffected by this change (audit persists `inputSummary`, not
  the display summary).
- `packages/shared/src/ai-types.ts:144-153,181-194` — `AiAssistantToolDto`, `AiAssistantActionDto`
  — does NOT match `*-api.ts` glob, ownership still unconfirmed, re-check before touching.
- `apps/web/src/chat/action-request-card.tsx` (135 lines) — single `<p
  className="action-request-summary">{props.summary}</p>`; `toolName` prop unused in JSX (#1250-era
  deliberate decision, comment at lines 69-74). **`tests/unit/action-request-card-preview.test.tsx`
  read in full this relay** — it asserts (line ~51-63, commit `2493b3da`) the card's *heading
  label* (state word like "Needs your approval") must never leak a raw tool identifier. This is
  about the heading, NOT the `summary` paragraph — does not conflict with the actionLabel chain,
  which only feeds `summary`. **Preserve that heading test unchanged.**
- `apps/web/src/chat/message-row.tsx:150-168` — `RecordRow()` passes `summary={record.summary ??
  text}`, `toolName={record.toolName ?? kind}` into the card. Not lane-exclusive; probably safe,
  unconfirmed.
- `apps/web/src/chat/use-chat-stream.ts` (Lane A, DO NOT EDIT) — existing `toolName`+`summary` wire
  fields already flow through `TranscriptRecord`/`parseRecord`; reuse, don't add new wire fields.

## Next concrete steps

1. Check `herdr pane list` for the pane currently labeled `Coordinator` (re-resolve fresh — it has
   already relayed twice this run) for a reply on the `tool-manifests.ts` ownership question above.
   If none landed, re-flag via `herdr-pane-message`.
2. Write the plan at `docs/superpowers/plans/2026-08-09-1254-approval-card-action-label.md` per
   `plan-build`: manifest field additions (2 interfaces above), `summaryFor()` new 4-step priority
   chain, `tool-manifests.ts` field passthrough (pending confirmation), test cases (declared label
   renders / undeclared+no-description falls back to name / description-only tool still shows
   description — no regression / heading test from `action-request-card-preview.test.tsx` stays
   green), verification commands unpiped w/ exit codes, kill gate after phase 1.
3. Message coordinator with plan path, STOP for approval — do not build before it.
4. TDD build, `coordinated-wrap-up` after.

## Misc

- `gh issue view --json body` returns an unread `<<ccr:...>>` marker on this repo; use `gh api
  repos/motioneso/moss/issues/1254 --jq '.body'` instead.
- No test file exists yet for `summaryFor`/manifest `actionLabel` field itself — only the card
  component test exists (read in full, see above).
