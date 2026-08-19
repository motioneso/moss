import type { CalendarEvent } from "@moss/db";
import type { CalendarEventDto } from "@moss/shared";

const JFB_PATTERN = /^jfb[0-9a-v]{32}$/;

export function serializeCalendarEvent(event: CalendarEvent): CalendarEventDto {
  const md: Record<string, unknown> =
    event.external_metadata != null && typeof event.external_metadata === "object"
      ? (event.external_metadata as Record<string, unknown>)
      : {};

  // jarvisCreated (written at create time, calendar-write-impl.ts) is the sole authoritative
  // signal once present — the jfb-prefix regex is a fallback only for rows cached before this
  // field existed, and must never override an explicit false.
  const isMossBlock =
    md.jarvisCreated === true ||
    (md.jarvisCreated === undefined && JFB_PATTERN.test(event.external_id));
  const allDay = md.allDay === true;
  const attendeeCount =
    typeof md.attendeeCount === "number" && Number.isFinite(md.attendeeCount)
      ? md.attendeeCount
      : 0;
  const status = typeof md.status === "string" ? md.status : null;

  return {
    id: event.id,
    connectorAccountId: event.connector_account_id,
    ownerUserId: event.owner_user_id,
    title: event.title,
    startsAt: toIsoString(event.starts_at),
    endsAt: toIsoString(event.ends_at),
    location: event.location,
    summary: event.summary,
    bodyExcerpt: event.body_excerpt,
    externalId: event.external_id,
    isMossBlock,
    allDay,
    attendeeCount,
    status,
    createdAt: toIsoString(event.created_at),
    updatedAt: toIsoString(event.updated_at)
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
