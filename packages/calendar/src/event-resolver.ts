import type { CalendarEvent, DataContextDb } from "@moss/db";

import type { CalendarRepository } from "./repository.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CalendarEventRef =
  | { readonly kind: "moss_id"; readonly id: string }
  | { readonly kind: "external_id"; readonly id: string };

export function parseCalendarEventRef(raw: string): CalendarEventRef {
  return UUID_RE.test(raw) ? { kind: "moss_id", id: raw } : { kind: "external_id", id: raw };
}

export type ResolveCalendarEventResult =
  | { readonly found: true; readonly event: CalendarEvent }
  | { readonly found: false; readonly reason: "not_found" | "invalid_input" };

export async function resolveCalendarEventRef(
  scopedDb: DataContextDb,
  repository: Pick<CalendarRepository, "getById" | "getByExternalId">,
  connectorAccountId: string | undefined,
  raw: unknown
): Promise<ResolveCalendarEventResult> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { found: false, reason: "invalid_input" };
  }

  const ref = parseCalendarEventRef(raw);

  try {
    if (ref.kind === "moss_id") {
      const event = await repository.getById(scopedDb, ref.id);
      return event ? { found: true, event } : { found: false, reason: "not_found" };
    }

    if (!connectorAccountId) {
      return { found: false, reason: "not_found" };
    }

    const event = await repository.getByExternalId(scopedDb, {
      connectorAccountId,
      externalId: ref.id
    });
    return event ? { found: true, event } : { found: false, reason: "not_found" };
  } catch {
    return { found: false, reason: "not_found" };
  }
}
