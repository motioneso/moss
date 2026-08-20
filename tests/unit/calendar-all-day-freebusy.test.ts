// #1711, second pass. The all-day filter shipped in #1717 is correct on the intervals the unit
// tests hand it, and was unreachable in production: it identifies an all-day event by its
// endpoints landing on local midnight, while the caller asked freeBusy about a three-hour
// part-of-day band. Google clips busy intervals to the query bounds, so the event arrived as
// 09:00–12:00 with its midnights gone, survived the filter, covered the whole band, and produced
// "No clear slot in that window" — the symptom the issue was filed for.
//
// The existing tests could not catch that, because every one of them builds an unclipped
// midnight-to-midnight interval by hand. The fake below clips the way the API does, so it
// exercises the caller's real query window rather than a convenient shape. Narrow the query back
// to the band and these tests go red.
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { buildCalendarWriteService } from "@moss/chat";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

const TZ = "America/New_York";
/** Morning band on 2026-06-17: 09:00–12:00 EDT. */
const MORNING_BAND = {
  start: new Date("2026-06-17T13:00:00Z"),
  end: new Date("2026-06-17T16:00:00Z"),
  durationMinutes: 60,
  title: "Focus"
};
/** An all-day event on 2026-06-17 — local midnight to local midnight, which in EDT is 04:00Z. */
const ALL_DAY = { start: "2026-06-17T04:00:00Z", end: "2026-06-18T04:00:00Z" };

const ctx = {
  actorUserId: "00000000-0000-0000-0000-000000000001",
  requestId: "req",
  chatSessionId: "chat",
  localTimezone: TZ
};

/**
 * Builds the service with a freeBusy that behaves like Google's: it clips each busy interval to
 * the requested bounds. Records the bounds it was asked for so a test can assert them directly.
 */
function buildService(busy: ReadonlyArray<{ start: string; end: string }>) {
  const asked: { timeMin: string; timeMax: string }[] = [];
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
      freeBusy: async ({ timeMin, timeMax }: { timeMin: string; timeMax: string }) => {
        asked.push({ timeMin, timeMax });
        const lo = new Date(timeMin).getTime();
        const hi = new Date(timeMax).getTime();
        return {
          busy: busy
            .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
            .filter((b) => b.end > lo && b.start < hi)
            .map((b) => ({
              start: new Date(Math.max(b.start, lo)).toISOString(),
              end: new Date(Math.min(b.end, hi)).toISOString()
            }))
        };
      },
      insertEvent: async ({ eventId }: { eventId: string }) => ({ id: eventId })
    },
    calendarRepository: { upsertCachedEvent: async () => ({ id: "cached-1" }) }
  } as never);
  return { service, asked };
}

describe("focus block scheduling around all-day events", () => {
  it("asks freeBusy about whole local days, not the band it wants to schedule in", async () => {
    const { service, asked } = buildService([]);
    await service.createEvent(scopedDb, ctx, MORNING_BAND);
    // Local midnight either side of 2026-06-17 in EDT. The band (13:00–16:00Z) is strictly inside.
    expect(asked).toEqual([
      { timeMin: "2026-06-17T04:00:00.000Z", timeMax: "2026-06-18T04:00:00.000Z" }
    ]);
  });

  it("schedules inside the band even though an all-day event covers it", async () => {
    // The reported bug, end to end. Ask the band and the clipped interval blocks every candidate.
    const { service } = buildService([ALL_DAY]);
    const result = await service.createEvent(scopedDb, ctx, MORNING_BAND);
    expect(result.conflict).toBe("none");
    expect(result.created).toBe(true);
    expect(result.resolvedStart).toBe("2026-06-17T13:00:00.000Z");
  });

  it("still refuses when a real timed meeting fills the band", async () => {
    // The filter must not have become a way of ignoring genuine conflicts. This interval sits
    // inside the band, so widening the query changes nothing about it.
    const { service } = buildService([
      { start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }
    ]);
    const result = await service.createEvent(scopedDb, ctx, MORNING_BAND);
    expect(result.created).toBe(false);
    expect(result.conflict).toBe("no-clear-slot");
  });

  it("shifts around a timed meeting that the widened query newly reveals", async () => {
    // A meeting running from before the band into it. Under the band-width query it arrived
    // clipped to the band's start; either way it must still push the block later, and the
    // whole-day query must not mistake it for an all-day event.
    const { service } = buildService([
      { start: "2026-06-17T11:00:00Z", end: "2026-06-17T14:00:00Z" }
    ]);
    const result = await service.createEvent(scopedDb, ctx, MORNING_BAND);
    expect(result.created).toBe(true);
    expect(result.conflict).toBe("shifted");
    expect(result.resolvedStart).toBe("2026-06-17T14:00:00.000Z");
  });
});
