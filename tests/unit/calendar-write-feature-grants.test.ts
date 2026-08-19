import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { buildCalendarWriteService } from "@moss/chat";
import { GoogleApiError } from "@moss/connectors";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

describe("calendar write feature grants", () => {
  it("blocks calendar writes before Google calls when calendar grant is off", async () => {
    let googleCalls = 0;
    let cacheCalls = 0;
    const service = buildCalendarWriteService({
      connectorsRepository: {
        getCalendarWriteScopeState: async () => ({
          accountId: "00000000-0000-0000-0000-00000000ca10",
          hasScope: true
        })
      },
      preferencesRepository: { get: async () => ({ email: true, calendar: false }) },
      googleService: {
        getFreshAccessToken: async () => {
          googleCalls += 1;
          return "token";
        }
      },
      googleApiClient: {
        freeBusy: async () => {
          googleCalls += 1;
          return { busy: [] };
        },
        insertEvent: async () => {
          googleCalls += 1;
          return { id: "evt" };
        }
      },
      calendarRepository: {
        upsertCachedEvent: async () => {
          cacheCalls += 1;
          return {} as never;
        }
      }
    } as never);

    const result = await service.createEvent(
      scopedDb,
      {
        actorUserId: "00000000-0000-0000-0000-000000000001",
        requestId: "req",
        chatSessionId: "chat"
      },
      {
        start: new Date("2026-06-17T13:00:00Z"),
        end: new Date("2026-06-17T16:00:00Z"),
        durationMinutes: 60,
        title: "Focus"
      }
    );

    expect(result.created).toBe(false);
    expect(result.message).toBe("Calendar access is disabled for this account in Settings.");
    expect(googleCalls).toBe(0);
    expect(cacheCalls).toBe(0);
  });

  it("rolls back provider insert when auto follow-through cannot mirror the cache row", async () => {
    let insertedEventId: string | null = null;
    let deletedEventId: string | null = null;
    const service = buildCalendarWriteService({
      connectorsRepository: {
        getCalendarWriteScopeState: async () => ({
          accountId: "00000000-0000-0000-0000-00000000ca10",
          hasScope: true
        }),
        getActiveGoogleAccountSecret: async () => ({ id: "google-account-1" })
      },
      preferencesRepository: { get: async () => ({ email: true, calendar: true }) },
      googleService: { getFreshAccessToken: async () => "token" },
      googleApiClient: {
        freeBusy: async () => ({ busy: [] }),
        insertEvent: async ({ eventId }: { eventId: string }) => {
          insertedEventId = eventId;
          return { id: eventId };
        },
        deleteEvent: async ({ eventId }: { eventId: string }) => {
          deletedEventId = eventId;
          return { deleted: "deleted" };
        }
      },
      calendarRepository: {
        upsertCachedEvent: async () => {
          const error = new Error("new row violates row-level security policy");
          (error as { code?: string }).code = "42501";
          throw error;
        }
      }
    } as never);

    const result = await service.createEvent(
      scopedDb,
      {
        actorUserId: "00000000-0000-0000-0000-000000000001",
        requestId: "req",
        chatSessionId: "chat"
      },
      {
        start: new Date("2026-06-17T13:00:00Z"),
        end: new Date("2026-06-17T16:00:00Z"),
        durationMinutes: 60,
        title: "Focus"
      },
      { requireCacheMirror: true, followThroughTargetRef: "calendar:prep:1" }
    );

    expect(result.created).toBe(false);
    expect(result.calendarMirror).toBe("skipped-rls");
    expect(result.googleEventId).toBeUndefined();
    expect(result.calendarEventId).toBeUndefined();
    expect(deletedEventId).toBe(insertedEventId);
  });

  it("preserves cached calendarEventId on idempotent 409 retries", async () => {
    const service = buildCalendarWriteService({
      connectorsRepository: {
        getCalendarWriteScopeState: async () => ({
          accountId: "00000000-0000-0000-0000-00000000ca10",
          hasScope: true
        }),
        getActiveGoogleAccountSecret: async () => ({ id: "google-account-1" })
      },
      preferencesRepository: { get: async () => ({ email: true, calendar: true }) },
      googleService: { getFreshAccessToken: async () => "token" },
      googleApiClient: {
        freeBusy: async () => ({ busy: [] }),
        insertEvent: async () => {
          throw new GoogleApiError("conflict", 409);
        }
      },
      calendarRepository: {
        getByExternalId: async () => ({ id: "cached-calendar-event-1" })
      }
    } as never);

    const result = await service.createEvent(
      scopedDb,
      {
        actorUserId: "00000000-0000-0000-0000-000000000001",
        requestId: "req",
        chatSessionId: "chat"
      },
      {
        start: new Date("2026-06-17T13:00:00Z"),
        end: new Date("2026-06-17T16:00:00Z"),
        durationMinutes: 60,
        title: "Focus"
      },
      { requireCacheMirror: true, followThroughTargetRef: "calendar:prep:1" }
    );

    expect(result.created).toBe(true);
    expect(result.calendarMirror).toBe("written");
    expect(result.calendarEventId).toBe("cached-calendar-event-1");
  });
});
