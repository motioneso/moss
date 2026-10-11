import { beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";

const { mockListVisible } = vi.hoisted(() => ({ mockListVisible: vi.fn() }));

vi.mock("../../packages/calendar/src/repository.js", () => ({
  CalendarRepository: class {
    listVisible = mockListVisible;
  }
}));

import { calendarMonitorProvider } from "../../packages/calendar/src/monitor-provider.js";

// Fake DataContextDb satisfying the assertDataContextDb brand check.
const fakeScopedDb = {
  [dataContextBrand]: true as const,
  db: {}
} as unknown as DataContextDb;

const baseInput = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  sinceCursor: {},
  timeZone: "UTC",
  locale: { timezone: "UTC", region: "en-US", dateFormat: "24" as const },
  maxSignals: 10,
  priorityAnchors: [] as { label: string; aliases: readonly string[] }[]
};

beforeEach(() => {
  mockListVisible.mockReset();
});

describe("calendarMonitorProvider: sanitizeSnippet applied to event fields", () => {
  it("strips auth URL from event.title before writing to signal", async () => {
    const eventNow = new Date("2026-06-28T12:00:00.000Z");
    const soonStart = new Date(eventNow.getTime() + 60 * 60 * 1000).toISOString(); // 1 h out

    mockListVisible.mockResolvedValue([
      {
        id: "evt-1",
        external_id: "ext-1",
        title: "Review https://auth.example.com?token=supersecret123 invite",
        location: null,
        starts_at: soonStart,
        updated_at: null
      }
    ]);

    const { signals } = await calendarMonitorProvider.collectSignals(fakeScopedDb, {
      ...baseInput,
      now: eventNow.toISOString()
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.title).not.toContain("token=supersecret123");
    expect(signals[0]?.title).toContain("[link removed]");
  });

  it("strips credential line from event.location before writing to signal summary", async () => {
    const eventNow = new Date("2026-06-28T12:00:00.000Z");
    const soonStart = new Date(eventNow.getTime() + 30 * 60 * 1000).toISOString(); // 30 min out

    mockListVisible.mockResolvedValue([
      {
        id: "evt-2",
        external_id: "ext-2",
        title: "Team standup",
        location: "password: hunter2",
        starts_at: soonStart,
        updated_at: null
      }
    ]);

    const { signals } = await calendarMonitorProvider.collectSignals(fakeScopedDb, {
      ...baseInput,
      now: eventNow.toISOString()
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.summary).not.toContain("hunter2");
    expect(signals[0]?.summary).toContain("[redacted]");
  });

  it("strips bare bearer token from event.title (pre-pass, no [:=] required)", async () => {
    const eventNow = new Date("2026-06-28T12:00:00.000Z");
    const soonStart = new Date(eventNow.getTime() + 60 * 60 * 1000).toISOString();

    mockListVisible.mockResolvedValue([
      {
        id: "evt-3",
        external_id: "ext-3",
        title: "Meeting Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        location: null,
        starts_at: soonStart,
        updated_at: null
      }
    ]);

    const { signals } = await calendarMonitorProvider.collectSignals(fakeScopedDb, {
      ...baseInput,
      now: eventNow.toISOString()
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.title).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(signals[0]?.title).toContain("[redacted]");
  });
});
