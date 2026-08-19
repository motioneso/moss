# Relay — 1698-calendar-lifecycle (2026-08-18)

**Spec:** `docs/superpowers/specs/2026-08-19-1693-calendar-event-lifecycle.md` (on this branch as of
commit 595fe793a — cherry-picked from a sibling checkout; it was missing from origin/main).
**Issue:** #1698. **Risk tier:** sensitive. **Worktree/branch:** this one — no change needed.
**Coordinator:** resolve fresh by label `Coordinator` in `herdr pane list` — do not trust any pane
number written here or in the handoff doc, it reflows. Already messaged re: this relay.

## State

Only repo change so far: commit `595fe793a` (spec doc cherry-pick). **No implementation code
written.** Still mid coordinated-build **step ½** (verify spec against branch), not yet at
plan-build.

### Verified against branch (matches spec, no drift)
- `packages/calendar/src/repository.ts`: `getById` does `.where("id","=",eventId)` with **no
  UUID-shape pre-check** — confirmed cast-error risk. `getByExternalId` exists for the dual-lookup
  path. `upsertCachedEvent` uses jsonb `||` merge-on-conflict for `external_metadata` — confirmed
  this is what lets `jarvisCreated` survive a resync.
- `packages/chat/src/calendar-write-impl.ts`: `deleteEvent` calls `calendarRepository.getById`
  directly with the raw tool-supplied `eventId` — this is the exact regression site.
- `packages/calendar/src/tools.ts`, `calendar-write-service.ts`: current create/delete
  execute-functions and the `CalendarWriteService` interface read in full; match spec's described
  starting shape (no `rescheduleEvent`, `DeleteEventInput.eventId` typed as "Jarvis cached event
  uuid (authoritative)" only).
- `packages/calendar/src/manifest.ts`: `assistantActionFamilies` (`calendar_writeback` →
  `ask_each_time` default, `calendar_management` → `always_confirm` default),
  `assistantTools` (`calendar.listVisibleEvents`, `calendar.proposeFocusBlock`,
  `calendar.deleteEvent`) — matches spec's vocabulary-fix target (tool names/descriptions still
  say "focus block" / "block", to be widened to general event language).

### Drift found (non-blocking, do not escalate — just plan around it)
`packages/ai/src/gateway/gateway.ts` catch sites in `runReadToolForActor` (~line 451) and
`runHandler` (~line 563) **already** call `console.error(JSON.stringify({event, toolName,
requestId, errorClass: "handler_error"}))` — the spec's Problem Statement claim of "the gateway
holds no logger at all" overstates the actual gap. Real remaining gap: no `actorUserId`, no real
error class/message (currently a hardcoded literal), no provider status code, and `console.error`
isn't an injectable/testable logger (the spec wants a test proving a throwing handler produces a
log record — that needs a dependency you can assert against, not raw stdout). **Plan should close
this narrower gap** (add fields + make it injectable), not "add logging from scratch."

### Not yet read (do before plan-build; grep-then-read, bounded)
- `packages/calendar/src/serialize.ts` — `jfb`-prefix regex currently derives `isMossBlock` for the
  REST DTO; spec wants provenance to stop trusting this as source of truth (keep as fallback only).
- `packages/calendar/src/follow-through.ts` — the only current reader of
  `external_metadata.jarvisCreated`.
- `GoogleApiClient` in `@moss/connectors` — need `insertEvent`/`deleteEvent`/`freeBusy` signatures
  to design the new update/reschedule call.
- `packages/calendar/src/focus-time.ts` — `focusBlockEventId`, the deterministic-id helper the
  idempotent-write pattern (409-as-success) depends on.

## Next steps for successor

1. Read the four files above (bounded reads only).
2. Invoke `plan-build` → `docs/superpowers/plans/2026-08-19-1698-calendar-lifecycle.md`. Must cover:
   event-reference resolver (UUID pre-check + dual resolution vs Moss PK / external id scoped to
   actor's connected account, never-throw structured result); `calendar.createEvent` (rename/widen
   `proposeFocusBlock`, keep `freezeRelativeDate`); `calendar.rescheduleEvent` (new);
   `calendar.deleteEvent` widened to accept both id shapes; confirmation-policy-as-pure-function
   (provenance × attendee count × family tier × operation → posture); gateway logger enrichment
   (actorUserId, real error class/message, status code, injectable); manifest vocabulary fixes;
   extensibility test for a future guest field; UAT spec + `uat-trigger-map.tsv` row (user-facing,
   sensitive tier).
3. Message the coordinator (resolve pane fresh) with the plan path — **STOP and wait for approval**
   before writing any code.
4. Then TDD build per `coordinated-build` step 2 onward.

**Do not re-read the full spec.** Read it by section, per the boot brief's explicit warning against
full-reads bloating a fresh context.
