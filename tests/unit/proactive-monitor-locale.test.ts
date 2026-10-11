process.env.TZ = "UTC";

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ProactiveMonitorInput } from "@moss/module-sdk";

// Proactive cards show times in the owner's zone and 12/24-hour choice, never the server's (#3395).
// The machine runs in UTC here; the owner is in Pacific with 24-hour time, and the instant falls
// on Oct 10 in UTC but Oct 9 in Pacific, so a server-zone or UTC-day bug shows.

const { mockListVisible, mockGetOverdue, mockGetAtRisk } = vi.hoisted(() => ({
  mockListVisible: vi.fn(),
  mockGetOverdue: vi.fn(),
  mockGetAtRisk: vi.fn()
}));

vi.mock("../../packages/calendar/src/repository.js", () => ({
  CalendarRepository: class {
    listVisible = mockListVisible;
  }
}));

vi.mock("../../packages/tasks/src/drift.js", () => ({
  TaskDriftRepository: class {
    getOverdue = mockGetOverdue;
    getAtRisk = mockGetAtRisk;
  }
}));

import { calendarMonitorProvider } from "../../packages/calendar/src/monitor-provider.js";
import { tasksMonitorProvider } from "../../packages/tasks/src/monitor-provider.js";

const fakeScopedDb = {
  [dataContextBrand]: true as const,
  db: {}
} as unknown as DataContextDb;

const PACIFIC_24H = {
  timezone: "America/Los_Angeles",
  region: "en-GB",
  dateFormat: "24" as const
};

// 2026-10-09 20:30 Pacific.
const INSTANT = "2026-10-10T03:30:00.000Z";

function input(now: string): ProactiveMonitorInput {
  return {
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    sinceCursor: {},
    now,
    timeZone: PACIFIC_24H.timezone,
    locale: PACIFIC_24H,
    maxSignals: 10,
    priorityAnchors: []
  };
}

function event(id: string, startsAt: string) {
  return { id, external_id: id, title: `Event ${id}`, location: null, starts_at: startsAt };
}

beforeEach(() => {
  mockListVisible.mockReset();
  mockGetOverdue.mockReset().mockResolvedValue([]);
  mockGetAtRisk.mockReset().mockResolvedValue([]);
});

describe("calendar proactive notes use the owner's locale", () => {
  it("shows an event's start in the owner's zone and 24-hour time", async () => {
    mockListVisible.mockResolvedValue([event("evt-1", INSTANT)]);

    const { signals } = await calendarMonitorProvider.collectSignals(
      fakeScopedDb,
      input("2026-10-09T23:00:00.000Z")
    );

    expect(signals[0]?.summary).toBe("Starts 9 Oct 2026, 20:30");
  });

  it("keys the dense-schedule card by the owner's day, not the UTC day", async () => {
    mockListVisible.mockResolvedValue([
      event("a", "2026-10-10T05:00:00.000Z"),
      event("b", "2026-10-10T06:00:00.000Z"),
      event("c", "2026-10-10T07:00:00.000Z")
    ]);

    const { signals } = await calendarMonitorProvider.collectSignals(fakeScopedDb, input(INSTANT));

    const ownerDayHash = createHash("sha256").update("2026-10-09").digest("hex").slice(0, 16);
    expect(signals[0]?.signalType).toBe("dense_schedule");
    expect(signals[0]?.stableKey).toBe(`dense-schedule:${ownerDayHash}`);
  });
});

describe("tasks proactive notes use the owner's locale", () => {
  it("shows an overdue task's due date on the owner's day", async () => {
    mockGetOverdue.mockResolvedValue([
      { id: "task-1", title: "File taxes", due_at: new Date(INSTANT), priority: 1, effort: null }
    ]);

    const { signals } = await tasksMonitorProvider.collectSignals(
      fakeScopedDb,
      input("2026-10-11T12:00:00.000Z")
    );

    expect(signals[0]?.summary).toBe("Task overdue since 9 Oct 2026");
  });

  it("shows an at-risk task's due date on the owner's day", async () => {
    mockGetAtRisk.mockResolvedValue([
      { id: "task-2", title: "Send deck", due_at: new Date(INSTANT), priority: 1, effort: null }
    ]);

    const { signals } = await tasksMonitorProvider.collectSignals(
      fakeScopedDb,
      input("2026-10-09T12:00:00.000Z")
    );

    expect(signals[0]?.summary).toBe("High-priority task needs attention — due 9 Oct 2026");
  });
});
