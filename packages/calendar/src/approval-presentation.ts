import { createHash } from "node:crypto";
import { assertDataContextDb } from "@moss/db";
import {
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ToolApprovalPresentation,
  type ToolContext
} from "@moss/module-sdk";
import {
  DEFAULT_LOCALE_SETTINGS,
  formatLocaleDateTime,
  type LocaleSettingsDto
} from "@moss/shared";
import { DEFAULT_TIMEZONE, resolveWindow, type FocusBlockInput } from "./focus-time.js";
import { freezeRelativeDate } from "./tools.js";

/** The person's region and 12/24-hour choice, in the zone the calendar tools resolve windows in. */
function personLocale(ctx: ToolContext): LocaleSettingsDto {
  return {
    ...(ctx.locale ?? DEFAULT_LOCALE_SETTINGS),
    timezone: ctx.localTimezone ?? DEFAULT_TIMEZONE
  };
}

/** The submitted proposal and the executor share resolveWindow's normalization. */
export const calendarCreatePresentation: ToolApprovalPresentation = async (_db, input, ctx) => {
  const submitted = presentApprovalFields(input, {
    date: { label: "Date", present: approvalText },
    partOfDay: {
      label: "Part of day",
      present: approvalChoice({ morning: "Morning", afternoon: "Afternoon", evening: "Evening" })
    },
    start: { label: "Requested start", present: approvalText },
    durationMinutes: { label: "Requested minutes", present: approvalNumber },
    title: { label: "Requested title", present: approvalText }
  });
  if (!submitted) return null;
  const locale = personLocale(ctx);
  const zone = locale.timezone;
  // summarizeProposeFocusBlock stamps this on the gateway-owned input before freezing it.
  const normalized = { ...input };
  freezeRelativeDate(normalized, new Date(), zone);
  const window = resolveWindow(normalized as FocusBlockInput, new Date(), zone);
  return {
    target: window.title,
    fields: [
      ...submitted,
      { label: "Calendar", value: "Primary calendar" },
      { label: "Time zone", value: zone },
      { label: "Search from", value: formatLocaleDateTime(window.start, locale) },
      { label: "Search until", value: formatLocaleDateTime(window.end, locale) },
      { label: "Event length", value: `${window.durationMinutes} minutes` },
      { label: "If busy", value: "Use the next clear slot" }
    ]
  };
};

/** Resolve both supported references only among this actor's own cached events. */
function eventPresentation(kind: "delete" | "reschedule"): ToolApprovalPresentation {
  return async (db, input, ctx) => {
    assertDataContextDb(db);
    const reference = kind === "delete" ? input.eventId : input.eventRef;
    if (typeof reference !== "string" || !reference) return null;
    const { eventId: _eventId, eventRef: _eventRef, displayTitle, displayWhen, ...changes } = input;
    // These legacy hints never influence execution or disclosure. Reject malformed hints,
    // and read the authoritative target below instead of trusting the model's display prose.
    if (
      (displayTitle !== undefined && typeof displayTitle !== "string") ||
      (displayWhen !== undefined && typeof displayWhen !== "string")
    )
      return null;
    if (kind === "delete" ? _eventRef !== undefined : _eventId !== undefined) return null;
    const fields = presentApprovalFields(
      changes,
      kind === "delete"
        ? {}
        : {
            newStart: { label: "New start", present: approvalText },
            newEnd: { label: "New end", present: approvalText }
          },
      kind === "delete" ? [] : ["newStart", "newEnd"]
    );
    if (!fields) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      reference
    );
    if (kind === "delete" && !uuid) return null;
    const rows = await db.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .where("owner_user_id", "=", ctx.actorUserId)
      .where(uuid ? "id" : "external_id", "=", reference)
      .limit(2)
      .execute();
    // An ambiguous provider reference must not pick an arbitrary account's same-named event.
    const event = rows.length === 1 ? rows[0] : null;
    if (!event?.title?.trim()) return null;
    const locale = personLocale(ctx);
    return {
      target: event.title,
      fields: [
        { label: "Current start", value: formatLocaleDateTime(event.starts_at, locale) },
        { label: "Current end", value: formatLocaleDateTime(event.ends_at, locale) },
        ...fields,
        ...(kind === "delete"
          ? [
              { label: "Attendees", value: "Will be notified of the cancellation" },
              { label: "Restore", value: "This cannot be undone from Moss" }
            ]
          : [])
      ],
      version: createHash("sha256").update(JSON.stringify(event)).digest("hex")
    };
  };
}

export const calendarDeletePresentation = eventPresentation("delete");
export const calendarReschedulePresentation = eventPresentation("reschedule");
