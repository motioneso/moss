# Calendar event lifecycle — create, reschedule, delete (#1693)

**Status:** APPROVED (Ben, 2026-08-19) — build task #1698
**Issue:** #1693 (delete fails silently); this spec widens it to full event lifecycle
**Primary verification seam:** ask Moss in Chat to create an event, move it to another time, and
delete it — plus delete an event the user made in Google Calendar directly — and confirm each
change on the live Google Calendar and on the Moss Calendar page

## Decisions (ruled by Ben, 2026-08-19)

Six product forks were raised for Ben. All six are resolved; each ruling is binding on the design
below.

1. **Delete confirmation is split by provenance.** Once the user promotes the `calendar_management`
   family, Moss may delete an event *it created itself* without a confirmation card. An event the
   *user* created always requires an explicit confirmation card, whatever the tier. Cleaning up its
   own blocks is the common case; cancelling a user's real meeting notifies attendees and cannot be
   undone.

2. **V1 reschedule is restricted to no-guest and Moss-created events.** Moving an event that has
   other attendees refuses with a clear explanation, because a move sends an update notice to every
   guest. Same blast-radius reasoning as delete, and it keeps the first slice provably safe.
   Multi-attendee moves are a follow-up slice.

3. **`calendar.proposeFocusBlock` is renamed to `calendar.createEvent`.** The tool name is the
   single strongest signal the model has about its own calendar powers, and the rename cost is
   small: no durable configuration is keyed on tool names — only historical
   `app.moss_action_audit_log.tool_name` rows and any in-flight action request carry the old string.

4. **No guest/attendee list in the V1 create surface — but the design must stay open to one.** V1
   creates solo events only; sending calendar invitations on the user's behalf is a distinct trust
   surface, closer to sending email than to blocking time. Ben's explicit condition: the design must
   not lock guests out. The event-reference contract, create-tool schema, and data model must be
   able to accept an optional attendee list in a later slice **without a breaking change**. See
   "Forward compatibility: guests" under Implementation Decisions, which is binding.

5. **No single-occurrence edits of recurring series in V1.** Reschedule and delete detect a
   recurring event and refuse with a distinct, honest outcome code. Single-occurrence handling needs
   provider-specific instance-id work that would dominate this slice; it is the immediate follow-up.

6. **V1 writes only to the primary calendar.** Create and reschedule target `primary`, matching
   today's behavior. Delete and reschedule must still *read* the stored calendar id so an event that
   already lives on a secondary calendar can be acted on — today the sync path never records a
   calendar id, so any such event silently falls back to `primary` and the operation fails. Fixing
   that read path is in scope; letting the user choose a write target is not.

## Problem Statement

Ben asked Moss to delete two calendar blocks it had just created. The tool returned
`Tool calendar.deleteEvent failed` — no status, no reason, twice — and he had to delete the events
by hand in Google Calendar. Because `calendar.proposeFocusBlock` returns `no-clear-slot` when the
window is occupied, the failed delete also blocked the next create, so a single broken operation
took the whole calendar capability down.

The investigation on #1693 found an identifier-contract bug and an error-swallowing bug. Reading the
code shows the identifier problem is wider than the issue describes, and that the lifecycle Ben
expects is only partly built:

- **The identifier contract is broken on the documented happy path, not just on a caller mistake.**
  `calendar.deleteEvent` declares `eventId` as "Moss calendar event id (uuid) *from
  listVisibleEvents*". But `calendar.listVisibleEvents` returns `id` = the *provider* event key
  (`source-context/calendar.ts` returns `event.id` on the live path and `row.external_id` on the
  cache path). So the one tool the schema names as the source of ids never returns the id the delete
  tool accepts. `proposeFocusBlock` returns both `googleEventId` and `calendarEventId` and does not
  say which is deletable. There is no path by which a model can reliably obtain a usable delete
  handle.
- **A bad id throws instead of returning a result.** `deleteEvent` passes the string straight into
  `CalendarRepository.getById`, whose `where("id", "=", ...)` casts to `uuid`; a Google-format id
  raises a Postgres cast error rather than producing "not found".
- **The gateway swallows the throw with no server-side record.** Both
  `packages/ai/src/gateway/gateway.ts` catch sites (`catch { return { ok: false, error: \`Tool X
  failed\` } }`) are bare. The generic client message is correct and protects the secrets invariant,
  but the gateway holds no logger at all, so nothing is written server-side either. An operator
  debugging this has literally no evidence.
- **There is no reschedule or move capability anywhere.** `GoogleApiClient` implements
  `insertEvent`, `deleteEvent`, and `freeBusy`. There is no patch/update/move method, no
  `CalendarWriteService.updateEvent`, and no assistant tool for it. Moving an event is entirely new
  surface.
- **Create is narrower than it should be.** The only create path is `proposeFocusBlock`, which
  resolves a part-of-day band, runs a freeBusy search, and may *shift* the event to the next clear
  slot. There is no way to create an event at an exact time that the user actually named, and no
  REST write route — `/api/calendar/events` is read-only.
- **Provenance is recorded three different ways and read inconsistently.** An insert writes Google
  `extendedProperties.private.jarvisCreated` (never read back by Moss), the mirror writes
  `external_metadata.jarvisCreated` (read only by `follow-through.ts`), and the REST DTO decides
  `isMossBlock` from a `jfb`-prefix regex on the external id (`serialize.ts`). Nothing distinguishes
  user-created from Moss-created events on the assistant path at all.

Separately, Ben has observed Moss telling him it "can't create events, only blocks." That is not a
capability gap — a focus block *is* a calendar event — it is a vocabulary problem, addressed below.

## Solution

Give Moss one coherent calendar-event lifecycle: create an event at a time the user names, move an
existing event to a new time, and delete an event — for events the user created and events Moss
created alike — with a single, unambiguous way to refer to an event, honest failures the user can
act on, and safety rules that scale with who owns the event and who else it affects.

Three pieces:

**One event reference.** Define a single event-reference contract shared by every calendar tool. A
tool accepts an event reference and one shared resolver interprets it: a UUID-shaped value resolves
against the Moss cache by primary key; anything else resolves as a provider event key scoped to the
actor's connected account. An unresolvable reference returns an honest "that event isn't on your
calendar" result — never a thrown database error. Every calendar tool that *returns* events returns
both identifiers with unambiguous names, and every tool that *accepts* one accepts either.

**Honest failure.** Tool handlers keep returning structured results rather than throwing, and the
gateway gains a logger so that when a handler does throw, the failure is recorded server-side with
bounded, non-secret fields before the generic message goes back to the caller. The user-facing
message stays generic; the operator stops flying blind.

**Full lifecycle, safety scaled by blast radius.** Add a general create that honors an exact
requested time, add reschedule, and repair delete. Confirmation policy is driven by what the change
actually costs: rearranging or removing a Moss-created solo block is cheap and reversible in
practice; moving or cancelling a real meeting notifies other people and cannot be undone from Moss.

### Vocabulary and the model's self-image

Moss's belief about its own calendar powers is formed almost entirely by the assistant-tool names
and descriptions it is handed — an audit found no calendar-specific system-prompt text anywhere in
the codebase. The vocabulary it currently sees is: a tool literally named `proposeFocusBlock`,
described as creating "a focus-time block", with a `title` field documented as "block title;
defaults to 'Focus time'". Nothing in that surface says "you can create calendar events." The model
reasonably concludes its power is narrower than it is, and self-limits in conversation. The user-
facing sourceBehavior copy makes the same split ("schedules its own focus blocks around your
events") and reinforces it.

The fix is to make "event" the noun everywhere the model or the user can see, and let "focus time"
be nothing more than a default title. Internal helpers may keep their names; what the model reads
must not.

## User Stories

1. As a Moss user, I want to ask Moss to put something on my calendar at a specific time, so that
   the event lands when I said and not in a slot Moss picked.
2. As a user, I want to ask Moss to create an event without naming an exact time ("some time
   tomorrow morning"), so that it can still find me a clear slot when I don't care exactly when.
3. As a user, I want Moss to tell me plainly when it moved my requested time because of a conflict,
   so that I am never surprised by where the event ended up.
4. As a user, I want to ask Moss to move an event to a different time or day, so that I can
   rearrange my schedule by talking rather than by editing the calendar myself.
5. As a user, I want to ask Moss to make an event longer or shorter, so that duration changes do not
   require deleting and recreating.
6. As a user, I want Moss to check availability before it moves an event, so that a reschedule does
   not silently double-book me.
7. As a user, I want to delete an event by describing it ("delete the 10am one"), so that I never
   have to know or paste an identifier.
8. As a user, I want Moss to be able to delete and move events it created itself, so that it can
   clean up after its own scheduling.
9. As a user, I want Moss to be able to delete and move events *I* created, so that its usefulness
   is not limited to its own blocks.
10. As a user, I want a confirmation before Moss cancels or moves an event that other people are
    attending, so that no one gets an unexpected cancellation on my behalf.
11. As a user, I want the confirmation card to tell me the event's title, time, and how many people
    will be notified, so that I can judge the consequence before approving.
12. As a user, I want to allow Moss to manage its own blocks automatically while still confirming
    changes to my real meetings, so that routine tidying is not a stream of prompts.
13. As a user, when a calendar change fails, I want a reason I can act on — reconnect Google, grant
    calendar permission, the event no longer exists, that calendar is read-only — rather than
    "failed".
14. As a user, I want a failure to leave my calendar unchanged, so that a half-applied reschedule
    never loses an event.
15. As a user, I want Moss to refuse clearly when I ask it to change a recurring series, so that I
    know to do it myself rather than assume it worked.
16. As a user, I want Moss to describe its capability as creating, moving, and deleting *calendar
    events*, so that it does not tell me it can only make focus blocks.
17. As a user, I want the Calendar page to keep showing which events Moss created, so that I can
    still tell its blocks apart from my own commitments.
18. As a user, I want a change made through Chat to appear on the Calendar page and in Google
    Calendar without me forcing a resync, so that the two views agree.
19. As a user, I want my calendar contents to stay private to me, so that no other user and no
    administrator can read or change my events.
20. As an operator, I want a failed calendar tool call recorded server-side with enough detail to
    diagnose it, so that a silent failure is never invisible again.
21. As an operator, I want that server-side record to contain no event titles, tokens, or provider
    response bodies, so that debugging does not become a private-data leak.
22. As a user, I want repeated or retried requests not to create duplicate events, so that a timeout
    does not double-book me.

## Implementation Decisions

### Identifier contract

- Introduce one event-reference resolver, owned by `packages/calendar`, used by every calendar write
  tool. It accepts a string reference and returns a resolved target carrying the Moss cache row
  (when one exists), the provider event key, the connector account, and the calendar id.
- Resolution order: a UUID-shaped reference resolves through `CalendarRepository.getById`; any other
  reference resolves through `getByExternalId` scoped to the actor's active connected account. The
  UUID shape is checked in TypeScript *before* any query, so a non-UUID string can never reach a
  `uuid`-typed column and raise a cast error.
- A reference that resolves to nothing returns the existing structured "that event isn't in your
  calendar" result. Resolution failure is a result, never a throw.
- Because the cache can lag, a provider-key reference that finds no cache row is still a valid
  target for delete and reschedule: the operation proceeds against the provider under the actor's
  connected account, with the cache treated as best-effort as it is today. A UUID reference that
  finds no row remains "not found" — a UUID can only have come from the cache.
- Every calendar tool that returns events returns two clearly named fields: `eventId` (the Moss
  event id, null when the event is live-read and not yet cached) and `providerEventId`. The
  descriptions state plainly that either may be passed to create/move/delete tools.
  `calendar.listVisibleEvents` today returns the provider key under the bare name `id`, which reads
  as the canonical handle; that field is renamed and split.
- `proposeFocusBlock`'s result keeps both ids but renames them to the same vocabulary, so no result
  shape anywhere implies one id is "the" id.

### Error handling and observability

- Add a logger dependency to the AI gateway and log at both existing catch sites before returning
  the generic response. Record: tool name, request id, actor id, error class/name, error message,
  and provider status code when present. The response to the caller stays exactly as it is —
  `Tool X failed` — so nothing new is exposed to the model or the user.
- The logged fields must never include event titles, descriptions, attendee identities, access
  tokens, provider response bodies, or tool input values. Follow the existing `GoogleApiClient`
  precedent, which logs status codes and reason tokens only.
- Calendar tool handlers keep the established pattern of returning structured outcome results for
  every *anticipated* failure (missing scope, feature grant disabled, expired connection, event not
  found, provider permission denied, no clear slot). The gateway log is the backstop for the
  unanticipated.
- Widen the delete and move result vocabularies so a caller can distinguish "not found", "no
  permission on that calendar", "connection needs reconnecting", "calendar access disabled in
  Settings", and "recurring series not supported". The model turns these into the sentence the user
  reads; the tool does not compose prose.

### Create

- Repoint the create tool at a general event-creation contract: an explicit start time (with
  duration or an explicit end) creates an event at exactly that time; a part-of-day band keeps
  today's freeBusy search-and-shift behavior. Exact-time creation reports a conflict rather than
  silently relocating the event — shifting is opt-in behavior of the band form, not the general one.
- Keep the existing deterministic-id idempotency floor and the 409-as-idempotent-success handling.
  Extend the same treatment to exact-time creates so a retried request cannot double-book.
- Keep the existing scope gate, feature-grant gate, and best-effort cache mirror unchanged. Keep the
  UTC-instant/no-`timeZone`-field decision and the relative-date freezing across the approval gap —
  both are load-bearing and documented in place.
- Title defaults to "Focus time" only when no title is supplied. The field description says "event
  title", not "block title".
- Guest lists, descriptions, locations, reminders, and conferencing are out of this slice
  (decision 4). Guests specifically must remain addable later without a breaking change — see
  "Forward compatibility: guests" below.

### Forward compatibility: guests

Ben ruled guests out of V1 but explicitly ruled *against* designing them out. These constraints are
binding on the create path and on anything it shares with reschedule.

- The create tool's input schema stays an open JSON object with no `additionalProperties: false` and
  no "solo events only" wording baked into the contract. Adding an optional `attendees` array later
  is then a purely additive schema change: existing callers keep working, and no consumer has to be
  rewritten. (The gateway's `validateToolInput` does not enforce `additionalProperties` today, so an
  added field is accepted at the boundary the moment the schema declares it.)
- V1 handlers simply do not read an attendee field and do not send one to the provider. They must
  not *reject* the concept — no validation rule, type, or error path may be written in a form that
  means "this contract can never carry guests".
- `CalendarWriteService.createEvent` takes an options-object parameter, so an optional `attendees`
  member is added without changing any call site or the interface's arity. Same for the
  `GoogleApiClient.insertEvent` input — it is already an options object and already passes only the
  fields it is given, so an attendee list is a new optional key, not a signature change.
- No data-model change is required to add guests later: attendees are provider-side state, and the
  Moss cache already carries only a derived `attendeeCount` in `external_metadata`, which is
  additive JSONB. Nothing needs a migration to make room for guests, and nothing in the V1 schema
  work may introduce a column or constraint that would need one.
- The safety design is already guest-aware rather than guest-blind: decision 2 makes attendee count
  a first-class input to the confirmation and refusal policy, and the confirmation card already
  states how many people will be notified. Adding guest *creation* later plugs into that same
  policy function instead of needing a new one.
- What a guest slice will still need — and what V1 deliberately does not prejudge — is the trust
  decision about sending invitations on the user's behalf, the action-family tier that governs it,
  and how recipient addresses are supplied and validated. Those are product questions, not schema
  ones, and none of them are foreclosed by this design.

### Reschedule / move

- Add `updateEvent` to `GoogleApiClient` using the provider's patch semantics, sending only the
  changed start/end. Patch, not full update, so unrelated fields the user set by hand are never
  clobbered.
- Add `CalendarWriteService.rescheduleEvent`, taking an event reference plus a new start and either
  a new end or a duration. It resolves the target through the shared resolver, applies the same
  scope and feature-grant gates as delete, checks availability with freeBusy over the new window,
  and reports a conflict rather than moving into a busy slot unless the user asked to move it there
  explicitly.
- Per decision 2, reschedule refuses in V1 when the target event has other attendees, using a
  distinct outcome code the model turns into a plain explanation. Moss-created events and
  zero-attendee user events are movable. Attendee count comes from the same signal the confirmation
  card uses, so the refusal and the card can never disagree.
- Reschedule is atomic at the provider: patch the existing event. Never implement a move as
  delete-then-create — a failure mid-sequence would destroy the user's event.
- After a successful patch, mirror the new times into the cache on a best-effort basis using the
  same never-rethrow policy as create, and enqueue the same worker reconciliation delete uses.
- Recurring events: detect and refuse with a distinct outcome code (decision 5). The same refusal
  applies to delete.

### Delete

- Route delete through the shared resolver, which removes the throw entirely.
- Keep the existing scope gate, feature-grant gate, provider-403 handling, `already-gone` treatment
  of 404/410, and best-effort async cache eviction. None of that logic was wrong; only the id
  contract and the missing log were.
- Keep the calendar id read from `external_metadata.calendarId` with a `primary` fallback, and start
  recording the calendar id on the sync path so events on secondary calendars stop silently
  targeting `primary`.

### Provenance: user-created vs Moss-created

- Provenance is currently derived three inconsistent ways. Consolidate on one authoritative signal:
  `external_metadata.jarvisCreated` on the Moss cache row, written at mirror time. It survives
  resync — `upsertCachedEvent`'s conflict branch merges metadata with the jsonb `||` operator, so a
  sync upsert that omits the key preserves it.
- Keep writing the provider-side `extendedProperties.private.jarvisCreated` marker as the durable
  fallback for an event that is re-synced into a rebuilt cache, and read it during sync to
  reconstruct `jarvisCreated` when the cache row is new. That closes the case where the cache is
  cleared and every Moss-created block silently becomes "user-created".
- Retire the `jfb`-prefix regex in `serialize.ts` as the *source* of `isMossBlock`; derive the DTO
  field from the consolidated metadata signal instead, with the regex retained only as a
  compatibility fallback for rows written before this change. The prefix regex is an identifier
  format doing duty as a data model, and it cannot describe an event created by a future non-focus
  create path.
- Expose provenance to the assistant: every event returned by a calendar tool carries a
  `createdByMoss` boolean, so the model can state plainly whose event it is about to change and can
  apply the right confirmation posture.
- Provenance is a *safety and explanation* signal, never a permission boundary. Ownership and access
  are enforced by RLS on `owner_user_id`, exactly as today. A forged or missing provenance marker
  must never grant access to an event the actor does not own.

### Safety, confirmation, and permissions

- Keep both existing action families and their defaults: `calendar_writeback` (create) at
  `ask_each_time`, `calendar_management` (destructive) at `always_confirm`. Reschedule joins
  `calendar_management` — a move is a change to an existing commitment, not a new one.
- Keep `selfOperationGrant: "user_promotable"` on every calendar write tool. Nothing here is granted
  at install. The reasoning recorded on `proposeFocusBlock` — that the background follow-through
  worker is a second, uncarded reader of the family tier — applies unchanged and must be re-checked
  for any new tool wired into that worker.
- Confirmation cards for destructive and rearranging actions state the event title, its current
  time, the new time for a move, and the attendee count, and say plainly that attendees will be
  notified. The card text must not invent reassurance about reversibility.
- Per decision 1, confirmation is asymmetric by provenance: a Moss-created event may be deleted
  without a card once the user has promoted `calendar_management`; a user-created event always shows
  a confirmation card regardless of tier. Both branches, plus the decision-2 attendee rule, live in
  one policy function that takes provenance, attendee count, and the family tier and returns the
  required confirmation posture — so the rule is stated once, testable in isolation, and cheap to
  revise. Provenance here decides *how much friction*, never *whether the actor may act*; access is
  RLS, always.

### Invariant compliance

- **Private by default / RLS applies to admins.** All calendar reads and writes stay on the
  owner-scoped `DataContextDb` path with `assertDataContextDb` at every entry. No new query bypasses
  RLS, no role gains `BYPASSRLS`, and administrators gain no view of any user's events. The
  cross-user case must remain invisible (resolver returns "not found", never "forbidden", which
  would confirm existence).
- **Secrets never escape.** Access tokens stay inside the connectors layer. The new gateway logging
  records error class, message, tool name, and status code only — never tokens, provider bodies, or
  tool inputs. The generic caller-facing message is unchanged.
- **Metadata-only job payloads.** The cache-eviction and any new cache-reconciliation job carry only
  actor id, event id, and job kind. No titles, no times-as-content, no attendee data.
- **Provider-agnostic AI.** Nothing here routes or names a model. Calendar tools are described
  capability-first; the model that calls them is whatever the user configured.
- **Module isolation.** `packages/calendar` keeps owning the tool surface and the
  `CalendarWriteService` interface with no `@moss/connectors` import; `packages/chat` remains the
  composition host that supplies the concrete implementation. New provider methods land in
  `GoogleApiClient`, behind the same interface seam.
- **Never edit an applied migration.** Any schema or grant change ships as a new numbered file in
  `packages/calendar/sql/`.

### Vocabulary changes

- Audit and reword every model-facing and user-facing string that frames Moss's calendar power as
  "blocks": the create tool's name and description, its `title` field description, the
  `calendar.writeback` and `calendar.planning` sourceBehavior copy, and the `calendar_management`
  family label ("Delete calendar events" becomes accurate again once reschedule joins it).
- The model-facing description of the create tool must say it creates a calendar event, at a
  specific time or in a requested window; the delete and reschedule descriptions must say they work
  on any event on the user's calendar, not only ones Moss made.
- Internal identifiers may keep "focus" naming where a rename buys nothing —
  `focusBlockEventId`, the `jfb` id prefix, `focus-time.ts`. The `jfb` prefix in particular is
  load-bearing for existing rows and must not change.
- The Calendar page keeps visually distinguishing Moss-created events; that is useful provenance,
  not a capability claim.
- Per decision 3, `calendar.proposeFocusBlock` is renamed to `calendar.createEvent`. Renaming
  affects only strings the model sees plus
  historical `app.moss_action_audit_log.tool_name` rows and any in-flight action request; no durable
  configuration is keyed on the tool name.

## Testing Decisions

- The primary acceptance test drives external behavior through Chat: create an event at a named
  time, move it to a different time, and delete it, asserting each state against the provider client
  and the Moss cache. Assert tool results and rendered outcomes, not internal helper calls.
- Identifier-contract tests are the regression proof for #1693 and must cover, for every write tool:
  a Moss UUID reference, a provider-key reference, a well-formed reference for a non-existent event,
  a malformed reference, and a reference belonging to another user. All five return structured
  results; none throw; the cross-user case is indistinguishable from not-found.
- A test asserts that the id a tool returns can be fed back into a write tool — that is, take the
  identifiers from `listVisibleEvents` and from the create result, and prove each one deletes and
  reschedules successfully. This is the exact contract that was broken.
- Gateway tests prove a throwing handler produces a log record containing tool name, request id, and
  error class, and prove the record contains no token, no tool input value, and no provider body,
  while the caller-facing response is unchanged.
- Reschedule tests cover: successful move, duration-only change, move into a busy slot, provider
  permission denied, event already deleted at the provider, recurring-series refusal, cache-mirror
  failure not failing the operation, and proof that no delete-then-create path exists.
- Create tests cover: exact-time creation landing at exactly that time, band creation shifting with
  the shift reported, conflict on exact time, retry idempotency through the deterministic id and the
  409 path, missing scope, and feature grant disabled.
- Provenance tests prove a Moss-created event is marked in cache metadata and at the provider, that
  the marker survives a resync through the metadata merge, that it is reconstructed from the
  provider marker when the cache row is rebuilt, and that a user-created event is never marked. A
  test proves provenance grants no access: a forged marker on another user's event changes nothing.
- Confirmation-policy tests exercise the single policy function directly across the matrix of
  provenance (Moss-created vs user-created), attendee count (zero vs some), family tier, and
  operation (delete vs reschedule), proving decision 1's asymmetry and decision 2's refusal, and
  proving that provenance never widens access to an event the actor does not own.
- An extensibility test guards decision 4: an input containing an `attendees` field is accepted at
  the tool boundary rather than rejected, and V1 handlers ignore it and send nothing to the provider.
  This proves the contract stayed additive without shipping any guest behavior.
- Privacy tests use two actors and prove neither a normal nor an administrator context can read,
  move, or delete another user's events through any tool, route, or worker path.
- Data-handling tests prove job payloads carry only actor id, event id, and job kind, and that no
  event title or attendee data reaches logs, metrics, or queue payloads.
- Vocabulary tests assert the model-facing tool descriptions and the settings copy for the calendar
  behaviors contain no framing that limits Moss to "blocks" — a cheap guard against the regression
  drifting back in.
- The live acceptance run, on a live dev instance against a real connected Google account: ask Moss
  to create an event at a named time, verify it in Google Calendar and on the Moss Calendar page;
  ask it to move the event; ask it to delete it; then create an event by hand in Google Calendar,
  sync, and ask Moss to move and then delete that one. Record the confirmation cards shown and the
  wording used for at least one failure path.

## Out of Scope

- Guest lists, invitations, RSVP handling, and attendee management on create (decision 4) — deferred
  by design, not designed out; the create contract must stay additively extendable to guests.
- Moving an event that has other attendees (decision 2); V1 refuses with an explanation.
- Recurring series creation, and series-level or single-occurrence edit and deletion (decision 5).
- Choosing a write target other than the primary calendar (decision 6); reading an event's stored
  calendar id so secondary-calendar events can be deleted and moved IS in scope.
- Calendar providers other than Google.
- A REST write API or a create/edit/delete UI on the Calendar page — this slice is the assistant
  path. The read routes stay read-only.
- Rich event fields: description bodies, locations, reminders, colors, visibility, conferencing
  links, attachments.
- Automatic or proactive rescheduling — Moss rearranging the user's day on its own initiative
  without being asked. The follow-through worker's existing behavior is unchanged and gains no new
  powers here.
- Cross-calendar moves, calendar creation or deletion, and calendar sharing.
- Rebuilding the connector sync architecture or replacing the cache-mirror model. Google remains the
  source of truth and the cache remains best-effort.
- Undo or a change history for calendar operations.

## Further Notes

- The deepest lesson from #1693 is not the wrong id — it is that a tool schema documented a contract
  no other tool could satisfy, and the runtime turned the resulting mismatch into a database
  exception that nothing recorded. The identifier resolver and the gateway log are the two changes
  that make that class of failure visible rather than silent, and they are worth more than any
  single new capability in this spec.
- The generic `Tool X failed` message is correct and should stay. The bug was never that the message
  was generic; it was that the generic message was the *only* artifact the failure produced.
- Recording a calendar id on the sync path is a small change with a real payoff: without it, every
  event on a secondary calendar is addressed as if it lived on `primary`, so delete and reschedule
  will fail for reasons no error message can explain.
- Once reschedule exists, `calendar.planning` and `calendar.writeback` stop being "coming-soon" in
  the settings copy. Flipping those defaults is a deliberate product decision and should follow the
  live acceptance run, not precede it.
