import {
  assertDataContextDb,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import {
  applyAdditionEventId,
  chooseSlot,
  focusBlockEventId,
  resolveCalendarEventRef,
  isAllDayInterval,
  freeBusyQueryWindow,
  DEFAULT_TIMEZONE,
  type CalendarEventLookup,
  type CalendarWriteService,
  type FocusBlockWindow,
  type ProposeFocusResult,
  type ResolvedWindow,
  type CalendarRepository,
  type CalendarWriteOptions,
  type DeleteEventInput,
  type DeleteEventResult,
  type RescheduleEventInput,
  type RescheduleEventResult
} from "@moss/calendar";
import {
  GoogleApiError,
  GoogleConnectError,
  type GoogleConnectionService,
  type ConnectorsRepository,
  type GoogleApiClient
} from "@moss/connectors";
import type { ToolContext } from "@moss/module-sdk";
import type { ApplyEventProvenance } from "@moss/shared";
import type { PreferencesRepository } from "@moss/structured-state";

import {
  deleteApplyEvent,
  ensureApplyToken,
  isCalendarFeatureGranted,
  readApplyReads,
  rescheduleApplyEvent,
  type StagedRunner
} from "./calendar-apply-staging.js";

export interface CalendarWriteImplDeps {
  readonly googleService: GoogleConnectionService;
  readonly googleApiClient: GoogleApiClient;
  readonly connectorsRepository: ConnectorsRepository;
  readonly calendarRepository: CalendarRepository;
  readonly preferencesRepository?: Pick<PreferencesRepository, "get">;
  readonly enqueueCacheEvict?: (eventId: string, actorUserId: string) => Promise<string | null>;
  // Staging handle for the reserved-apply path only. The interactive focus
  // paths keep using the caller-provided transaction untouched.
  readonly dataContext?: Pick<DataContextRunner, "withDataContext">;
}

// The resolved window already carries concrete UTC instants (the tool's resolveWindow mapped
// the part-of-day band to UTC using the configured default tz). freeBusy and insertEvent
// receive RFC3339 timestamps with a 'Z' offset, so the instant is unambiguous and we
// deliberately do NOT pass a conflicting `timeZone` field to Google below (Codex HIGH #4);
// Google interprets a 'Z'-suffixed dateTime as the exact UTC instant. A tz IS still needed here,
// though: to tell an all-day freeBusy interval (start/end at local midnight, duration a
// multiple of 24h) apart from a real timed conflict before it reaches chooseSlot — see step 3.

// Reserved apply addition with staged transactions: reads, then provider work
// with no transaction open, then a fresh transaction for the cache mirror.
// Interactive focus blocks never enter this flow.
async function createApplyAdditionEvent(
  deps: CalendarWriteImplDeps,
  dataContext: StagedRunner,
  access: AccessContext,
  ctx: ToolContext,
  window: FocusBlockWindow,
  provenance: ApplyEventProvenance
): Promise<ProposeFocusResult> {
  // The service hands over a window exactly as long as the block; the duration
  // stays authoritative and the slot is never shifted.
  const start = window.start;
  const end = new Date(start.getTime() + window.durationMinutes * 60_000);
  const denied = (message: string): ProposeFocusResult => ({
    created: false,
    resolvedStart: start.toISOString(),
    resolvedEnd: end.toISOString(),
    shifted: false,
    conflict: "none",
    calendarMirror: "skipped-error",
    message
  });
  const eventId = applyAdditionEventId({
    actorUserId: ctx.actorUserId,
    planId: provenance.planId,
    blockId: provenance.blockId,
    planRevision: provenance.planRevision,
    operationId: provenance.operationId
  });

  const staged = await readApplyReads(deps, dataContext, access);
  if ("denied" in staged) return denied(staged.denied);
  const token = await ensureApplyToken(deps, dataContext, access, staged.reads);
  if ("denied" in token) return denied(token.denied);

  const freeBusy = await deps.googleApiClient.freeBusy({
    accessToken: token.accessToken,
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    calendarId: "primary"
  });
  const blocked = (freeBusy.busy ?? []).some(
    (busy) => start.toISOString() < busy.end && busy.start < end.toISOString()
  );
  if (blocked) {
    return {
      ...denied("That time just filled on your calendar — the addition was not created."),
      conflict: "no-clear-slot"
    };
  }

  let inserted: { id: string; htmlLink?: string };
  try {
    inserted = await deps.googleApiClient.insertEvent({
      accessToken: token.accessToken,
      calendarId: "primary",
      summary: window.title,
      start: start.toISOString(),
      end: end.toISOString(),
      eventId,
      extendedPrivateProperties: {
        jarvisCreated: "true",
        jarvisTool: "applyAddition",
        ...applyProvenanceProperties(provenance)
      }
    });
  } catch (error) {
    // 409 = this exact reservation is already on the calendar. Idempotent
    // success with the known id; the mirror below records it when newly cached.
    if (!(error instanceof GoogleApiError && error.statusCode === 409)) {
      return denied("Couldn't create the calendar event — try again.");
    }
    // The provider owns this id, but only a lookup against the same account
    // that ran the insert can verify the mirror. A missing or switched
    // account, or a failed lookup, throws: the caller records an unknown
    // outcome instead of a verified miss. The switched account's cache is
    // never queried.
    const cached = await dataContext.withDataContext(access, async (scopedDb) => {
      const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
      if (!active || active.id !== staged.reads.accountId) {
        throw new Error(
          "Your Google connection changed during the request — reconnect in Settings."
        );
      }
      return deps.calendarRepository.getByExternalId(scopedDb, {
        connectorAccountId: active.id,
        externalId: eventId
      });
    });
    if (!cached) {
      // The cache was checked against the same active account and holds no
      // row for this event: a verified miss, not an unchecked mirror.
      return {
        created: true,
        resolvedStart: start.toISOString(),
        resolvedEnd: end.toISOString(),
        shifted: false,
        conflict: "none",
        googleEventId: eventId,
        calendarMirror: "not-cached",
        message: "This addition is already on your calendar."
      };
    }
    return {
      created: true,
      resolvedStart: start.toISOString(),
      resolvedEnd: end.toISOString(),
      shifted: false,
      conflict: "none",
      googleEventId: eventId,
      calendarEventId: cached.id,
      calendarMirror: "written",
      message: "This addition is already on your calendar."
    };
  }

  const mirrored = await dataContext.withDataContext(access, (scopedDb) =>
    mirrorEvent(
      deps,
      scopedDb,
      inserted,
      { start, end },
      { start, end, durationMinutes: window.durationMinutes, title: window.title },
      { provenance }
    )
  );
  return {
    created: true,
    resolvedStart: start.toISOString(),
    resolvedEnd: end.toISOString(),
    shifted: false,
    conflict: "none",
    googleEventId: inserted.id,
    calendarEventId: mirrored.calendarEventId,
    calendarMirror: mirrored.status
  };
}

export function buildCalendarWriteService(deps: CalendarWriteImplDeps): CalendarWriteService {
  return {
    async createEvent(
      scopedDbRaw: unknown,
      ctx: ToolContext,
      window: FocusBlockWindow,
      options: CalendarWriteOptions = {}
    ): Promise<ProposeFocusResult> {
      // Reserved apply additions never touch the caller's handle: they stage
      // their own short transactions and run provider I/O with none open.
      // Interactive focus blocks continue below with the caller's transaction.
      if (options.provenance) {
        if (!deps.dataContext) {
          throw new Error("Apply additions require a dataContext staging handle.");
        }
        return createApplyAdditionEvent(
          deps,
          deps.dataContext,
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          ctx,
          {
            start: window.start,
            end: window.end,
            durationMinutes: window.durationMinutes,
            title: window.title
          },
          options.provenance
        );
      }
      assertDataContextDb(scopedDbRaw);
      const scopedDb = scopedDbRaw as DataContextDb;
      // window.start..window.end is the SEARCH WINDOW (e.g. the morning band); the block
      // length is window.durationMinutes (already clamped by resolveWindow). Do NOT recompute
      // duration from (end - start) — that would insert a band-width block, not the request.
      const resolved: ResolvedWindow = {
        start: window.start,
        end: window.end,
        durationMinutes: window.durationMinutes,
        title: window.title
      };

      // 1. Scope check — no Google call without calendar-write scope. Reads the stored granted
      // scopes (connector_accounts.scopes), which are the authoritative propose-time gate. KNOWN
      // LIMITATION (Codex MED #10): the shipped getFreshAccessToken writes back bundle.grantedScopes
      // and does not reconcile refreshed.scope, so if a user later narrows scopes out-of-band the
      // stored set can be stale. We do NOT re-author that shipped connectors/OAuth code here ("no new
      // OAuth code" — AC#7). The defense-in-depth backstop is Google itself: insertEvent on a token
      // lacking calendar scope returns 403, which surfaces as a body-free "couldn't create" message
      // (created:false), never a silent success. A connectors-owned follow-up may reconcile scopes on
      // refresh; tracked, not in this slice.
      const calendarScope = await deps.connectorsRepository.getCalendarWriteScopeState(scopedDb);
      if (!calendarScope?.hasScope) {
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message:
            "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it."
        };
      }
      if (!(await isCalendarFeatureGranted(deps, scopedDb, calendarScope.accountId))) {
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message: "Calendar access is disabled for this account in Settings."
        };
      }

      // 2. Fresh access token (refreshes on <60s-to-expiry, after approval).
      let accessToken: string;
      try {
        accessToken = await deps.googleService.getFreshAccessToken(scopedDb);
      } catch (error) {
        const message =
          error instanceof GoogleConnectError
            ? "Connect Google in Settings first."
            : "Couldn't refresh your Google access — reconnect in Settings.";
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message
        };
      }

      // 3. Live freeBusy + slot choice.
      let slot;
      try {
        // Ask about whole local days, not the band we want to schedule in (#1711). Google clips
        // busy intervals to the query bounds, and the all-day filter below identifies an all-day
        // event by its endpoints landing on local midnight — a clipped interval has lost exactly
        // that evidence, so querying the band directly made the filter unable to see the events
        // it exists to drop. chooseSlot narrows back to the band on its own.
        const tz = ctx.localTimezone ?? DEFAULT_TIMEZONE;
        const query = freeBusyQueryWindow(resolved, tz);
        const fb = await deps.googleApiClient.freeBusy({
          accessToken,
          timeMin: query.timeMin,
          timeMax: query.timeMax,
          calendarId: "primary"
        });
        // All-day events (reminders, holidays, ...) come back from freeBusy as busy too, but
        // they aren't real time conflicts — drop them before slot-picking runs (#1711).
        const timedBusy = fb.busy.filter((b) => !isAllDayInterval(b, tz));
        slot = chooseSlot(resolved, timedBusy, resolved.durationMinutes);
      } catch {
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message: "Couldn't check your calendar availability — try again."
        };
      }

      if (slot.conflict === "no-clear-slot") {
        return {
          created: false,
          resolvedStart: slot.start.toISOString(),
          resolvedEnd: slot.end.toISOString(),
          shifted: false,
          conflict: "no-clear-slot",
          calendarMirror: "skipped-error",
          message: "No clear slot in that window — try a different time."
        };
      }

      // 4. Insert the event, tagged jarvisCreated, with a DETERMINISTIC event id so a retry of
      // this exact approved proposal cannot double-book the real calendar. Google rejects a
      // duplicate id with 409 Conflict, which we treat as idempotent success below. The id is
      // keyed on the ORIGINAL APPROVED PROPOSAL (the requested search window + duration + actor +
      // title), NOT the post-freeBusy chosen slot: after a lost insert response the already-created
      // block shows as busy, so a retry's freeBusy would shift the slot and a slot-keyed id would
      // miss the 409 and create a second event (Codex HIGH round 2). resolved.start/.end is the
      // requested window (invariant across retries), so the id is stable however the slot shifts.
      // Reserved apply additions return through the staged flow above with an
      // operation-derived id; this path only ever sees interactive focus blocks.
      const eventId = focusBlockEventId({
        actorUserId: ctx.actorUserId,
        windowStart: resolved.start,
        windowEnd: resolved.end,
        durationMinutes: resolved.durationMinutes,
        title: resolved.title
      });
      let inserted: { id: string; htmlLink?: string };
      try {
        inserted = await deps.googleApiClient.insertEvent({
          accessToken,
          calendarId: "primary",
          summary: resolved.title,
          // RFC3339 with 'Z' — the UTC instant is unambiguous; no timeZone field (see note above).
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          eventId,
          extendedPrivateProperties: {
            jarvisCreated: "true",
            jarvisTool: "createEvent"
          }
        });
      } catch (error) {
        // 409 Conflict = an event with this deterministic id already exists, i.e. this exact
        // approved proposal was already inserted (a duplicate/retry). Idempotent success — the
        // block is on the calendar; return created:true with the known id rather than prompting
        // the user to "try again" (which would otherwise risk a second insert).
        //
        // IMPORTANT: do NOT report THIS retry's chosen slot or mirror it. In the realistic retry,
        // freeBusy now sees the first-attempt block as busy, so `slot` here is a SHIFTED guess that
        // does NOT match where the real event actually sits (the first-attempt slot). We don't have
        // the stored event's exact time without an extra events.get (out of scope this slice), so we
        // report the requested WINDOW (truthful: the block is somewhere in the approved window) with
        // shifted:false/conflict:none and skip the cache mirror (mirroring the wrong time would
        // corrupt the cache). The Google event remains the source of truth (Codex HIGH round 3).
        if (error instanceof GoogleApiError && error.statusCode === 409) {
          const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
          const cached = active
            ? await deps.calendarRepository.getByExternalId(scopedDb, {
                connectorAccountId: active.id,
                externalId: eventId
              })
            : undefined;
          return {
            created: true,
            resolvedStart: resolved.start.toISOString(),
            resolvedEnd: resolved.end.toISOString(),
            shifted: false,
            conflict: "none",
            googleEventId: eventId,
            calendarEventId: cached?.id,
            calendarMirror: cached ? "written" : "skipped-error",
            message: "This focus block is already on your calendar."
          };
        }
        return {
          created: false,
          resolvedStart: slot.start.toISOString(),
          resolvedEnd: slot.end.toISOString(),
          shifted: slot.shifted,
          conflict: slot.conflict,
          calendarMirror: "skipped-error",
          message: "Couldn't create the calendar event — try again."
        };
      }

      // 5. Best-effort cache mirror (gated on connector-sync RLS 0066). Never fails the call.
      const mirrored = await mirrorEvent(deps, scopedDb, inserted, slot, resolved, {
        followThroughTargetRef: options.followThroughTargetRef,
        provenance: options.provenance
      });
      if (options.requireCacheMirror && mirrored.status !== "written") {
        try {
          await deps.googleApiClient.deleteEvent({
            accessToken,
            calendarId: "primary",
            eventId: inserted.id
          });
        } catch {
          // Provider rollback is best-effort; caller still gets created:false because no tracked
          // Jarv1s row exists for safe later cancellation.
        }
        return {
          created: false,
          resolvedStart: slot.start.toISOString(),
          resolvedEnd: slot.end.toISOString(),
          shifted: slot.shifted,
          conflict: slot.conflict === "none" ? "none" : "shifted",
          calendarMirror: mirrored.status,
          message: "Couldn't track the Calendar-created block safely, so it was not kept."
        };
      }

      return {
        created: true,
        resolvedStart: slot.start.toISOString(),
        resolvedEnd: slot.end.toISOString(),
        shifted: slot.shifted,
        conflict: slot.conflict === "none" ? "none" : "shifted",
        googleEventId: inserted.id,
        calendarEventId: mirrored.calendarEventId,
        calendarMirror: mirrored.status
      };
    },

    async deleteEvent(
      scopedDbRaw: unknown,
      ctx: ToolContext,
      input: DeleteEventInput
    ): Promise<DeleteEventResult> {
      // Reserved apply removals never touch the caller's handle: they stage
      // their own short transactions and run the provider delete with none
      // open. Interactive deletes continue below with the caller's handle.
      if (scopedDbRaw === undefined || scopedDbRaw === null) {
        if (!deps.dataContext) {
          throw new Error("Apply removals require a dataContext staging handle.");
        }
        return deleteApplyEvent(
          deps,
          deps.dataContext,
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          ctx,
          input.eventId
        );
      }
      assertDataContextDb(scopedDbRaw);
      const scopedDb = scopedDbRaw as DataContextDb;

      // 1. Resolve the cached row (owner-RLS-scoped; cross-user row is invisible → undefined).
      let row: Awaited<ReturnType<typeof deps.calendarRepository.getById>>;
      try {
        row = await deps.calendarRepository.getById(scopedDb, input.eventId);
      } catch (error) {
        return {
          deleted: false,
          googleDeleted: "skipped-error",
          cacheMirror: "not-cached",
          message: error instanceof Error ? error.message : "Couldn't look up that event."
        };
      }
      if (!row) {
        return {
          deleted: false,
          googleDeleted: "skipped-error",
          cacheMirror: "not-cached",
          message: "That event isn't in your calendar — it may already be gone."
        };
      }

      // 2. Scope gate — no Google call without calendar-write scope.
      const calendarScope = await deps.connectorsRepository.getCalendarWriteScopeState(scopedDb);
      if (!calendarScope?.hasScope) {
        return {
          deleted: false,
          googleDeleted: "skipped-no-scope",
          cacheMirror: "not-cached",
          message:
            "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it."
        };
      }
      if (!(await isCalendarFeatureGranted(deps, scopedDb, calendarScope.accountId))) {
        return {
          deleted: false,
          googleDeleted: "skipped-no-scope",
          cacheMirror: "not-cached",
          message: "Calendar access is disabled for this account in Settings."
        };
      }

      // 3. Fresh access token.
      let accessToken: string;
      try {
        accessToken = await deps.googleService.getFreshAccessToken(scopedDb);
      } catch (error) {
        const message =
          error instanceof GoogleConnectError
            ? "Connect Google in Settings first."
            : "Couldn't refresh your Google access — reconnect in Settings.";
        return {
          deleted: false,
          googleDeleted: "skipped-error",
          cacheMirror: "not-cached",
          message
        };
      }

      // 4. Calendar id: use the row's recorded calendarId, fall back to "primary" (V1 default).
      const calendarId =
        ((row.external_metadata as Record<string, unknown> | null)?.calendarId as
          | string
          | undefined) ?? "primary";

      // 5. Delete at Google.
      let googleDeleted: "deleted" | "already-gone";
      try {
        const result = await deps.googleApiClient.deleteEvent({
          accessToken,
          calendarId,
          eventId: row.external_id
        });
        googleDeleted = result.deleted;
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 403) {
          return {
            deleted: false,
            googleDeleted: "skipped-error",
            cacheMirror: "not-cached",
            message: "You don't have permission to delete events on that calendar."
          };
        }
        return {
          deleted: false,
          googleDeleted: "skipped-error",
          cacheMirror: "not-cached",
          message: "Couldn't delete the event — try again."
        };
      }

      // 6. Best-effort async cache eviction. NEVER rethrow — enqueue failure must not fail a
      // successful external delete. Google is the source of truth; the worker reconciles the cache.
      let cacheMirror: DeleteEventResult["cacheMirror"];
      if (deps.enqueueCacheEvict) {
        try {
          await deps.enqueueCacheEvict(input.eventId, ctx.actorUserId);
          cacheMirror = "queued";
        } catch {
          cacheMirror = "skipped-error";
        }
      } else {
        cacheMirror = "skipped-error";
      }

      return {
        deleted: true,
        googleDeleted,
        cacheMirror,
        deletedTitle: row.title
      };
    },

    async rescheduleEvent(
      scopedDbRaw: unknown,
      ctx: ToolContext,
      input: RescheduleEventInput
    ): Promise<RescheduleEventResult> {
      // Reserved apply moves never touch the caller's handle: they stage
      // their own short transactions and run the provider patch with none
      // open. Interactive reschedules continue below with the caller's handle.
      if (scopedDbRaw === undefined || scopedDbRaw === null) {
        if (!deps.dataContext) {
          throw new Error("Apply moves require a dataContext staging handle.");
        }
        return rescheduleApplyEvent(
          deps,
          deps.dataContext,
          { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
          input.eventRef,
          input.newStart,
          input.newEnd
        );
      }
      assertDataContextDb(scopedDbRaw);
      const scopedDb = scopedDbRaw as DataContextDb;

      // 1. Resolve the ref (moss id or external id) via the shared resolver — owner-RLS-scoped.
      const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
      const resolved = await resolveCalendarEventRef(
        scopedDb,
        deps.calendarRepository,
        active?.id,
        input.eventRef
      );
      if (!resolved.found) {
        return { ok: false, reason: "not_found" };
      }
      const row = resolved.event;

      // 2. Hard refusal on attendees — independent of the confirmation card (spec decision 2).
      // Read from external_metadata, already synced at sync time (google-sync-phases.ts:172).
      const md = row.external_metadata as Record<string, unknown> | null;
      const attendeeCount = typeof md?.attendeeCount === "number" ? md.attendeeCount : 0;
      if (attendeeCount > 0) {
        return { ok: false, reason: "has_attendees" };
      }

      // 3. Scope gate — no Google call without calendar-write scope.
      const calendarScope = await deps.connectorsRepository.getCalendarWriteScopeState(scopedDb);
      if (!calendarScope?.hasScope) {
        return {
          ok: false,
          reason: "no_scope",
          message:
            "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it."
        };
      }
      if (!(await isCalendarFeatureGranted(deps, scopedDb, calendarScope.accountId))) {
        return {
          ok: false,
          reason: "no_scope",
          message: "Calendar access is disabled for this account in Settings."
        };
      }

      // 4. Fresh access token.
      let accessToken: string;
      try {
        accessToken = await deps.googleService.getFreshAccessToken(scopedDb);
      } catch (error) {
        const message =
          error instanceof GoogleConnectError
            ? "Connect Google in Settings first."
            : "Couldn't refresh your Google access — reconnect in Settings.";
        return { ok: false, reason: "provider_error", message };
      }

      // 5. Calendar id: use the row's recorded calendarId, fall back to "primary" (V1 default).
      const calendarId = ((md?.calendarId as string | undefined) ?? "primary") satisfies string;

      // 6. Patch at Google — SAME external event id, never delete-then-create.
      try {
        await deps.googleApiClient.patchEvent(accessToken, calendarId, row.external_id, {
          start: { dateTime: input.newStart.toISOString(), timeZone: "UTC" },
          end: { dateTime: input.newEnd.toISOString(), timeZone: "UTC" }
        });
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 403) {
          return {
            ok: false,
            reason: "provider_error",
            message: "You don't have permission to reschedule events on that calendar."
          };
        }
        return {
          ok: false,
          reason: "provider_error",
          message: "Couldn't reschedule the event — try again."
        };
      }

      // 7. Mirror the new start/end into the cache. Best-effort but reported: on failure the
      // Google-side move already succeeded, so it's still ok:true — the worker reconciles the
      // cache on the next sync.
      try {
        const mirrored = await deps.calendarRepository.upsertCachedEvent(scopedDb, {
          connectorAccountId: row.connector_account_id,
          externalId: row.external_id,
          title: row.title,
          startsAt: input.newStart,
          endsAt: input.newEnd
        });
        return { ok: true, calendarEventId: mirrored.id };
      } catch {
        return { ok: true, calendarEventId: row.id };
      }
    },

    async lookupEvent(
      _scopedDbRaw: unknown,
      ctx: ToolContext,
      input: { eventId: string }
    ): Promise<CalendarEventLookup> {
      // Apply-only readback: the caller's handle stays untouched while staging
      // opens its own short transactions around database reads alone. The
      // caller maps every failure below to an unknown outcome, never absence.
      if (!deps.dataContext) {
        throw new Error("Event lookup requires a dataContext staging handle.");
      }
      const dataContext = deps.dataContext;
      const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
      const staged = await readApplyReads(deps, dataContext, access);
      if ("denied" in staged) {
        throw new Error(staged.denied);
      }
      const token = await ensureApplyToken(deps, dataContext, access, staged.reads);
      if ("denied" in token) {
        throw new Error(token.denied);
      }
      let event;
      try {
        event = await deps.googleApiClient.getEvent({
          accessToken: token.accessToken,
          eventId: input.eventId
        });
      } catch (error) {
        if (error instanceof GoogleApiError && error.statusCode === 404) {
          return { found: false };
        }
        throw error;
      }
      if (event.status === "cancelled") return { found: false };
      return {
        found: true,
        id: event.id,
        summary: event.summary ?? null,
        start: event.start?.dateTime ?? event.start?.date ?? null,
        end: event.end?.dateTime ?? event.end?.date ?? null,
        provenance: { ...(event.extendedProperties?.private ?? {}) },
        attendeeCount: event.attendees?.length ?? 0
      };
    }
  };
}

function applyProvenanceProperties(
  provenance: ApplyEventProvenance | undefined
): Record<string, string> {
  if (!provenance) return {};
  return {
    jarvisActorUserId: provenance.actorUserId,
    jarvisPlanId: provenance.planId,
    jarvisBlockId: provenance.blockId,
    jarvisPlanRevision: String(provenance.planRevision),
    jarvisOperationId: provenance.operationId
  };
}

async function mirrorEvent(
  deps: CalendarWriteImplDeps,
  scopedDb: DataContextDb,
  inserted: { id: string; htmlLink?: string },
  slot: { start: Date; end: Date },
  resolved: ResolvedWindow,
  options: {
    readonly followThroughTargetRef?: string;
    readonly provenance?: ApplyEventProvenance;
  } = {}
): Promise<{ status: "written" | "skipped-rls" | "skipped-error"; calendarEventId?: string }> {
  try {
    const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
    if (!active) return { status: "skipped-error" };
    const row = await deps.calendarRepository.upsertCachedEvent(scopedDb, {
      connectorAccountId: active.id,
      externalId: inserted.id,
      title: resolved.title,
      startsAt: slot.start,
      endsAt: slot.end,
      externalMetadata: {
        jarvisCreated: true,
        // Reserved apply additions carry provenance; ordinary interactive
        // creation does not. The cache source must agree with the provider tag.
        source: options.provenance ? "applyAddition" : "createEvent",
        ...(options.provenance ? { provenance: { ...options.provenance } } : {}),
        htmlLink: inserted.htmlLink ?? null,
        ...(options.followThroughTargetRef
          ? { followThroughTargetRef: options.followThroughTargetRef }
          : {})
      }
    });
    return { status: "written", calendarEventId: row.id };
  } catch (error) {
    // The calendar INSERT policy requires provider_type IN (...,'google') (connector-sync
    // migration 0066). If absent, the WITH CHECK fails — record skipped-rls; the Google event
    // is the source of truth. Any other DB error → skipped-error. NEVER rethrow.
    // Classify on the STABLE Postgres SQLSTATE first (42501 = insufficient_privilege, raised
    // by an RLS WITH CHECK / policy violation); message text is locale/version-dependent, so
    // only fall back to it (Codex MED #7). pg/Kysely surface `code` on the error object.
    const code = (error as { code?: string } | null)?.code;
    if (code === "42501") return { status: "skipped-rls" };
    const message = error instanceof Error ? error.message : "";
    return {
      status: /row-level security|violates row-level|policy/i.test(message)
        ? "skipped-rls"
        : "skipped-error"
    };
  }
}
