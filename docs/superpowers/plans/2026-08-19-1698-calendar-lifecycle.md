# Plan — Calendar event lifecycle (create/reschedule/delete)

Spec: `docs/superpowers/specs/2026-08-19-1693-calendar-event-lifecycle.md` (APPROVED, Ben,
2026-08-19). Issue: #1698, `Part of #1693`. Risk tier: sensitive.

Architecture question (confirm-vs-auto-run needing event provenance) resolved by Coordinator via
Opus escalation 2026-08-18 — see "Confirmation plumbing" under Phase 1. Normal engineering call,
no further Ben sign-off needed on that decision.

## Seams check

| Assumption | Citation |
|---|---|
| `getById` has no UUID pre-check, throws on cast error | `packages/calendar/src/repository.ts:48-56` |
| `getByExternalId` exists, ready for dual lookup | `packages/calendar/src/repository.ts:58-70` |
| `upsertCachedEvent` jsonb `\|\|` merge preserves `jarvisCreated` across resync | `packages/calendar/src/repository.ts:72-114` |
| `deleteEvent` regression site — raw `input.eventId` into `getById` | `packages/chat/src/calendar-write-impl.ts:267` |
| `mirrorEvent` already writes `jarvisCreated: true` at create time | `packages/chat/src/calendar-write-impl.ts:398` |
| Google-side fallback tag already written at create time | `packages/chat/src/calendar-write-impl.ts:174` |
| `isMossBlock` currently derived only from `JFB_PATTERN` on `externalId` | `packages/calendar/src/serialize.ts:14-33` |
| `isCalendarFollowThroughEvent` already reads `jarvisCreated` | `packages/calendar/src/follow-through.ts` (confirmed this session) |
| No PATCH method on `GoogleApiClient`; `postJson` is the template (private, POST-only) | `packages/connectors/src/google-api-client.ts:254-291,383-404` |
| `deleteEvent` on `GoogleApiClient` treats 404/410 as already-gone | `packages/connectors/src/google-api-client.ts:334-353` |
| `focusBlockEventId` keyed on actor+window+duration+title (not slot) — reuse for reschedule id continuity (id must NOT change on reschedule) | `packages/calendar/src/focus-time.ts` (`focusBlockEventId`, confirmed this session) |
| `google-sync-phases.ts` hardcodes `calendarId: "primary"`, writes `attendeeCount` but not `calendarId` into `externalMetadata` | `packages/connectors/src/google-sync-phases.ts:172` |
| `calendar-write-impl.ts` read path already does `external_metadata.calendarId ?? "primary"` | confirmed this session, exact line not re-cited (bounded read) |
| Gateway catch sites, current fields, no logger dependency | `packages/ai/src/gateway/gateway.ts:563-575` (write path), `~448-459` (read path) |
| `AssistantToolGatewayDependencies` has no `logger` field | `packages/ai/src/gateway/gateway.ts:30-68` |
| `ToolRequiresConfirmation` is currently sync, input-only | `packages/module-sdk/src/index.ts:120` |
| `ToolPreview` is the async precedent (`scopedDb, input, ctx, services?`), called under `withDataContext`, swallow-to-`undefined` on throw | `packages/module-sdk/src/index.ts:145-150`, `packages/ai/src/gateway/gateway.ts:544-553` |
| `resolvePolicy` — `requiresConfirmation` short-circuits to `"confirm"` BEFORE the tier check, so provenance-based confirm does not need family tier in scope | `packages/ai/src/gateway/policy.ts:29-57` |
| `resolvePolicy` call site | `packages/ai/src/gateway/gateway.ts:238` |
| External-module + notes callers of `requiresConfirmation`, both trivially sync-only today | `packages/module-registry/src/external/tool-manifests.ts:18-27,49`, `packages/notes/src/manifest.ts:125` |
| YOLO path bypasses `resolvePolicy` entirely — provenance rule does not apply under YOLO | `packages/ai/src/gateway/gateway.ts:164-203` (pre-existing gap, named not fixed) |
| `attendeeCount` already synced into `externalMetadata` at sync time and read at serialize time — no new column/migration needed | `packages/connectors/src/google-sync-phases.ts:172`, `packages/calendar/src/serialize.ts:14-16` |
| Follow-through worker calls `calendarWrite.proposeAndInsert`/`.deleteEvent` directly, bypassing the gateway entirely (own `trusted_auto` tier check, no confirmation hook involved) | `packages/module-registry/src/index.ts:725-806` (`buildCalendarFollowThroughPort`), `:808-875` (`buildCalendarFollowThroughSideEffects`) |
| DB row shape (`app.calendar_events`) — no `attendees`/guest column exists; guest data would be JSONB-only (`external_metadata`), consistent with forward-compat requirement | `packages/db/src/types.ts:362-376` |
| `CalendarEventDto`/`calendarEventDtoSchema` already carry `attendeeCount`; `deleteCalendarEventResponseSchema` shape confirmed for widening description only (no shape change needed) | `packages/shared/src/calendar-api.ts:3-20,38-77,116-141` |

**Open question, no owner needed (informational only):** `packages/calendar/sql/0020_calendar_owner_or_share.sql` exists on disk but is absent from `calendarModuleManifest.database.migrations` in `packages/calendar/src/manifest.ts`. Out of scope for this build — not touched, not investigated further, flagged so it isn't mistaken for something this plan introduced.

Next migration number if any DDL is needed: **0185** (confirmed: highest across `packages/*/sql` + `infra/postgres/migrations` is 0184). None of the three phases below requires a migration — provenance and attendee/calendar-id data are already JSONB fields.

## Determinism boundary

All three tools (`createEvent`, `rescheduleEvent`, `deleteEvent`) render their Approve/Deny card
`summary` from `tool.summarize(input, ctx)` — a deterministic function over structured input, never
model prose (existing pattern, unchanged). The model's two jobs: (1) choose tool + structured input
(title/window/duration for create, event ref + new window for reschedule, event ref for delete),
(2) narrate the tool result back to the user in its own words after `action_result` — never before.
No tool injects a turn into host chat. No new model guidance text is added by this plan (0 words
added to `assistantOnboarding`).

## Phase 1 — Identifier contract, observability, provenance (bug-fix core; ships alone)

### 1a. Event reference resolver

New file `packages/calendar/src/event-resolver.ts`:

```ts
export type CalendarEventRef =
  | { readonly kind: "moss_id"; readonly id: string }
  | { readonly kind: "external_id"; readonly id: string };

export function parseCalendarEventRef(raw: string): CalendarEventRef;
// UUID v4-shape regex (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
// against raw -> "moss_id"; otherwise "external_id". Never throws.

export type ResolveCalendarEventResult =
  | { readonly found: true; readonly event: CalendarEventRow }
  | { readonly found: false; readonly reason: "not_found" | "invalid_input" };

export async function resolveCalendarEventRef(
  scopedDb: DataContextDb,
  repository: Pick<CalendarRepository, "getById" | "getByExternalId">,
  actorUserId: string,
  raw: unknown
): Promise<ResolveCalendarEventResult>;
// raw not a non-empty string -> {found:false, reason:"invalid_input"}.
// moss_id -> repository.getById (RLS-scoped by scopedDb already). external_id ->
// repository.getByExternalId scoped to actor's active connected Google account (join through
// connector_account_id, same actor). Never throws — catches and returns not_found.
```

Wire into `packages/chat/src/calendar-write-impl.ts` `deleteEvent` (replaces the direct
`calendarRepository.getById(scopedDb, input.eventId)` at line 267) and into the new
`rescheduleEvent` (Phase 3). `not_found`/`invalid_input` both surface as the same user-facing
"couldn't find that event" outcome — no information-disclosure difference between the two (avoids
leaking whether a given id string merely doesn't parse vs genuinely doesn't exist).

**Test cases:**
- `parseCalendarEventRef` returns `moss_id` for a well-formed UUID, `external_id` for a Google
  opaque id (e.g. `"7c3f8b2e4d5a6b1c@google.com"`) and for a `jfb`-prefixed compat id. Fails
  against current code because the function doesn't exist yet.
- `resolveCalendarEventRef` returns `found:false` (not throws) when given a non-UUID string and
  `getByExternalId` returns nothing. Fails against current `calendar-write-impl.ts` because the
  current code throws a Postgres cast error on this exact input (the #1693 repro).
- `resolveCalendarEventRef` returns `found:false` when given a UUID belonging to another actor's
  event (RLS scoping). Fails against a naive implementation that queries without `scopedDb`.
- Integration: `calendar.deleteEvent` invoked with a Google external id (non-UUID) succeeds
  end-to-end. Fails today (#1693 repro, cast error).

### 1b. Confirmation plumbing (Coordinator-ruled architecture)

`packages/module-sdk/src/index.ts:120` — widen:
```ts
export type ToolRequiresConfirmation = (
  scopedDb: unknown,
  input: ToolInput,
  ctx: ToolContext,
  services?: ToolServices
) => boolean | Promise<boolean>;
```

`packages/ai/src/gateway/policy.ts` — drop the inline `requiresConfirmation` call, take the
already-resolved result as a parameter instead (keeps this file DB-free):
```ts
export async function resolvePolicy(
  tool: ModuleAssistantToolManifest,
  moduleId: string,
  confirmOverride: boolean,
  lookup: ActionPolicyLookup
): Promise<PolicyDecision>;
// same body as today (policy.ts:34-56) except line 37 becomes: if (confirmOverride) return "confirm";
```

`packages/ai/src/gateway/gateway.ts` — near the `resolvePolicy` call site (`:238`), inside the
existing `withDataContext`-eligible path (mirroring the preview call pattern at `:544-553`):
compute `confirmOverride` by calling `found.tool.requiresConfirmation` under `this.deps.runner.
withDataContext`, **BEFORE** calling `resolvePolicy`, and pass the result through. Unlike the
preview call, **failure must resolve to `true` (confirm), not swallow to a falsy default** — a
throwing/timing-out confirmation check must never silently grant auto-run.

`packages/module-registry/src/external/tool-manifests.ts:49` (`synthesizeRequiresConfirmation`)
and `packages/notes/src/manifest.ts:125` — widen their function signatures to the new async
4-arg shape (both only read `input`, so this is a mechanical signature change, no logic change).

**Test cases:**
- `resolvePolicy` given `confirmOverride: true` returns `"confirm"` even when tier is
  `trusted_auto` and `executionPolicy` is `"auto"`. Fails against current signature (no such
  param).
- Gateway: a tool whose `requiresConfirmation` throws synchronously still routes through
  `confirmAndRun`, never `runHandler` directly. Fails against a naive "swallow like preview" port
  of the coordinator's plumbing.
- Gateway: a tool whose `requiresConfirmation` resolves `false` and whose family tier is
  `trusted_auto` still auto-runs (no regression to existing notes/`overwrite` behavior). Uses
  `packages/notes/src/manifest.ts:125`'s existing case as the regression fixture.

### 1c. Calendar's own confirmation rule (pure function, module-owned)

New file `packages/calendar/src/confirmation-policy.ts`:
```ts
export function requiresCalendarConfirmation(params: {
  readonly jarvisCreated: boolean;
}): boolean;
// returns !params.jarvisCreated — Moss-created events may skip the card once calendar_management
// is promoted; a user-created event always confirms, independent of tier (spec decision 1).
```
Wired as the `requiresConfirmation` hook on `deleteEvent` and (Phase 3) `rescheduleEvent` in
`packages/calendar/src/manifest.ts`: resolve the event via `resolveCalendarEventRef` (1a) under the
supplied `scopedDb`; `found:false` -> `true` (fail closed, can't verify provenance); else
`requiresCalendarConfirmation({ jarvisCreated: event.external_metadata?.jarvisCreated === true })`.

**Test cases:**
- `requiresCalendarConfirmation({jarvisCreated:true})` -> `false`;
  `requiresCalendarConfirmation({jarvisCreated:false})` -> `true`. Pure unit test, trivial but
  pins the rule so it can't silently invert.
- `deleteEvent`'s `requiresConfirmation` hook returns `true` when the ref doesn't resolve (fail
  closed). Fails against an implementation that defaults to `false`/auto-run on lookup failure.

### 1d. Gateway logger

`packages/ai/src/gateway/gateway.ts:30-68` (`AssistantToolGatewayDependencies`) — add:
```ts
export interface GatewayLogger {
  error(event: string, fields: Record<string, unknown>): void;
}
// ...
readonly logger?: GatewayLogger;
```
Default (constructor, when omitted): `{ error: (event, fields) => console.error(JSON.stringify({ event, ...fields })) }` — preserves today's stdout behavior when no logger is injected.

Both catch sites (`:451` read path, `:563-575` write path) replace the hardcoded literal with:
`actorUserId: ctx.actorUserId`, `errorClass` derived from `error instanceof GoogleApiError ?
"GoogleApiError" : error instanceof Error ? error.constructor.name : "unknown"`,
`message: error instanceof Error ? error.message : undefined`, and (write path only)
`statusCode: error instanceof GoogleApiError ? error.statusCode : undefined`. No response body,
no request payload, no secrets — matches the existing status-code-only logging discipline already
used by `postJson` (`packages/connectors/src/google-api-client.ts:383-404`).

**Test cases:**
- A handler that throws a plain `Error("boom")` produces exactly one `this.deps.logger.error(...)`
  call with `errorClass:"Error"`, `message:"boom"`, and the real `actorUserId`/`requestId`. Fails
  against current code (hardcoded `errorClass:"handler_error"`, no actorUserId, no injectable
  logger to assert against — this is the concrete "test proving a throwing handler logs" the spec
  asks for).
- A handler that throws `GoogleApiError` produces a log record with `statusCode` populated.

### 1e. Provenance consolidation

`packages/calendar/src/serialize.ts` — `isMossBlock` becomes:
`md.jarvisCreated === true || (md.jarvisCreated === undefined && JFB_PATTERN.test(externalId))`
— `jarvisCreated` (already written at create time, `packages/chat/src/calendar-write-impl.ts:398`)
is authoritative; the regex is a fallback ONLY for cache rows written before this change existed
(never re-derives once `jarvisCreated` is present, even if `false`).

**Test cases:**
- Cached row with `external_metadata.jarvisCreated: false` and a `jfb`-prefixed `externalId`
  (simulating a user who happens to reuse the id shape, or a stale/incorrect tag) serializes
  `isMossBlock: false` — the regex must NOT override an explicit `false`. Fails against a naive
  `md.jarvisCreated ?? JFB_PATTERN.test(...)` that only guards `undefined` vs missing-vs-falsy
  ambiguity incorrectly (this is the exact bug the "sole authoritative signal" decision guards
  against).
- Cached row with no `jarvisCreated` key at all and a `jfb`-prefixed id still serializes
  `isMossBlock: true` (pre-existing cache rows keep working, cache-rebuild fallback).

### Kill gate (owner: Coordinator, evaluated before Phase 2 is planned in detail)

Ship Phase 1 alone, get it live-path proven (delete-by-external-id through the real UI on dev), and
observe: does the resolver actually eliminate the #1693 cast-error class in practice, and does the
new confirmation plumbing correctly gate a `trusted_auto`-tier user's delete of a user-created
event (manual UAT: promote `calendar_management`, delete an event Moss did NOT create, confirm the
card still appears)? If either fails, Phase 2/3 do not proceed until re-planned — this phase is the
riskiest architecturally (gateway-wide signature change) and must be proven correct in isolation
before reschedule adds a second consumer of the same plumbing.

## Phase 2 — Create widening + vocabulary

- Rename `CalendarWriteService.proposeAndInsert` -> `createEvent` in
  `packages/calendar/src/calendar-write-service.ts` (interface) and
  `packages/chat/src/calendar-write-impl.ts` (implementation) — same 6-step body, no logic change,
  input/output shapes unchanged this phase (guest field is Phase-3-or-later, out of scope for
  #1698 per spec's "forward compatibility" — schema just stays an open object).
- Update the two direct call sites in `packages/module-registry/src/index.ts:730,790` (follow-
  through worker) to the new method name — same call shape, mechanical rename only.
- `packages/calendar/src/manifest.ts` — rename tool `proposeFocusBlock` -> `createEvent`
  (`assistantTools`), widen `description`/schema wording from "focus block"/"block" to general
  event language per spec's vocabulary-changes decision; same for `sourceBehaviors` (:99-132) and
  `calendar_writeback` family description. Input schema stays an open JSON object
  (`additionalProperties` not set to `false`) — forward-compat-for-guests requirement.
- `mirrorEvent`'s `jarvisTool` tag (`packages/chat/src/calendar-write-impl.ts:174`) updates to the
  new tool name for consistency (informational field only, not read anywhere — grep confirms no
  reader before changing; if a reader turns up during build, keep the old value additionally
  rather than break it).

**Test cases:**
- `createEvent` tool manifest entry validates against the module manifest schema (existing
  manifest test suite) with the new name/description.
- End-to-end: `calendar.createEvent` invoked with a title outside any focus-time framing (e.g. "
  lunch with Sam at noon") still produces a real Google event via the existing 6-step flow — proves
  the rename didn't silently narrow behavior.

## Phase 3 — Reschedule (net new)

`packages/connectors/src/google-api-client.ts` — new method, same file, mirrors `postJson`'s
structure (`:383-404`) but PATCH:
```ts
async patchEvent(
  accessToken: string,
  calendarId: string,
  externalEventId: string,
  patch: { readonly start?: { dateTime: string; timeZone: string }; readonly end?: { dateTime: string; timeZone: string } }
): Promise<GoogleCalendarEventPayload>;
// PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{externalEventId}
// partial body (only changed fields) so untouched fields (location, guests added by hand, etc.)
// are never clobbered. Throws GoogleApiError(message, statusCode) on non-ok, same as postJson.
```

`packages/calendar/src/calendar-write-service.ts` — add:
```ts
export interface RescheduleEventInput {
  readonly eventRef: string; // moss id or external id, resolved via event-resolver
  readonly newStart: Date;
  readonly newEnd: Date;
}
export type RescheduleEventResult =
  | { readonly ok: true; readonly calendarEventId: string }
  | { readonly ok: false; readonly reason: "not_found" | "has_attendees" | "no_scope" | "provider_error" };

rescheduleEvent(scopedDb, ctx, input: RescheduleEventInput): Promise<RescheduleEventResult>;
```
Implementation (`calendar-write-impl.ts`) flow: resolve ref (1a) -> if not found, `not_found` ->
if `attendeeCount > 0` (read from `external_metadata`, already synced per seams check), `has_
attendees` **hard refusal, independent of the confirmation card** (spec decision 2 — this is not a
confirm-vs-auto distinction, the tool refuses outright) -> fresh token + scope check (reuse
existing pattern from `proposeAndInsert`) -> `googleApiClient.patchEvent` with the *same* external
event id (never delete-then-create — the id must not change) -> on success, mirror the new
start/end into the cached row via `upsertCachedEvent` (reuses the existing jsonb-merge upsert, same
`connectorAccountId`+`externalId` conflict key already in `repository.ts:72-114` — no new
repository method needed).

`packages/calendar/src/manifest.ts` — new tool `rescheduleEvent` in the `calendar_management`
family (same family as `deleteEvent` — both destructive-shaped, both gated by 1c's confirmation
rule plumbed through 1b), with `requiresConfirmation` wired exactly as `deleteEvent`'s (1c).

**Test cases:**
- Rescheduling a Moss-created event with 0 attendees under `trusted_auto` tier auto-runs (no card).
  Fails against a naive always-confirm implementation.
- Rescheduling any event (Moss- or user-created) with `attendeeCount > 0` returns
  `{ok:false, reason:"has_attendees"}` and never calls `patchEvent` — this must hold even under
  `trusted_auto`, i.e. the refusal is unconditional, not a confirmation-card-avoidable one. Fails
  against an implementation that only wires the attendee check into `requiresConfirmation`.
- Reschedule preserves the external event id across the operation (asserted directly against the
  mock `GoogleApiClient` call args) — proves no delete-then-create regression.
- End-to-end: `calendar.rescheduleEvent` on a live dev Google account moves a real event's time and
  the cached row reflects the new `startsAt`/`endsAt` on next `listVisibleEvents`.

## Verification (per phase, run in this worktree)

```bash
pnpm --filter @moss/calendar --filter @moss/chat --filter @moss/ai --filter @moss/module-sdk --filter @moss/notes --filter @moss/module-registry test > /tmp/1698-unit.log 2>&1; echo "EXIT=$?"
# expect 0
pnpm --filter @moss/calendar --filter @moss/chat --filter @moss/ai --filter @moss/module-sdk typecheck > /tmp/1698-tsc.log 2>&1; echo "EXIT=$?"
# expect 0
```
Full-gate (`pnpm verify:foundation`) only via the `verify-gate` skill, per CLAUDE.md — never run
raw. Live-path proof (delete-by-external-id, reschedule) on a real dev instance is a phase exit
criterion, not covered by the above.

## Rulings ledger

- `resolvePolicy`'s `requiresConfirmation` branch runs BEFORE the tier check (`policy.ts:37`
  precedes `:47-54`) — this is why the calendar confirmation pure function needs no family-tier
  parameter; the tier gate already composes correctly downstream. (Established this session,
  09:xx.)
- Follow-through worker (`module-registry/src/index.ts:725-875`) bypasses the gateway and
  `requiresConfirmation` entirely — Phase 1's plumbing does not touch it; it keeps its own
  `trusted_auto`-only tier check. Not a gap this plan introduces; pre-existing.
- YOLO mode (`gateway.ts:164-203`) bypasses `resolvePolicy` and therefore this plan's provenance
  rule — pre-existing gap, named per Coordinator's ruling, not fixed by this plan.
- `attendeeCount` and eventual `calendarId` are already JSONB fields populated at sync time
  (`google-sync-phases.ts:172`) — no migration required for Phase 1-3. `0020_calendar_owner_or_
  share.sql` manifest-list discrepancy exists but is untouched/out of scope.
- `mirrorEvent` already writes both `external_metadata.jarvisCreated: true` (calendar-write-
  impl.ts:398) and the Google-side `extendedPrivateProperties.jarvisCreated` fallback (:174) —
  Phase 1e is a read-side-only change.
