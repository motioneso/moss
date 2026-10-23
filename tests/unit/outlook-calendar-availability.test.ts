import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { outlookCalendarAvailabilityIssue, type ConnectorAccountSafeRow } from "@moss/connectors";
import type { OutlookCalendarHealth } from "../../packages/connectors/src/outlook-calendar-jobs.js";
import {
  buildCalendarWriteService,
  type CalendarWriteImplDeps
} from "../../packages/chat/src/calendar-write-impl.js";

const db = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const now = new Date("2026-10-21T18:00:00.000Z");
const start = new Date("2026-10-22T05:30:00.000Z");
const end = new Date("2026-10-22T06:00:00.000Z");
const account: ConnectorAccountSafeRow = {
  id: "outlook",
  provider_id: "outlook-browser-calendar",
  provider_type: "calendar",
  provider_display_name: "Outlook",
  provider_status: "available",
  owner_user_id: "owner",
  scopes: ["calendar.readonly"],
  status: "active",
  has_secret: true,
  revoked_at: null,
  created_at: now,
  updated_at: now,
  last_sync_started_at: null,
  last_sync_finished_at: null,
  last_sync_status: null,
  last_sync_error: null,
  last_sync_counts: null
};
const fresh: OutlookCalendarHealth = {
  state: "current",
  lastCompleteAt: now.toISOString(),
  timeZone: "America/Los_Angeles",
  windowStart: "2026-10-21",
  windowEnd: "2026-10-22",
  unconfirmed: 0
};
function fixtures(health: OutlookCalendarHealth, source = account) {
  return {
    repository: { listAccounts: async () => [source] },
    preferences: {
      get: async (_db: DataContextDb, key: string) =>
        key.endsWith("outlook_calendar_health") ? health : { calendar: true }
    }
  };
}

afterEach(() => vi.useRealTimers());

describe("Outlook availability precondition", () => {
  it("uses source-zone midnight, not UTC or host midnight, for coverage", async () => {
    expect(await outlookCalendarAvailabilityIssue(db, start, end, fixtures(fresh), now)).toBeNull();
    expect(
      await outlookCalendarAvailabilityIssue(
        db,
        new Date("2026-10-22T06:30:00Z"),
        new Date("2026-10-22T07:30:00Z"),
        fixtures(fresh),
        now
      )
    ).toContain("verification");
  });
  it.each([
    "partial",
    "stale",
    "collecting",
    "sign-in-needed",
    "source-changed",
    "disconnected"
  ] as const)("refuses source state %s", async (state) => {
    expect(
      await outlookCalendarAvailabilityIssue(db, start, end, fixtures({ ...fresh, state }), now)
    ).toContain("verification");
  });
  it.each([
    { ...fresh, lastCompleteAt: "2026-10-21T17:44:59.000Z" },
    { ...fresh, unconfirmed: 1 },
    { ...fresh, timeZone: undefined },
    { ...fresh, timeZone: "Unknown/Zone" },
    { ...fresh, windowStart: "2026-10-22" }
  ])("refuses expired, uncertain or uncovered source %j", async (health) => {
    expect(await outlookCalendarAvailabilityIssue(db, start, end, fixtures(health), now)).toContain(
      "verification"
    );
  });
  it("retains the availability warning after disconnect", async () => {
    expect(
      await outlookCalendarAvailabilityIssue(
        db,
        start,
        end,
        fixtures(fresh, { ...account, status: "revoked" }),
        now
      )
    ).toContain("verification");
  });
  it("does not block owners without an Outlook source", async () => {
    expect(
      await outlookCalendarAvailabilityIssue(
        db,
        start,
        end,
        {
          repository: { listAccounts: async () => [] }
        },
        now
      )
    ).toBeNull();
  });
});

describe.each([false, true])("availability-dependent creation (staged=%s)", (staged) => {
  function service(health: OutlookCalendarHealth) {
    const source = fixtures(health);
    const provider = vi.fn(async () => ({ id: "created" }));
    const token = vi.fn(async () => "token");
    const deps = {
      connectorsRepository: {
        ...source.repository,
        getCalendarWriteScopeState: async () => ({ hasScope: true, accountId: "google" }),
        getActiveGoogleAccountSecret: async () => ({ id: "google" })
      },
      preferencesRepository: source.preferences,
      googleService: {
        getFreshAccessToken: token,
        readActiveCredential: async () => ({
          accountId: "google",
          bundle: {
            clientId: "invented",
            clientSecret: "invented",
            refreshToken: "invented",
            grantedScopes: [],
            accessToken: "token",
            tokenExpiry: "2026-10-22T00:00:00Z"
          }
        })
      },
      googleApiClient: { freeBusy: vi.fn(async () => ({ busy: [] })), insertEvent: provider },
      calendarRepository: {
        listVisible: async () => [],
        upsertCachedEvent: async () => ({ id: "cached" })
      },
      dataContext: {
        withDataContext: async (
          _access: unknown,
          fn: (scoped: DataContextDb) => Promise<unknown>
        ) => fn(db)
      }
    } as unknown as CalendarWriteImplDeps;
    return { writer: buildCalendarWriteService(deps), deps, provider, token };
  }
  it.each([
    { ...fresh, state: "partial" as const },
    { ...fresh, lastCompleteAt: "2026-10-21T17:40:00.000Z" },
    { ...fresh, windowStart: "2026-10-22" }
  ])("does no provider I/O when availability is unknown %j", async (health) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { writer, provider, token, deps } = service(health);
    const result = await writer.createEvent(
      staged ? undefined : db,
      { actorUserId: "owner", requestId: "request", chatSessionId: "chat" },
      { start, end, durationMinutes: 30, title: "Invented block" },
      staged
        ? {
            provenance: {
              actorUserId: "owner",
              planId: "invented",
              blockId: "invented",
              planRevision: 1,
              operationId: "invented"
            }
          }
        : {}
    );
    expect(result.created).toBe(false);
    expect(result.message).toContain("availability needs verification");
    expect(provider).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(deps.googleApiClient.freeBusy).not.toHaveBeenCalled();
  });
  it("creates within fresh complete coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { writer, provider } = service(fresh);
    const result = await writer.createEvent(
      staged ? undefined : db,
      { actorUserId: "owner", requestId: "request", chatSessionId: "chat" },
      { start, end, durationMinutes: 30, title: "Invented block" },
      staged
        ? {
            provenance: {
              actorUserId: "owner",
              planId: "invented",
              blockId: "invented",
              planRevision: 1,
              operationId: "invented"
            }
          }
        : {}
    );
    expect(result.created).toBe(true);
    expect(provider).toHaveBeenCalledOnce();
  });
});
