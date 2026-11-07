import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type CalendarEvent, type DataContextDb } from "@moss/db";

import { localDayRange } from "@moss/module-sdk";

import { isCalendarFollowThroughEvent } from "./follow-through.js";

export interface CreateCachedCalendarEventInput {
  readonly id?: string;
  readonly connectorAccountId: string;
  readonly title: string;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string;
  readonly location?: string | null;
  readonly summary?: string | null;
  readonly bodyExcerpt?: string | null;
  readonly externalId: string;
  readonly externalMetadata?: Record<string, unknown>;
}

export interface ListVisibleCalendarEventsOptions {
  readonly startsAfter?: Date;
  readonly startsBefore?: Date;
  /** Events still running at this instant or later — use instead of startsAfter to catch events that started earlier but overlap it. */
  readonly endsAfter?: Date;
  /** Only the actor's own events. The row policy also lets through events shared with them. */
  readonly ownedByActor?: boolean;
  readonly limit?: number;
}

/** One owned event near a time window, with attendee display names only (never emails). */
export interface CalendarEventContext {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly attendeeNames: readonly string[];
}

export interface CalendarEventWindow {
  readonly start: Date;
  readonly end: Date;
  readonly toleranceMinutes: number;
}

const MAX_OVERLAPPING_EVENTS = 3;
const MAX_CONTEXT_ATTENDEES = 20;
const MAX_CONTEXT_NAME_LENGTH = 80;

function attendeeNamesFromMetadata(metadata: unknown): string[] {
  const raw = (metadata as { attendeeNames?: unknown } | null)?.attendeeNames;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is string => typeof n === "string" && n.trim() !== "" && !n.includes("@"))
    .map((n) => n.trim().slice(0, MAX_CONTEXT_NAME_LENGTH))
    .slice(0, MAX_CONTEXT_ATTENDEES);
}

export class CalendarRepository {
  /**
   * The actor's own events that overlap the window, widened by the tolerance on both
   * sides. Most overlap first, at most three rows.
   */
  async listEventsOverlapping(
    scopedDb: DataContextDb,
    window: CalendarEventWindow
  ): Promise<readonly CalendarEventContext[]> {
    assertDataContextDb(scopedDb);
    const tolMs = Math.max(0, window.toleranceMinutes) * 60_000;
    const widenedStart = new Date(window.start.getTime() - tolMs);
    const widenedEnd = new Date(window.end.getTime() + tolMs);

    const rows = await scopedDb.db
      .selectFrom("app.calendar_events")
      .select(["id", "title", "starts_at", "ends_at", "external_metadata"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where("ends_at", ">", widenedStart)
      .where("starts_at", "<", widenedEnd)
      .orderBy(
        sql`extract(epoch from (least(ends_at, ${window.end}::timestamptz) - greatest(starts_at, ${window.start}::timestamptz)))`,
        "desc"
      )
      .orderBy("id")
      .limit(MAX_OVERLAPPING_EVENTS)
      .execute();

    return rows.map((row) => ({
      eventId: row.id,
      title: row.title,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      attendeeNames: attendeeNamesFromMetadata(row.external_metadata)
    }));
  }

  async listMirrorWindow(
    scopedDb: DataContextDb,
    accountId: string,
    start: string,
    end: string,
    timeZone: string
  ): Promise<CalendarEvent[]> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .where("connector_account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where(sql`external_metadata->>'source'`, "=", "outlook-browser-calendar")
      .where((eb) =>
        eb.or([
          eb.and([
            eb(sql`external_metadata->>'allDay'`, "=", "true"),
            eb("ends_at", ">", new Date(`${start}T00:00:00Z`)),
            eb("starts_at", "<", new Date(`${end}T00:00:00Z`))
          ]),
          eb.and([
            eb(sql`external_metadata->>'allDay'`, "=", "false"),
            eb("ends_at", ">", localDayRange(start, timeZone).start),
            eb("starts_at", "<", localDayRange(end, timeZone).start)
          ])
        ])
      )
      .execute();
  }

  async updateMirrorMetadata(
    scopedDb: DataContextDb,
    accountId: string,
    eventId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .updateTable("app.calendar_events")
      .set({ external_metadata: sql`external_metadata || ${JSON.stringify(patch)}::jsonb` })
      .where("id", "=", eventId)
      .where("connector_account_id", "=", accountId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .where(sql`external_metadata->>'source'`, "=", "outlook-browser-calendar")
      .execute();
  }

  async listVisible(
    scopedDb: DataContextDb,
    opts?: ListVisibleCalendarEventsOptions
  ): Promise<CalendarEvent[]> {
    assertDataContextDb(scopedDb);

    let query = scopedDb.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .$if(opts?.startsAfter != null, (qb) => qb.where("starts_at", ">=", opts!.startsAfter!))
      .$if(opts?.startsBefore != null, (qb) => qb.where("starts_at", "<", opts!.startsBefore!))
      .$if(opts?.endsAfter != null, (qb) => qb.where("ends_at", ">", opts!.endsAfter!))
      .$if(opts?.ownedByActor === true, (qb) =>
        qb.where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      )
      .orderBy("starts_at", "asc")
      .orderBy("id");

    if (opts?.limit != null) {
      query = query.limit(opts.limit);
    }

    return query.execute();
  }

  async getById(scopedDb: DataContextDb, eventId: string): Promise<CalendarEvent | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .where("id", "=", eventId)
      .executeTakeFirst();
  }

  async getByExternalId(
    scopedDb: DataContextDb,
    input: { readonly connectorAccountId: string; readonly externalId: string }
  ): Promise<CalendarEvent | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .where("connector_account_id", "=", input.connectorAccountId)
      .where("external_id", "=", input.externalId)
      .executeTakeFirst();
  }

  // Legacy automatic events for one follow-through target (R2.3-T06B). Matches
  // on the stored metadata reference only, never on title or time; every row
  // is confirmed with the same recogniser the writer path uses.
  async listFollowThroughEvents(
    scopedDb: DataContextDb,
    input: { readonly targetRef: string }
  ): Promise<CalendarEvent[]> {
    assertDataContextDb(scopedDb);

    const rows = await scopedDb.db
      .selectFrom("app.calendar_events")
      .selectAll()
      .where(sql`external_metadata->>'followThroughTargetRef'`, "=", input.targetRef)
      .orderBy("id")
      .execute();
    return rows.filter((row) => isCalendarFollowThroughEvent(row, input.targetRef));
  }

  async upsertCachedEvent(
    scopedDb: DataContextDb,
    input: CreateCachedCalendarEventInput
  ): Promise<CalendarEvent> {
    assertDataContextDb(scopedDb);

    const now = new Date();
    const externalMetadata = input.externalMetadata ?? {};

    return scopedDb.db
      .insertInto("app.calendar_events")
      .values({
        id: input.id ?? randomUUID(),
        connector_account_id: input.connectorAccountId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        title: input.title,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        location: input.location ?? null,
        summary: input.summary ?? null,
        body_excerpt: input.bodyExcerpt ?? null,
        external_id: input.externalId,
        external_metadata: externalMetadata,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["connector_account_id", "external_id"]).doUpdateSet({
          title: input.title,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          location: input.location ?? null,
          summary: input.summary ?? null,
          body_excerpt: input.bodyExcerpt ?? null,
          external_metadata: sql`app.calendar_events.external_metadata || ${JSON.stringify(
            externalMetadata
          )}::jsonb`,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async deleteStaleCachedEvents(
    scopedDb: DataContextDb,
    input: { readonly connectorAccountId: string; readonly keepExternalIds: readonly string[] }
  ): Promise<number> {
    assertDataContextDb(scopedDb);

    const query = scopedDb.db
      .deleteFrom("app.calendar_events")
      .where("connector_account_id", "=", input.connectorAccountId)
      .$if(input.keepExternalIds.length > 0, (qb) =>
        qb.where("external_id", "not in", input.keepExternalIds)
      );

    const result = await query.executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async deleteCachedEventsNotSeenSince(
    scopedDb: DataContextDb,
    input: { readonly connectorAccountId: string; readonly seenSince: Date }
  ): Promise<number> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.calendar_events")
      .where("connector_account_id", "=", input.connectorAccountId)
      .where("updated_at", "<", input.seenSince)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async deleteById(scopedDb: DataContextDb, eventId: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db.deleteFrom("app.calendar_events").where("id", "=", eventId).execute();
  }
}
