import { describe, expect, it } from "vitest";
import {
  CalendarRepository,
  PreferencesRepository,
  featureGrantsPrefKey,
  handles,
  ids,
  isCalendarFollowThroughEvent,
  runGoogleSync,
  runGoogleSyncChunk,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

function calendarEvent(id: string) {
  return {
    id,
    summary: id,
    start: { dateTime: "2026-08-01T13:00:00.000Z" },
    end: { dateTime: "2026-08-01T13:30:00.000Z" }
  };
}

describe("runGoogleSync calendar orchestration", () => {
  it("stores attendee display names, not emails, in synced event metadata (4020)", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test-attendee-names" };
    const attendees = [
      { email: "me@x.test", displayName: "Me Owner", self: true },
      { email: "ann@x.test", displayName: "Ann Lee" },
      { email: "silent@x.test" },
      ...Array.from({ length: 25 }, (_, i) => ({
        email: `p${i}@x.test`,
        displayName: `Guest ${i}`
      }))
    ];
    await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSync(db, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [{ ...calendarEvent("with-attendees"), attendees }],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: { runChat: async () => ({ text: "" }) },
        now: () => new Date("2026-08-01T12:00:00.000Z")
      })
    );
    const rows = await handles.dataContext.withDataContext(ctx, (db) =>
      new CalendarRepository().listVisible(db, { ownedByActor: true })
    );
    const row = rows.find((r) => r.title === "with-attendees")!;
    const meta = row.external_metadata as { attendeeNames: string[]; attendeeCount: number };
    expect(meta.attendeeCount).toBe(28);
    expect(meta.attendeeNames).toHaveLength(20);
    expect(meta.attendeeNames[0]).toBe("Ann Lee");
    expect(meta.attendeeNames).not.toContain("Me Owner");
    expect(JSON.stringify(meta.attendeeNames)).not.toContain("@");
  });

  it("continues every calendar page before stale reconciliation", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test-calendar-continuation" };
    const pageCalls: Array<{ pageToken?: string; maxResults?: number }> = [];
    const deps = {
      getFreshAccessToken: async () => "tok",
      getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
      googleClient: {
        listCalendarEvents: async () => [],
        listCalendarEventsPage: async (input: { pageToken?: string; maxResults?: number }) => {
          pageCalls.push(input);
          return input.pageToken === "CALENDAR_PAGE_2"
            ? { items: [calendarEvent("continued-calendar-2")] }
            : {
                items: [calendarEvent("continued-calendar-1")],
                nextPageToken: "CALENDAR_PAGE_2"
              };
        },
        listMessageIds: async () => [],
        getMessage: async () => ({ id: "x" })
      },
      emailExtractDeps: { runChat: async () => ({ text: "" }) },
      now: () => new Date("2026-08-01T12:00:00.000Z")
    };

    const first = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, deps)
    );
    expect(first.continuation).toMatchObject({
      phase: "calendar",
      cursor: "CALENDAR_PAGE_2"
    });
    const second = await handles.workerDataContext.withDataContext(ctx, (db) =>
      runGoogleSyncChunk(db, deps, first.continuation)
    );

    expect(second.continuation).toBeUndefined();
    expect(second.result.calendarUpserted).toBe(2);
    expect(pageCalls).toEqual([
      expect.objectContaining({ pageToken: undefined, maxResults: 100 }),
      expect.objectContaining({ pageToken: "CALENDAR_PAGE_2", maxResults: 100 })
    ]);
  });

  it("skips calendar sync when the account calendar grant is off", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.dataContext.withDataContext(ctx, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(accountId), {
        email: true,
        calendar: false
      })
    );

    let calendarCalls = 0;
    let emailCalls = 0;
    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar", "gmail"] }),
        googleClient: {
          listCalendarEvents: async () => {
            calendarCalls += 1;
            return [];
          },
          listMessageIds: async () => {
            emailCalls += 1;
            return [];
          },
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({
            text: JSON.stringify({ summary: "Processed", confidence: 0.5 })
          })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    await handles.dataContext.withDataContext(ctx, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(accountId), {
        email: true,
        calendar: true
      })
    );

    expect(calendarCalls).toBe(0);
    expect(emailCalls).toBe(2);
    expect(result.calendarUpserted).toBe(0);
    expect(result.emailUpserted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("syncs calendar + email and returns metadata-only counts", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar", "gmail"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              id: "g1",
              summary: "Standup",
              start: { dateTime: "2026-06-13T09:00:00Z" },
              end: { dateTime: "2026-06-13T09:15:00Z" }
            }
          ],
          listMessageIds: async ({ query }) =>
            query?.includes("older_than:1d") ? [] : [{ id: "m1" }],
          getMessage: async () => ({
            id: "m1",
            payload: {
              headers: [
                { name: "Subject", value: "S" },
                { name: "From", value: "a@b.com" }
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("hi").toString("base64") }
            }
          })
        },
        emailExtractDeps: {
          runChat: async () => ({
            text: JSON.stringify({ summary: "Processed", confidence: 0.5 })
          })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    expect(result.calendarUpserted).toBe(1);
    expect(result.emailUpserted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result)).not.toContain("accessToken");
  });

  it("skips all-day / missing-time events instead of fabricating 1970-epoch instants", async () => {
    // MED: an all-day event (date, no time) must NOT map to UTC midnight via a 1970 epoch, and an
    // event missing start/end must be SKIPPED rather than producing end < start (CHECK landmine).
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              // All-day event: Google sends `date` (exclusive end). Must produce a valid range.
              id: "allday-1",
              summary: "All-day offsite",
              start: { date: "2026-06-20" },
              end: { date: "2026-06-21" }
            },
            {
              // Missing end entirely → skipped, NOT fabricated as a 1970-epoch end.
              id: "no-end-1",
              summary: "Broken event",
              start: { dateTime: "2026-06-20T09:00:00Z" }
            }
          ],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );
    // Only the all-day event is upserted; the malformed one is skipped (no error, no fabrication).
    expect(result.calendarUpserted).toBe(1);
    expect(result.errors).toEqual([]);
    const row = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.calendar_events")
        .selectAll()
        .where("external_id", "=", "allday-1")
        .executeTakeFirstOrThrow()
    );
    // The all-day range is valid (end > start) and NOT the 1970 epoch.
    const starts = new Date((row as { starts_at: Date | string }).starts_at).getTime();
    const ends = new Date((row as { ends_at: Date | string }).ends_at).getTime();
    expect(ends).toBeGreaterThan(starts);
    expect(starts).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    expect((row as { external_metadata: { allDay?: boolean } }).external_metadata.allDay).toBe(
      true
    );
    // The malformed missing-end event was never persisted.
    const broken = await handles.dataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.calendar_events")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("external_id", "=", "no-end-1")
        .executeTakeFirstOrThrow()
    );
    expect(Number(broken.n)).toBe(0);
  });

  it("deletes stale and cancelled cached calendar events after a calendar sync", async () => {
    const accountId = await seedGoogleAccount(
      handles.dataContext,
      ["https://www.googleapis.com/auth/calendar"],
      ids.adminUser
    );
    const calendar = new CalendarRepository();
    const ctx = { actorUserId: ids.adminUser, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, async (db) => {
      await calendar.upsertCachedEvent(db, {
        connectorAccountId: accountId,
        externalId: "fresh-event",
        title: "Old fresh",
        startsAt: "2026-06-13T09:00:00.000Z",
        endsAt: "2026-06-13T09:30:00.000Z"
      });
      await calendar.upsertCachedEvent(db, {
        connectorAccountId: accountId,
        externalId: "cancelled-event",
        title: "Cancelled old",
        startsAt: "2026-06-13T10:00:00.000Z",
        endsAt: "2026-06-13T10:30:00.000Z"
      });
      await calendar.upsertCachedEvent(db, {
        connectorAccountId: accountId,
        externalId: "deleted-event",
        title: "Deleted old",
        startsAt: "2026-06-13T11:00:00.000Z",
        endsAt: "2026-06-13T11:30:00.000Z"
      });
    });

    const result = await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              id: "fresh-event",
              summary: "Fresh",
              start: { dateTime: "2026-06-14T09:00:00Z" },
              end: { dateTime: "2026-06-14T09:30:00Z" }
            },
            {
              id: "cancelled-event",
              status: "cancelled",
              start: { dateTime: "2026-06-14T10:00:00Z" },
              end: { dateTime: "2026-06-14T10:30:00Z" }
            }
          ],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    expect(result.calendarUpserted).toBe(1);
    expect(result.calendarReconciled).toBe(2);

    const rows = await handles.workerDataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.calendar_events")
        .select("external_id")
        .where("connector_account_id", "=", accountId)
        .orderBy("external_id")
        .execute()
    );
    expect(rows.map((row) => row.external_id)).toEqual(["fresh-event"]);
  });

  it("preserves Calendar follow-through provenance across sync before not_useful removal", async () => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    const calendar = new CalendarRepository();
    const ctx = { actorUserId: ids.userA, requestId: "pgboss:test" };
    await handles.workerDataContext.withDataContext(ctx, (db) =>
      calendar.upsertCachedEvent(db, {
        connectorAccountId: accountId,
        externalId: "auto-block-1",
        title: "Prep time",
        startsAt: "2026-06-13T09:00:00.000Z",
        endsAt: "2026-06-13T10:00:00.000Z",
        externalMetadata: { jarvisCreated: true, followThroughTargetRef: "calendar:prep:abc" }
      })
    );

    await handles.workerDataContext.withDataContext(ctx, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "tok",
        getActiveAccount: async () => ({ id: accountId, scopes: ["calendar"] }),
        googleClient: {
          listCalendarEvents: async () => [
            {
              id: "auto-block-1",
              summary: "Prep time",
              htmlLink: "https://calendar.example/auto-block-1",
              status: "confirmed",
              attendees: [{ email: "a@example.com" }],
              start: { dateTime: "2026-06-13T09:00:00Z" },
              end: { dateTime: "2026-06-13T10:00:00Z" }
            }
          ],
          listMessageIds: async () => [],
          getMessage: async () => ({ id: "x" })
        },
        emailExtractDeps: {
          runChat: async () => ({ text: "" })
        },
        now: () => new Date("2026-06-13T12:00:00.000Z")
      })
    );

    const row = await handles.workerDataContext.withDataContext(ctx, (db) =>
      db.db
        .selectFrom("app.calendar_events")
        .selectAll()
        .where("connector_account_id", "=", accountId)
        .where("external_id", "=", "auto-block-1")
        .executeTakeFirstOrThrow()
    );

    expect(row.external_metadata).toMatchObject({
      jarvisCreated: true,
      followThroughTargetRef: "calendar:prep:abc",
      status: "confirmed",
      attendeeCount: 1
    });
    expect(isCalendarFollowThroughEvent(row, "calendar:prep:abc")).toBe(true);
  });
});
