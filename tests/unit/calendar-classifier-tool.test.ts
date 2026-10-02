import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { calendarListVisibleEventsExecute } from "../../packages/calendar/src/tools.js";
import { classifierWindowRange } from "../../packages/calendar/src/classifier-window.js";
import { renderReplyTemplate } from "../../packages/chat/src/live/classifier-gate-arguments.js";

// Classifier gate plan 2.3 (#2883): the classifier picks only a named window; the handler resolves
// the instants in the actor's timezone and writes a code-authored summary the template renders.

const NOW = new Date("2026-07-03T12:00:00.000Z"); // 05:00 in Los Angeles, 21:00 in Tokyo
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

function ctx(timeZone: string): ToolContext {
  return { actorUserId: "user-1", requestId: "req-1", chatSessionId: "", localTimezone: timeZone };
}

function contextItem(overrides: Record<string, unknown> = {}) {
  return {
    eventKey: "evt-1",
    account: { connectorAccountId: "acc-google", providerId: "google", providerLabel: "Google" },
    title: "Team sync",
    startsAt: "2026-07-03T15:00:00.000Z",
    endsAt: "2026-07-03T15:30:00.000Z",
    allDay: false,
    location: "Room 4",
    attendeeCount: 3,
    flags: ["has_location", "prep_attendees"],
    source: "live",
    degradedReason: null,
    ...overrides
  };
}

const liveAccount = {
  account: { connectorAccountId: "acc-google", providerId: "google", providerLabel: "Google" },
  source: "live",
  degradedReason: null
};

function services(result: {
  items?: readonly unknown[];
  accounts?: readonly unknown[];
  gaps?: readonly unknown[];
  truncated?: boolean;
}) {
  const listCalendarContext = vi.fn(async () => ({
    items: result.items ?? [],
    accounts: result.accounts ?? [liveAccount],
    gaps: result.gaps ?? [],
    ...(result.truncated === undefined ? {} : { truncated: result.truncated })
  }));
  return {
    services: { sourceContext: { listEmailContext: vi.fn(), listCalendarContext } },
    listCalendarContext
  };
}

describe("classifierWindowRange", () => {
  it("resolves today and tomorrow as consecutive local civil days per timezone", () => {
    const laToday = classifierWindowRange("today", NOW, LA);
    const laTomorrow = classifierWindowRange("tomorrow", NOW, LA);
    expect(laToday.startsAfter.toISOString()).toBe("2026-07-03T07:00:00.000Z");
    expect(laToday.startsBefore.toISOString()).toBe("2026-07-04T07:00:00.000Z");
    expect(laTomorrow.startsAfter.toISOString()).toBe(laToday.startsBefore.toISOString());
    expect(laTomorrow.startsAfter.toISOString()).toBe("2026-07-04T07:00:00.000Z");

    const tokyoToday = classifierWindowRange("today", NOW, TOKYO);
    expect(tokyoToday.startsAfter.toISOString()).toBe("2026-07-02T15:00:00.000Z");
    expect(tokyoToday.startsBefore.toISOString()).toBe("2026-07-03T15:00:00.000Z");
    // Same instant, different zone => different window. Fails if the range is hardcoded to UTC.
    expect(tokyoToday.startsAfter.toISOString()).not.toBe(laToday.startsAfter.toISOString());
  });
});

describe("calendarListVisibleEventsExecute with a classifier window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the named window in the actor's timezone, not the model's", async () => {
    const la = services({});
    await calendarListVisibleEventsExecute(scopedDb, { window: "today" }, ctx(LA), la.services);
    expect(la.listCalendarContext).toHaveBeenCalledWith(scopedDb, {
      windowStart: "2026-07-03T07:00:00.000Z",
      windowEnd: "2026-07-04T07:00:00.000Z"
    });

    const tokyo = services({});
    await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(TOKYO),
      tokyo.services
    );
    expect(tokyo.listCalendarContext).toHaveBeenCalledWith(scopedDb, {
      windowStart: "2026-07-02T15:00:00.000Z",
      windowEnd: "2026-07-03T15:00:00.000Z"
    });
  });

  it("labels the summary with the chosen day and keeps the default path unchanged", async () => {
    const today = services({ items: [contextItem()] });
    const todayResult = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(LA),
      today.services
    );
    expect(todayResult.data?.summary).toBe("1 event today. Next: Team sync.");

    const tomorrow = services({ items: [contextItem()] });
    const tomorrowResult = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "tomorrow" },
      ctx(LA),
      tomorrow.services
    );
    expect(tomorrowResult.data?.summary).toBe("1 event tomorrow. Next: Team sync.");

    // No window (the default-model path) never carries a summary, so behavior is unchanged.
    const plain = services({ items: [contextItem()] });
    const plainResult = await calendarListVisibleEventsExecute(
      scopedDb,
      { startsAfter: "2026-07-03T12:00:00.000Z" },
      ctx(LA),
      plain.services
    );
    expect(plainResult.data).not.toHaveProperty("summary");
  });

  it("omits the summary when the source truncated the list, so the gate declines", async () => {
    const truncated = services({ items: [contextItem()], truncated: true });
    const result = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(LA),
      truncated.services
    );
    expect(result.data).not.toHaveProperty("summary");
    expect(renderReplyTemplate("{summary}", result.data)).toBeNull();
  });

  it("says when accounts used cached or unavailable data", async () => {
    const cached = services({
      items: [contextItem()],
      accounts: [{ ...liveAccount, source: "cache", degradedReason: "network_error" }]
    });
    const cachedResult = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(LA),
      cached.services
    );
    expect(cachedResult.data?.summary).toContain("used cached or unavailable data");

    const gap = services({
      gaps: [{ account: null, reason: "auth_error" }]
    });
    const gapResult = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(LA),
      gap.services
    );
    expect(gapResult.data?.summary).toBe(
      "No events today. Some calendar accounts could not be read, so there may be more."
    );
  });

  it("keeps the reply bounded to a few titles and a fixed length", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      contextItem({ eventKey: `evt-${i}`, title: `Event number ${i}` })
    );
    const result = await calendarListVisibleEventsExecute(
      scopedDb,
      { window: "today" },
      ctx(LA),
      services({ items: many }).services
    );
    const summary = result.data?.summary as string;
    expect(summary).toBe("10 events today. Next: Event number 0; Event number 1; Event number 2.");
  });

  it("still fails closed on a non-data-context handle", async () => {
    await expect(
      calendarListVisibleEventsExecute(
        {} as never,
        { window: "today" },
        ctx(LA),
        services({}).services
      )
    ).rejects.toThrow();
  });
});
