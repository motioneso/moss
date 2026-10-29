import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  capHeartbeatItems,
  heartbeatRevision,
  parseHeartbeatSourceReadInput,
  type HeartbeatEvidenceItem,
  type HeartbeatSourceRead
} from "@moss/shared";
import { sql } from "kysely";

import { CalendarRepository } from "./repository.js";

const repository = new CalendarRepository();

/** A calendar sync that touched the cache within this window counts as fresh. */
const FRESH_SYNC_MS = 3 * 60 * 60 * 1000;

/**
 * Input must stay inside the read contract. Extra keys (an owner or user id) are refused, and every
 * query below filters on the actor the data context was opened for.
 */
export async function authorizeCalendarHeartbeatRead(
  _scopedDb: DataContextDb,
  input: Record<string, unknown>
): Promise<boolean> {
  return parseHeartbeatSourceReadInput(input) !== null;
}

export const calendarHeartbeatWindowExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const parsed = parseHeartbeatSourceReadInput(input);
  if (!parsed) throw new Error("Invalid heartbeat read input");

  const now = new Date();
  const until = new Date(now.getTime() + parsed.horizonHours * 3_600_000);
  const events = await repository.listVisible(scopedDb, {
    endsAfter: now,
    startsBefore: until,
    ownedByActor: true,
    limit: parsed.limit + 1
  });
  const lastSync = await scopedDb.db
    .selectFrom("app.calendar_events")
    .select(sql<Date | null>`max(updated_at)`.as("last_synced_at"))
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();

  const { items: bounded, truncated } = capHeartbeatItems(events, parsed.limit);
  const items: HeartbeatEvidenceItem[] = bounded.map((event) => ({
    entityKey: `event:${event.id}`,
    episodeKey: `event:${event.id}:${event.starts_at.toISOString()}`,
    title: event.title,
    at: event.starts_at.toISOString(),
    kind: "event",
    facts: {
      endsAt: event.ends_at.toISOString(),
      location: event.location,
      inProgress: event.starts_at.getTime() <= now.getTime()
    }
  }));

  // updated_at moves on every sync, so the revision covers only fields a person would notice.
  const revision = heartbeatRevision(
    events.map((event) =>
      [
        event.id,
        event.title,
        event.starts_at.toISOString(),
        event.ends_at.toISOString(),
        event.location ?? ""
      ].join("|")
    )
  );
  const boundaries = bounded
    .map((event) => (event.starts_at.getTime() > now.getTime() ? event.starts_at : event.ends_at))
    .sort((a, b) => a.getTime() - b.getTime());
  const syncedAt = lastSync?.last_synced_at ? new Date(lastSync.last_synced_at) : null;

  const data: HeartbeatSourceRead = {
    source: "calendar",
    revision,
    nextBoundaryAt: boundaries[0]?.toISOString() ?? null,
    freshness: !syncedAt
      ? "unknown"
      : now.getTime() - syncedAt.getTime() <= FRESH_SYNC_MS
        ? "fresh"
        : "stale",
    truncated,
    items
  };
  return { data };
};
