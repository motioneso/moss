# w5c-chat-surface relay — 2026-08-09

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (read by section only)
**Issue:** #1254, lane C, risk tier `sensitive`
**Branch/worktree:** `w5c-chat-surface`, clean, no commits yet — **no code written this lane so far**
**Coordinator:** Herdr label `Coordinator` (session id is authority per handoff doc; label routes) —
already messaged that this relay is happening and flagged the fork below; no reply expected before resuming
**Handoff doc:** `docs/coordination/waves-3-6-prep/handoff-w5c-chat-surface.md` — reread it, it's short

## State: pre-plan, seams check done

Step 0 (orient) and step ½ (verify spec vs branch) of `coordinated-build` are done. Step 1 (write
plan via `plan-build`, then message coordinator for approval) has NOT started — no plan file
written yet. **Do not re-read the spec in full** — sections already covered: Context/Goals,
Lanes/collision map, Exit criteria, Dependency order, Hard-invariants-honored.

**Lane C owns (only):** `packages/module-sdk/src/index.ts`, `packages/shared/*-api.ts`, the
approval-card component (`apps/web/src/chat/action-request-card.tsx`).
**Must NOT touch:** `apps/web/src/chat/use-chat-stream.ts`, `apps/web/src/shell/app-shell.tsx`
(Lane A, #1449 — concurrently building).

## Exit criterion for #1254

"A test proves a declared label renders and an undeclared tool falls back to its name; live proof
shows a human-readable approval card."

## Seams check (file:line, confirmed on this branch)

- `packages/module-sdk/src/index.ts:517-570` — `ModuleAssistantToolManifest`, has `summarize?:
  ToolSummarize`. Natural home for new `actionLabel?: string`.
- `packages/module-sdk/src/external-module.ts:179-192` — `ExternalModuleAssistantToolDeclaration`
  (job-search etc.) — JSON-only, no function fields. Needs the same `actionLabel?: string` (plain
  field, no function) for parity — job-search is the issue's literal example.
- `packages/ai/src/gateway/gateway.ts:613-627` — `summaryFor()`: `tool.summarize?.() ??
  tool.description`. **This already returns a human sentence, not the raw name** — the "regresses
  to raw name" failure mode the issue describes is NOT currently visible to users via this path.
- `packages/ai/src/gateway/gateway.ts:512-610` — `confirmAndRun()`: builds pending-action row +
  emits SSE `action_request` with `toolName`+`summary`. Not a lane-owned file but not Lane A/B/D's
  either — tentatively touchable, unconfirmed with coordinator.
- `packages/shared/src/ai-audit-api.ts:99-103` — `ActionAuditInputSummary = {inputKeys,
  inputKeyCount, truncated}` — persisted shape is metadata-only, matches the box's hard invariant.
  IS Lane-C-owned (`*-api.ts` glob).
- `packages/shared/src/ai-types.ts:144-153,181-194` — `AiAssistantToolDto`, `AiAssistantActionDto`.
  Does NOT match `*-api.ts` glob — ownership unconfirmed.
- `apps/web/src/chat/action-request-card.tsx` (135 lines, read in full) — single `<p
  className="action-request-summary">{props.summary}</p>`; `toolName` prop exists but is UNUSED in
  JSX. Comment at lines 69-74 records a prior deliberate decision (#1250-era) to drop a
  raw-tool-name eyebrow in favor of state-word + description — reintroducing a name-as-heading
  would partially reverse that.
- `apps/web/src/chat/message-row.tsx:150-168` — `RecordRow()` passes `summary={record.summary ??
  text}`, `toolName={record.toolName ?? kind}` into the card. Not listed as any lane's exclusive
  file; probably safe but unconfirmed.
- `apps/web/src/chat/use-chat-stream.ts` (Lane A, DO NOT EDIT) — `TranscriptRecord` (34-51) and
  `parseRecord()` allowlist (224-262) are where any *new* wire field would need to land. Existing
  `toolName`+`summary` fields already flow through today — reuse, don't add, if possible.
- No existing test file for `summaryFor`/`actionLabel` found; `tests/unit/action-request-card-
  preview.test.tsx` exists for the card component (not yet read).

## Open design fork — flagged to coordinator, not yet resolved

Literal reading of the exit criterion ("undeclared tool falls back to its **name**") conflicts with
current behavior (falls back to **description**, already human-readable). Adopting the literal
fallback chain (`actionLabel ?? tool.name`) as a *replacement* for `summaryFor()` would regress
every tool that hasn't yet declared a label from a decent sentence to a raw dotted name like
`job-search.criteria.set`.

**Recommended resolution** (proposed to coordinator, awaiting confirmation): make `actionLabel`
additive and higher-priority than the existing fallback, not a replacement:
`tool.summarize?.() ?? tool.actionLabel ?? tool.description ?? tool.name`. This satisfies both exit
criteria literally (declared label renders; a tool with genuinely nothing declared — no summarize,
no actionLabel, no description — falls back to name) without regressing any tool that already has a
description. Live-proof plan: add `actionLabel` to one job-search manifest tool (e.g.
`job-search.criteria.set`) for the demo.

**Next agent: do not write code or the plan file until this is confirmed** (or re-flag it
yourself to the coordinator pane if no reply has landed — resolve pane fresh by label
`Coordinator`, never a cached `…-N`).

## Next concrete steps

1. Check `herdr pane read` on the Coordinator pane (label `Coordinator`, re-resolve fresh) for a
   reply to the flagged fork above.
2. Write the plan at `docs/superpowers/plans/2026-08-09-1254-approval-card-action-label.md` per
   `plan-build` (decisions not code): manifest field additions, `summaryFor()` new signature/priority
   order, test cases (declared label renders / undeclared falls back to name / description-only
   tool still shows description — no regression), verification commands unpiped w/ exit codes, kill
   gate after phase 1.
3. Message coordinator with plan path, STOP for approval — do not build before it.
4. TDD build, `coordinated-wrap-up` after.

## Misc

- `gh issue view --json body` returns an unread `<<ccr:...>>` marker on this repo; use `gh api
  repos/motioneso/moss/issues/1254 --jq '.body'` instead.
