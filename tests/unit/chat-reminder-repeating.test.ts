import { describe, expect, it } from "vitest";
import { scheduledLocalWallClockToInstant, strictLocalWallClockToInstant } from "@moss/module-sdk";

describe("saved reminder advancement across daylight saving", () => {
  const zone = "America/Los_Angeles";
  it("moves 02:30 to 03:30 through the spring gap", () => {
    expect(scheduledLocalWallClockToInstant("2026-03-08T02:30", zone).toISOString()).toBe(
      "2026-03-08T10:30:00.000Z"
    );
    expect(() => strictLocalWallClockToInstant("2026-03-08T02:30", zone)).toThrow();
  });
  it("uses the earlier 01:30 once in the fall fold", () => {
    expect(scheduledLocalWallClockToInstant("2026-11-01T01:30", zone).toISOString()).toBe(
      "2026-11-01T08:30:00.000Z"
    );
    expect(() => strictLocalWallClockToInstant("2026-11-01T01:30", zone)).toThrow();
  });
  it("shifts by the actual half-hour gap on Lord Howe Island", () => {
    expect(
      scheduledLocalWallClockToInstant("2026-10-04T02:15", "Australia/Lord_Howe").toISOString()
    ).toBe("2026-10-03T15:45:00.000Z");
  });
  it("still rejects malformed dates and zones", () => {
    expect(() => scheduledLocalWallClockToInstant("2026-02-30T09:00", zone)).toThrow();
    expect(() => scheduledLocalWallClockToInstant("2026-03-08T02:30", "bad-zone")).toThrow();
  });
});

import { nextReminderOccurrence } from "../../packages/chat/src/reminders/repeating.js";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";

describe("recurring cadence", () => {
  it("keeps daily wall time through a 23-hour day", () => {
    expect(
      nextReminderOccurrence(
        {
          repeat: { kind: "daily" },
          dueAt: new Date("2026-03-07T17:00Z"),
          localDue: "2026-03-07T09:00",
          timeZone: "America/Los_Angeles"
        },
        new Date("2026-03-07T17:01Z")
      ).dueAt.toISOString()
    ).toBe("2026-03-08T16:00:00.000Z");
  });
  it("skips missed weekly intervals, retaining the weekday", () => {
    expect(
      nextReminderOccurrence(
        {
          repeat: { kind: "weekly" },
          dueAt: new Date("2026-10-05T09:00Z"),
          localDue: "2026-10-05T09:00",
          timeZone: "UTC"
        },
        new Date("2026-10-21T12:00Z")
      ).localDue
    ).toBe("2026-10-26T09:00");
  });
  it("advances past the repeated fall hour rather than firing twice", () => {
    expect(
      nextReminderOccurrence(
        {
          repeat: { kind: "daily" },
          dueAt: new Date("2026-11-01T08:30Z"),
          localDue: "2026-11-01T01:30",
          timeZone: "America/Los_Angeles"
        },
        new Date("2026-11-01T09:15Z")
      ).dueAt.toISOString()
    ).toBe("2026-11-02T09:30:00.000Z");
  });
  it("restores 02:30 after the gap instead of saving 03:30 as the new cadence", () => {
    expect(
      nextReminderOccurrence(
        {
          repeat: { kind: "daily" },
          dueAt: new Date("2026-03-08T10:30Z"),
          localDue: "2026-03-08T02:30",
          timeZone: "America/Los_Angeles"
        },
        new Date("2026-03-08T10:31Z")
      ).dueAt.toISOString()
    ).toBe("2026-03-09T09:30:00.000Z");
  });
  it("keeps interval phase after downtime", () => {
    expect(
      nextReminderOccurrence(
        {
          repeat: { kind: "interval", seconds: 60 },
          dueAt: new Date("2026-10-12T09:00Z"),
          localDue: null,
          timeZone: null
        },
        new Date("2026-10-12T09:05:31Z")
      ).dueAt.toISOString()
    ).toBe("2026-10-12T09:06:00.000Z");
  });
});
describe("ordinary repeat requests", () => {
  it.each([
    ["remind me every day at 9am to Stretch", "daily"],
    ["remind me every Monday at 09:00 to water plants", "weekly"],
    ["remind me to Stretch daily at 9am", "daily"],
    ["remind me hourly to stand up", "interval"],
    ["remind me every 2 minutes to stand up", "interval"]
  ])("recognizes %s", (text, kind) => {
    expect(recognizeReminderPlan(text)).toMatchObject({ kind: "repeat_request", repeat: { kind } });
  });
  it.each([
    "I work every Monday",
    "what should I do daily?",
    "remind me what happened last week",
    "we talked about this two weeks ago"
  ])("leaves %s unchanged", (text) => {
    expect(recognizeReminderPlan(text)).toBeUndefined();
  });
  it("refuses unsafe intervals", () => {
    expect(recognizeReminderPlan("remind me every 2 seconds to stand up")).toMatchObject({
      kind: "unsupported"
    });
  });
});

import { scheduledReminder } from "../../packages/chat/src/reminders/settings.js";
it("formats Settings cadence with the owner's 12-hour clock", () => {
  const row = {
    id: "reminder",
    reminder_text: "stretch",
    state: "queued" as const,
    thread_id: "main",
    due_at: new Date("2026-10-13T13:30Z"),
    deadline_at: null,
    created_at: new Date("2026-10-12T13:30Z"),
    delivered_at: null,
    expired_at: null,
    late: null,
    message_id: null,
    message_body: null,
    repeat_kind: "daily" as const,
    repeat_seconds: null,
    local_due: "2026-10-13T13:30",
    time_zone: "UTC"
  };
  expect(scheduledReminder(row, "12").schedule).toBe("Every day at 1:30 PM (UTC)");
  expect(scheduledReminder(row, "24").schedule).toBe("Every day at 13:30 (UTC)");
});
