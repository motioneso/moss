import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type CalendarEvent, type DataContextDb } from "@moss/db";
import type { ConnectorAccountSafeRow } from "../../packages/connectors/src/repository.js";
import type { GoogleCalendarEvent } from "../../packages/connectors/src/google-api-client.js";
import {
  classifyCalendarFlags,
  listCalendarContext,
  type CalendarSourceContextDeps
} from "../../packages/connectors/src/source-context/calendar.js";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const NOW = new Date("2026-07-03T12:00:00.000Z");
// America/New_York on 2026-07-03 is UTC-4 (EDT): 12:00Z = 08:00 local.
const TZ = "America/New_York";

function account(overrides: Partial<ConnectorAccountSafeRow> = {}): ConnectorAccountSafeRow {
  return {
    id: "acc-google",
    provider_id: "google",
    provider_type: "google",
    provider_display_name: "Google",
    provider_status: "active",
    owner_user_id: "user-1",
    scopes: [CALENDAR_SCOPE],
    status: "active",
    has_secret: true,
    revoked_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_sync_counts: null,
    ...overrides
  } as ConnectorAccountSafeRow;
}

function googleEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: "evt-1",
    summary: "Team sync",
    start: { dateTime: "2026-07-03T15:00:00.000Z" },
    end: { dateTime: "2026-07-03T15:30:00.000Z" },
    ...overrides
  };
}

function cachedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "cal-row-1",
    connector_account_id: "acc-google",
    owner_user_id: "user-1",
    title: "Cached meeting",
    starts_at: new Date("2026-07-03T16:00:00.000Z"),
    ends_at: new Date("2026-07-03T17:00:00.000Z"),
    location: null,
    summary: null,
    body_excerpt: null,
    external_id: "evt-cached-1",
    external_metadata: {},
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides
  } as CalendarEvent;
}

function makeDeps(overrides: Partial<CalendarSourceContextDeps> = {}): CalendarSourceContextDeps {
  return {
    connectorsRepository: { listAccounts: async () => [account()] },
    preferencesRepository: { get: async () => null },
    resolveGoogleCredential: async () => "token-1",
    googleClient: { listCalendarEvents: async () => [googleEvent()] },
    calendarRepository: { listVisible: async () => [cachedEvent()] },
    now: () => NOW,
    timeZone: TZ,
    ...overrides
  };
}

describe("classifyCalendarFlags", () => {
  const base = {
    startsAt: "2026-07-03T15:00:00.000Z", // 11:00 local
    endsAt: "2026-07-03T15:30:00.000Z",
    allDay: false,
    location: null,
    attendeeCount: 0
  };

  it("flags early starts (before 09:00 local)", () => {
    const flags = classifyCalendarFlags(
      [{ ...base, startsAt: "2026-07-03T12:00:00.000Z", endsAt: "2026-07-03T12:30:00.000Z" }],
      TZ
    ); // 08:00 local
    expect(flags[0]).toContain("early");
  });

  it("flags late starts (after 18:00 local)", () => {
    const flags = classifyCalendarFlags(
      [{ ...base, startsAt: "2026-07-03T23:30:00.000Z", endsAt: "2026-07-04T00:00:00.000Z" }],
      TZ
    ); // 19:30 local
    expect(flags[0]).toContain("late");
  });

  it("flags location and prep_attendees", () => {
    const flags = classifyCalendarFlags([{ ...base, location: "Room 4", attendeeCount: 3 }], TZ);
    expect(flags[0]).toContain("has_location");
    expect(flags[0]).toContain("prep_attendees");
  });

  it("flags overlapping non-all-day events as conflicts", () => {
    const flags = classifyCalendarFlags(
      [
        { ...base, startsAt: "2026-07-03T15:00:00.000Z", endsAt: "2026-07-03T16:00:00.000Z" },
        { ...base, startsAt: "2026-07-03T15:30:00.000Z", endsAt: "2026-07-03T16:30:00.000Z" },
        { ...base, startsAt: "2026-07-03T17:00:00.000Z", endsAt: "2026-07-03T18:00:00.000Z" }
      ],
      TZ
    );
    expect(flags[0]).toContain("conflict");
    expect(flags[1]).toContain("conflict");
    expect(flags[2]).not.toContain("conflict");
  });

  it("does not flag all-day events as conflicts", () => {
    const flags = classifyCalendarFlags(
      [
        {
          ...base,
          allDay: true,
          startsAt: "2026-07-03T00:00:00.000Z",
          endsAt: "2026-07-04T00:00:00.000Z"
        },
        { ...base, startsAt: "2026-07-03T15:00:00.000Z", endsAt: "2026-07-03T16:00:00.000Z" }
      ],
      TZ
    );
    expect(flags[0]).not.toContain("conflict");
    expect(flags[1]).not.toContain("conflict");
  });
});

describe("listCalendarContext", () => {
  it("returns live in-window events, excluding past ones", async () => {
    const deps = makeDeps({
      googleClient: {
        listCalendarEvents: async () => [
          googleEvent(),
          googleEvent({
            id: "evt-past",
            start: { dateTime: "2026-07-03T09:00:00.000Z" },
            end: { dateTime: "2026-07-03T10:00:00.000Z" }
          })
        ]
      }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.items.map((item) => item.eventKey)).toEqual(["evt-1"]);
    expect(result.items[0]).toMatchObject({
      source: "live",
      degradedReason: null,
      title: "Team sync",
      allDay: false
    });
    expect(result.accounts).toEqual([
      {
        account: {
          connectorAccountId: "acc-google",
          providerId: "google",
          providerLabel: "Google"
        },
        source: "live",
        degradedReason: null,
        asOf: NOW.toISOString()
      }
    ]);
    expect(result.gaps).toEqual([]);
  });

  it("excludes routine window-spanning all-day events without location or attendees", async () => {
    const deps = makeDeps({
      googleClient: {
        listCalendarEvents: async () => [
          googleEvent({
            id: "evt-allday",
            start: { date: "2026-07-01" },
            end: { date: "2026-07-08" }
          }),
          googleEvent({
            id: "evt-allday-located",
            location: "Conference center",
            start: { date: "2026-07-01" },
            end: { date: "2026-07-08" }
          })
        ]
      }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.items.map((item) => item.eventKey)).toEqual(["evt-allday-located"]);
  });

  it("falls back to cache on a transient failure", async () => {
    const deps = makeDeps({
      googleClient: {
        listCalendarEvents: async () => {
          throw new Error("read ECONNRESET");
        }
      }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      eventKey: "evt-cached-1",
      source: "cache",
      degradedReason: "network_error",
      title: "Cached meeting"
    });
    expect(result.accounts[0]).toMatchObject({ source: "cache", degradedReason: "network_error" });
  });

  it("surfaces an auth gap with no cache items after a failed forced retry", async () => {
    const listCalendarEvents = vi.fn(async () => {
      const error = new Error("unauthorized") as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    });
    const resolveGoogleCredential = vi.fn(async () => "token");
    const deps = makeDeps({
      googleClient: { listCalendarEvents },
      resolveGoogleCredential
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      {
        account: expect.objectContaining({ connectorAccountId: "acc-google" }),
        reason: "auth_error"
      }
    ]);
    expect(listCalendarEvents).toHaveBeenCalledTimes(2);
    expect(resolveGoogleCredential).toHaveBeenCalledWith(scopedDb, { force: true });
  });

  it("reports feature_grant_disabled without attempting a read", async () => {
    const listCalendarEvents = vi.fn(async () => [googleEvent()]);
    const deps = makeDeps({
      googleClient: { listCalendarEvents },
      preferencesRepository: { get: async () => ({ email: true, calendar: false }) }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.items).toEqual([]);
    expect(result.gaps).toEqual([
      {
        account: expect.objectContaining({ connectorAccountId: "acc-google" }),
        reason: "feature_grant_disabled"
      }
    ]);
    expect(listCalendarEvents).not.toHaveBeenCalled();
  });

  it("reports the least-fresh contributing account's time when accounts differ", async () => {
    const listCalendarEvents = vi
      .fn()
      .mockResolvedValueOnce([googleEvent()])
      .mockRejectedValueOnce(new Error("read ECONNRESET"));
    const deps = makeDeps({
      connectorsRepository: {
        listAccounts: async () => [
          account({ id: "acc-fresh" }),
          account({
            id: "acc-stale",
            last_sync_finished_at: new Date("2026-07-02T00:00:00.000Z")
          })
        ]
      },
      googleClient: { listCalendarEvents }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.accounts).toEqual([
      expect.objectContaining({ source: "live", asOf: NOW.toISOString() }),
      expect.objectContaining({ source: "cache", asOf: "2026-07-02T00:00:00.000Z" })
    ]);
    expect(result.asOf).toBe("2026-07-02T00:00:00.000Z");
  });

  it("reports asOf as null when any contributing account's freshness is unknown", async () => {
    const listCalendarEvents = vi
      .fn()
      .mockResolvedValueOnce([googleEvent()])
      .mockRejectedValueOnce(new Error("read ECONNRESET"));
    const deps = makeDeps({
      connectorsRepository: {
        listAccounts: async () => [
          account({ id: "acc-fresh" }),
          account({ id: "acc-unknown", last_sync_finished_at: null })
        ]
      },
      googleClient: { listCalendarEvents }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result.accounts).toEqual([
      expect.objectContaining({ source: "live", asOf: NOW.toISOString() }),
      expect.objectContaining({ source: "cache", asOf: null })
    ]);
    expect(result.asOf).toBeNull();
  });

  it("skips non-calendar-capable accounts silently", async () => {
    const deps = makeDeps({
      connectorsRepository: {
        listAccounts: async () => [
          account({ id: "acc-imap", provider_type: "imap", scopes: ["email.read"] })
        ]
      }
    });
    const result = await listCalendarContext(scopedDb, deps, {});
    expect(result).toEqual({ items: [], accounts: [], gaps: [], truncated: false, asOf: null });
  });
});
