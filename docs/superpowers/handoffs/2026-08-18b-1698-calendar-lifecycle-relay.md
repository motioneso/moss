# Relay — 1698-calendar-lifecycle (2026-08-18, 2nd relay)

**Spec:** `docs/superpowers/specs/2026-08-19-1693-calendar-event-lifecycle.md` — fully read by
section this session (all sections through "Further Notes"). Do not re-read in full; grep for a
specific decision/section if you need the exact wording.
**Issue:** #1698. **Risk tier:** sensitive. **Worktree/branch:** this one — no change needed.
**Coordinator:** resolve fresh by label `Coordinator` in `herdr pane list` — do not trust any pane
number written here. Not yet re-messaged this relay (still pre-plan).

## State

No implementation code written. No plan-build doc written yet either — this session finished the
seams/research pass (coordinated-build step 1) but ran out of context budget before writing
`docs/superpowers/plans/2026-08-19-1698-calendar-lifecycle.md`.

### Files read this session (do not re-read fully — cite from here)

- `packages/calendar/src/serialize.ts` (42 lines, read in full) — `JFB_PATTERN` regex derives
  `isMossBlock`; per spec this becomes a fallback only, replaced by consolidated
  `external_metadata.jarvisCreated` as source of truth.
- `packages/calendar/src/follow-through.ts` (43 lines) — `isCalendarFollowThroughEvent` already
  reads `jarvisCreated === true` from `external_metadata`; this is the pattern the new
  provenance-consolidation should match/reuse.
- `packages/calendar/src/focus-time.ts` (240 lines, read in full) — `resolveWindow`,
  `focusBlockEventId` (keyed on actor+window+duration+title, NOT chosen slot — load-bearing for
  idempotency), `chooseSlot`. No changes needed here per spec; reschedule reuses `chooseSlot`.
- `packages/connectors/src/google-api-client.ts` — `insertEvent` (254-291), `deleteEvent`
  (334-353), `freeBusy` (198+), private `postJson`/`deleteVoid`/`getJson`, all POST/GET/DELETE
  only. **No PATCH method exists.** `updateEvent`/reschedule needs a new `patchEvent` method
  mirroring `postJson`'s structure (same error handling, same `GoogleApiError` throw on non-ok)
  but with `method: "PATCH"` and a partial body (only start/end — spec says "patch, not full
  update, so unrelated fields the user set by hand are never clobbered").
- `packages/calendar/src/tools.ts` (304 lines, read in full) — current `calendarDeleteEventExecute`,
  `calendarProposeFocusBlockExecute`, `summarizeDeleteEvent`, `summarizeProposeFocusBlock`,
  `freezeRelativeDate` (load-bearing: freezes relative "tomorrow" so approval card and execute
  agree across a midnight boundary — reuse for any new create path, don't reinvent).
- `packages/calendar/src/calendar-write-service.ts` (64 lines, read in full) — current
  `CalendarWriteService` interface: `proposeAndInsert`, `deleteEvent`. Needs
  `rescheduleEvent` added, and `createEvent` (or repoint `proposeAndInsert` — plan must decide
  rename vs new method) per spec. `DeleteEventInput.eventId` currently typed as "Jarvis cached
  event uuid (authoritative)" only — must widen to accept either id shape via the new resolver.
- `packages/chat/src/calendar-write-impl.ts` (423 lines, read in full) — concrete impl of
  `proposeAndInsert`/`deleteEvent`. `deleteEvent` line 267 calls
  `deps.calendarRepository.getById(scopedDb, input.eventId)` directly — **this is the #1693
  regression site**, to be replaced by the shared resolver. Calendar id read at line 314-318
  (`external_metadata.calendarId ?? "primary"`) already correct code; just needs the sync path
  (below) to actually populate `calendarId`.
- `packages/calendar/src/manifest.ts` (290 lines, read in full) — `assistantActionFamilies`
  (`calendar_writeback` ask_each_time, `calendar_management` always_confirm/trusted_auto only),
  `assistantTools` (listVisibleEvents, proposeFocusBlock, deleteEvent) with exact current
  descriptions/schemas to reword per "Vocabulary changes". `sourceBehaviors` block (99-132) has
  the "coming-soon"/"blocks" copy to fix.
- `packages/calendar/src/repository.ts` (150 lines, read in full) — `getById` (48-56, no UUID
  pre-check, confirmed cast-error risk), `getByExternalId` (58-70), `upsertCachedEvent` (72-114,
  jsonb `||` merge confirmed), `deleteById`. No `updateStartEnd`/reschedule-mirror method exists
  yet — plan needs one (or reuse `upsertCachedEvent` with same connectorAccountId+externalId to
  patch times, since its onConflict already does a partial doUpdateSet).
- `packages/ai/src/gateway/gateway.ts` — both catch sites confirmed bare `catch {` (420-459 read
  tool path ~451 shows `read_tool_handler_threw`; ~563-575 write path shows `tool_handler_threw`),
  both `console.error(JSON.stringify(...))` with only `{event, toolName, requestId,
  errorClass:"handler_error"}` — no actorUserId, no real error class/message, no status code.
  `AssistantToolGatewayDependencies` interface (30-68) has no `logger` field — needs one added,
  optional, defaulting to `console.error`-equivalent, so gateway tests can inject a fake logger
  and assert on it (spec's "injectable logger" requirement).
- `packages/ai/src/gateway/policy.ts` (58 lines, read in full) — `resolvePolicy` and
  `ActionPolicyLookup`. **Open architecture question, unresolved — flag to coordinator, do not
  guess:** `resolvePolicy` runs BEFORE the tool handler, decides confirm-vs-run purely from
  `(tool, moduleId, input, lookup)` — no DB access, so it cannot know event provenance
  (Moss-created vs user-created). `tool.requiresConfirmation?.(input)` is synchronous, over raw
  input only. Decision 1 requires: once `calendar_management` is promoted to `trusted_auto`, a
  delete/reschedule of a **user-created** event must still show a confirmation card, while a
  **Moss-created** event does not. That decision can only be made after resolving the event
  (DB read), which happens inside the handler, i.e. AFTER `resolvePolicy` already chose "run" and
  skipped the card. **The plan must design how the handler enforces a card in this case** — e.g.
  widening `requiresConfirmation` to become async with `(scopedDb, ctx, input)` so it can resolve
  the event first, or some other seam. Do not build the confirmation-policy pure function without
  first deciding this — the pure function is necessary but not sufficient; the plan needs an
  explicit "how does gateway call it" answer with a `file:line` citation once found, or an
  open question with a named owner if it can't be closed without Ben.
- `packages/connectors/src/google-sync-phases.ts` `runGoogleCalendarPhase` (100-190ish) —
  hardcodes `calendarId: "primary"` on the Google `events.list` call and never writes a
  `calendarId` field into `externalMetadata` on `upsertCachedEvent`. Since the list call is
  already scoped to "primary", there is no real secondary-calendar case reachable via this phase
  today — decision 6's fix is cheap: just add `calendarId: "primary"` explicitly to the
  `externalMetadata` object written here (matches what `calendar-write-impl.ts` already reads).
  Don't overbuild this into real secondary-calendar sync support (out of scope).
- Next migration number confirmed: **0185** (global counter — checked
  `packages/*/sql` + `infra/postgres/migrations` combined, highest existing is 0184).

### Not yet checked (do before/during plan-build)

- `ModuleAssistantToolManifest.requiresConfirmation` type definition and every other caller of it,
  to know if widening its signature is safe or needs a second call site touched.
- `deleteCalendarEventResponseSchema` / any `updateCalendarEventResponseSchema` shape in
  `@moss/shared` — needed for the reschedule tool's `outputSchema` and for widening delete's.
- `CalendarEvent` DB row type columns (from `@moss/db`) — only inferred from repository.ts usage
  so far, not read directly.
- module-registry's `buildCalendarFollowThroughPort` / `executeAutoActions` wiring
  (`packages/*/module-registry/src/index.ts:~711`, per manifest.ts comment) — must re-check
  whether it calls `calendarWrite.proposeAndInsert` directly bypassing the gateway (confirmed by
  manifest.ts comment, not yet read directly) — if reschedule is ever wired into that worker later
  it inherits the same un-gated-tier risk; not needed for V1 build but worth one grep to confirm
  it doesn't already call anything this plan renames.

## Next steps for successor

1. Resolve the `requiresConfirmation`/provenance-timing open question above — grep
   `requiresConfirmation` across `packages/module-sdk` and callers; either find it's already async
   somewhere, or decide the widening and cite it in the plan as a decision, not an assumption.
2. Read the 4 "not yet checked" items above (bounded).
3. Write `docs/superpowers/plans/2026-08-19-1698-calendar-lifecycle.md` per plan-build skill
   (signatures/DDL/test-cases only, no function bodies) covering: resolver, createEvent rename,
   rescheduleEvent (incl. new `GoogleApiClient.patchEvent`), deleteEvent widening, confirmation
   policy pure function + its call site, gateway logger, manifest vocabulary, provenance
   consolidation, sync-path calendarId recording, migration 0185+ for any schema change,
   extensibility test for guests, UAT spec + `uat-trigger-map.tsv` row.
4. Message the coordinator (resolve pane fresh) with the plan path — **STOP and wait for approval**
   before writing any code.
5. Then TDD build per `coordinated-build` step 2 onward.

**Do not re-read the full spec** — this session already did section-by-section. Grep for a
decision number or section heading instead.
