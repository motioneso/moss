import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolContext, ToolExecute, ToolResult, ToolServices } from "@moss/module-sdk";
import { nullableStringSchema } from "@moss/shared";

import type { CalendarWriteService } from "./calendar-write-service.js";
import {
  DEFAULT_TIMEZONE,
  resolveWindow,
  type FocusBlockInput,
  type PartOfDay
} from "./focus-time.js";

export const calendarToolEventsOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events", "accounts", "gaps"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "connectorAccountId",
          "providerLabel",
          "title",
          "startsAt",
          "endsAt",
          "allDay",
          "location",
          "attendeeCount",
          "flags",
          "source",
          "degradedReason"
        ],
        properties: {
          id: { type: "string", description: "Provider event key" },
          connectorAccountId: { type: "string" },
          providerLabel: { type: "string" },
          title: { type: "string" },
          startsAt: { type: "string" },
          endsAt: { type: "string" },
          allDay: { type: "boolean" },
          location: nullableStringSchema,
          attendeeCount: { type: "number" },
          flags: {
            type: "array",
            items: {
              type: "string",
              enum: ["conflict", "early", "late", "has_location", "prep_attendees"]
            }
          },
          source: { type: "string", enum: ["live", "cache"] },
          degradedReason: nullableStringSchema
        }
      }
    },
    accounts: {
      type: "array",
      items: {
        type: "object",
        description: "Per-account read outcome: source live|cache and any degradedReason"
      }
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        description:
          "Accounts that could not be read at all (auth_error, connector_revoked, " +
          "feature_grant_disabled, unsupported_provider, service_unavailable)"
      }
    }
  }
} as const;

// Structural interfaces — no @moss/connectors import (module isolation). Shapes mirror
// the connectors SourceContextService calendar surface.
interface SourceAccountMetaShape {
  readonly connectorAccountId: string;
  readonly providerId: string;
  readonly providerLabel: string;
}

interface CalendarContextItemShape {
  readonly eventKey: string;
  readonly account: SourceAccountMetaShape;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly attendeeCount: number;
  readonly flags: readonly string[];
  readonly source: "live" | "cache";
  readonly degradedReason: string | null;
}

interface SourceContextService {
  listEmailContext(scopedDb: DataContextDb, input: Record<string, unknown>): Promise<unknown>;
  listCalendarContext(
    scopedDb: DataContextDb,
    input: { windowStart?: string; windowEnd?: string; limit?: number }
  ): Promise<{
    items: readonly CalendarContextItemShape[];
    accounts: readonly unknown[];
    gaps: readonly unknown[];
  }>;
}

function narrowSourceContext(services: ToolServices | undefined): SourceContextService {
  const svc = (services ?? {}).sourceContext as SourceContextService | undefined;
  if (!svc || typeof svc.listCalendarContext !== "function") {
    throw new Error("sourceContext service is not available"); // fail closed — never stale direct cache reads
  }
  return svc;
}

function serializeCalendarContextItem(item: CalendarContextItemShape) {
  return {
    id: item.eventKey,
    connectorAccountId: item.account.connectorAccountId,
    providerLabel: item.account.providerLabel,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    allDay: item.allDay,
    location: item.location,
    attendeeCount: item.attendeeCount,
    flags: item.flags,
    source: item.source,
    degradedReason: item.degradedReason
  };
}

// DEFAULT_TIMEZONE (imported from focus-time.js) is the single source of truth for
// "morning/afternoon/evening" band resolution + the card preview — the impl does NOT make a
// Google calendarList.get call to discover the primary-calendar tz (out of scope this slice;
// see Codex HIGH #4 / spec Open risk #1). resolveWindow maps the band to a concrete UTC
// instant using THIS tz; the inserted event carries explicit UTC start/end (RFC3339 with a
// 'Z' offset), so the instant is unambiguous regardless of the user's calendar tz. A future
// slice may fetch the real calendar tz; this slice accepts the configured default and the
// card text is only the REQUESTED-window preview.

export const calendarListVisibleEventsExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceContext = narrowSourceContext(services);
  const windowStart = typeof input.startsAfter === "string" ? input.startsAfter : undefined;
  const windowEnd = typeof input.startsBefore === "string" ? input.startsBefore : undefined;
  const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
  const { items, accounts, gaps } = await sourceContext.listCalendarContext(scopedDb, {
    ...(windowStart ? { windowStart } : {}),
    ...(windowEnd ? { windowEnd } : {}),
    ...(limit ? { limit } : {})
  });
  return { data: { events: items.map(serializeCalendarContextItem), accounts, gaps } };
};

function narrowCalendarWrite(services: ToolServices | undefined): CalendarWriteService {
  const svc = (services ?? {}).calendarWrite as CalendarWriteService | undefined;
  if (!svc || typeof svc.proposeAndInsert !== "function") {
    throw new Error("calendarWrite service is not available");
  }
  return svc;
}

function readInput(input: Record<string, unknown>): FocusBlockInput {
  return {
    date: typeof input.date === "string" ? input.date : undefined,
    partOfDay: input.partOfDay as PartOfDay | undefined,
    start: typeof input.start === "string" ? input.start : undefined,
    durationMinutes: typeof input.durationMinutes === "number" ? input.durationMinutes : undefined,
    title: typeof input.title === "string" ? input.title : undefined
  };
}

/**
 * Freezes a RELATIVE proposal (no `date`, no `start`) to an absolute calendar date IN PLACE on the
 * shared input object, the first time it is called. resolveWindow derives "tomorrow" from the
 * supplied clock, so the approval card (summarize, at card-creation) and the execution (execute,
 * AFTER the user approves) would otherwise each compute "tomorrow" from their OWN clock — if the
 * card is shown before local midnight and approved after, the inserted day, the card text, and the
 * deterministic Google id all diverge (the user approves day X, the calendar gets day Y; and the
 * idempotency id changes for the same user-visible proposal). Codex HIGH round 4.
 *
 * The gateway passes the SAME input object reference to summarize and then to execute within one
 * confirmAndRun call (gateway.ts confirmAndRun: summaryFor(input) then runHandler(...,input)). So
 * summarize stamping `input.date` here freezes the proposal at card-creation time; execute reads
 * the same frozen `input.date` after the approval gap. Idempotent: if `date`/`start` is already
 * present (explicit input, or a prior freeze), this is a no-op. Only the day is frozen; the live
 * freeBusy slot choice still runs fresh at execute time (that is the point of conflict-checking).
 */
export function freezeRelativeDate(input: Record<string, unknown>, now: Date, tz: string): void {
  if (typeof input.date === "string" || typeof input.start === "string") {
    return; // already absolute (explicit or previously frozen)
  }
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  // "tomorrow" in tz: take today's local yyyy-mm-dd and add one day via a UTC-noon anchor (noon
  // avoids any DST edge flipping the calendar day).
  const todayLocal = fmt.format(now); // yyyy-mm-dd
  const [y, m, d] = todayLocal.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1, 12));
  input.date = tomorrow.toISOString().slice(0, 10);
}

export const calendarProposeFocusBlockExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const service = narrowCalendarWrite(services);
  const tz = ctx.localTimezone ?? DEFAULT_TIMEZONE;
  // Freeze a relative "tomorrow" if not already frozen by summarize — keeps the executed day in
  // lockstep with the approval card across the midnight boundary (Codex HIGH round 4).
  freezeRelativeDate(input, new Date(), tz);
  const resolved = resolveWindow(readInput(input), new Date(), tz);
  const result = await service.proposeAndInsert(scopedDb, ctx, {
    start: resolved.start,
    end: resolved.end,
    durationMinutes: resolved.durationMinutes, // REQUESTED block length, not the band width
    title: resolved.title
  });
  return { data: { ...result } };
};

export const summarizeProposeFocusBlock = (
  input: Record<string, unknown>,
  ctx: ToolContext
): string => {
  const tz = ctx.localTimezone ?? DEFAULT_TIMEZONE;
  // Stamp the absolute "tomorrow" onto the shared input at card-creation time so execute (which
  // receives the same input object after the approval gap) inserts exactly the day the card shows,
  // and the deterministic Google id stays stable for this proposal (Codex HIGH round 4).
  freezeRelativeDate(input, new Date(), tz);
  const resolved = resolveWindow(readInput(input), new Date(), tz);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const startStr = fmt.format(resolved.start);
  const endStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(resolved.end);
  return `Block "${resolved.title}" ${startStr}–${endStr} on your primary calendar (or the next clear slot if that window is busy).`;
};

export const calendarDeleteEventExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const service = narrowCalendarWrite(services);
  const eventId = typeof input.eventId === "string" ? input.eventId : undefined;
  if (!eventId) {
    return {
      data: {
        deleted: false,
        googleDeleted: "skipped-error",
        cacheMirror: "not-cached",
        message: "eventId is required"
      }
    };
  }
  const result = await service.deleteEvent(scopedDb, ctx, { eventId });
  return { data: { ...result } };
};

export function summarizeDeleteEvent(input: Record<string, unknown>, _ctx: ToolContext): string {
  const title = typeof input.displayTitle === "string" ? input.displayTitle : undefined;
  const when = typeof input.displayWhen === "string" ? input.displayWhen : undefined;
  if (title && when) {
    return (
      `Delete **"${title}"** (${when}) from your calendar? ` +
      `Attendees will be notified of the cancellation. This can't be undone from Moss.`
    );
  }
  if (title) {
    return (
      `Delete **"${title}"** from your calendar? ` +
      `Attendees will be notified of the cancellation. This can't be undone from Moss.`
    );
  }
  return (
    `Delete this calendar event? ` +
    `Attendees will be notified of the cancellation. This can't be undone from Moss.`
  );
}
