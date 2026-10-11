// #3150: clock-time reminders. Recognition, resolution in the owner's zone across daylight saving,
// and the code-written replies.

import { describe, expect, it } from "vitest";

import type { LocalClockSpec } from "../../packages/chat/src/reminders/clock-recognizer.js";
import {
  reminderClockRefusedReply,
  reminderClockSavedReply
} from "../../packages/chat/src/reminders/clock-wording.js";
import {
  localWallClock,
  resolveLocalClock
} from "../../packages/chat/src/reminders/local-clock.js";
import { recognizeRelativeReminder } from "../../packages/chat/src/reminders/recognizer.js";
import type { OwnedReminder } from "../../packages/chat/src/reminders/repository.js";
import { reminderListReply } from "../../packages/chat/src/reminders/wording.js";

const LA = "America/Los_Angeles";

function spec(
  day: LocalClockSpec["day"],
  hour: number,
  minute = 0,
  deadline: LocalClockSpec["deadline"] = null
): LocalClockSpec {
  return { day, time: { hour, minute }, deadline };
}

describe("clock reminder recognizer", () => {
  it.each([
    ["remind me at 3pm to call Sam", spec(null, 15), "call Sam"],
    ["Remind me tomorrow at 9:30 am to call the Bank", spec("tomorrow", 9, 30), "call the Bank"],
    ["remind me at 3pm tomorrow to call Sam", spec("tomorrow", 15), "call Sam"],
    ["remind me to call Sam at 15:00 tomorrow", spec("tomorrow", 15), "call Sam"],
    ["remind me tonight at 8 to take the bins out", spec("tonight", 20), "take the bins out"],
    ["remind me today at 09:05 to stand up", spec("today", 9, 5), "stand up"],
    ["set a reminder at noon to eat lunch", spec(null, 12), "eat lunch"],
    ["set me a reminder to stretch at 6 p.m.", spec(null, 18), "stretch"],
    ["set a reminder for 3pm to call Sam", spec(null, 15), "call Sam"],
    ["set a reminder for tomorrow at 9am to call Sam", spec("tomorrow", 9), "call Sam"],
    ["remind me tonight at 11 to lock up", spec("tonight", 23), "lock up"],
    [
      "remind me at 3pm to call Sam, not after 4pm",
      spec(null, 15, 0, { hour: 16, minute: 0 }),
      "call Sam"
    ],
    [
      "remind me tomorrow at 9am to call the bank unless it's past 11:30am",
      spec("tomorrow", 9, 0, { hour: 11, minute: 30 }),
      "call the bank"
    ],
    [
      "remind me at 11pm to lock up, skip it if it's after 1am",
      spec(null, 23, 0, { hour: 1, minute: 0 }),
      "lock up"
    ]
  ])("saves %j", (raw, clock, text) => {
    expect(recognizeRelativeReminder(raw)).toEqual({ kind: "clock_request", clock, text });
  });

  it.each([
    ["remind me at 3 to call Sam", "needs_am_pm"],
    ["remind me tomorrow at 9 to call Sam", "needs_am_pm"],
    ["remind me at 3pm to call Sam, not after 4", "needs_am_pm"],
    ["remind me tonight at 7am to stretch", "ambiguous"],
    ["remind me tonight at 1 to lock up", "needs_am_pm"],
    ["remind me tonight at 3 to lock up", "needs_am_pm"],
    ["remind me at midnight to take my pills", "ambiguous"],
    ["remind me tomorrow morning at 9am to call Sam", "unsupported_day"],
    ["remind me at 25:00 to stretch", "ambiguous"],
    ["remind me at 3:75pm to stretch", "ambiguous"],
    ["remind me tomorrow at 3pm tomorrow to stretch", "ambiguous"],
    ["remind me tomorrow at 9am to stretch tonight", "ambiguous"],
    ["remind me at 9am to call Sam at 10", "ambiguous"],
    ["remind me at 9am to call Sam or Jo", "ambiguous"],
    ["remind me at 9am every day to stretch", "recurrence"],
    ["remind me at 9am to stretch on Monday", "unsupported_day"],
    ["remind me on Friday at 9am to stretch", "unsupported_day"],
    ["remind me at 9am to pay rent on October 12", "unsupported_day"],
    ["remind me in 1 hour to stretch, not after 5pm", "deadline_needs_clock"]
  ])("refuses %j", (raw, reason) => {
    expect(recognizeRelativeReminder(raw)).toEqual({ kind: "unsupported", reason });
  });

  it.each(["what's on at 3pm", "remind me what happened at 3pm", "meet at 3pm tomorrow"])(
    "leaves %j to the model",
    (raw) => {
      expect(recognizeRelativeReminder(raw)).toEqual({ kind: "none" });
    }
  );
});

describe("resolving a clock reminder in the owner's zone", () => {
  // 2026-10-10 12:00 in Los Angeles (daylight time, UTC-7).
  const NOON = new Date("2026-10-10T19:00:00Z");

  it("resolves today's time to the exact instant", () => {
    expect(resolveLocalClock(spec(null, 15), NOON, LA)).toEqual({
      kind: "resolved",
      dueAt: new Date("2026-10-10T22:00:00Z"),
      localDue: "2026-10-10T15:00",
      deadlineAt: null,
      localDeadline: null,
      timeZone: LA
    });
  });

  it("rolls a passed time with no day word to tomorrow", () => {
    const resolved = resolveLocalClock(spec(null, 9), NOON, LA);
    expect(resolved).toMatchObject({ localDue: "2026-10-11T09:00" });
  });

  it("refuses a passed time the owner pinned to today", () => {
    expect(resolveLocalClock(spec("today", 9), NOON, LA)).toEqual({
      kind: "refused",
      reason: "time_passed",
      time: { hour: 9, minute: 0 }
    });
    expect(resolveLocalClock(spec("today", 12), NOON, LA)).toMatchObject({
      reason: "time_passed"
    });
  });

  it("reads the same words differently in another zone", () => {
    const tokyo = resolveLocalClock(spec("tomorrow", 9), NOON, "Asia/Tokyo");
    // Noon in Los Angeles is 04:00 on the 11th in Tokyo, so tomorrow there is the 12th.
    expect(tokyo).toMatchObject({
      localDue: "2026-10-12T09:00",
      dueAt: new Date("2026-10-12T00:00:00Z")
    });
  });

  it("keeps the wall clock across the spring change", () => {
    // 2026-03-07 20:00 standard time; the clocks go forward at 02:00 on the 8th.
    const eve = new Date("2026-03-08T04:00:00Z");
    expect(resolveLocalClock(spec("tomorrow", 9), eve, LA)).toMatchObject({
      localDue: "2026-03-08T09:00",
      dueAt: new Date("2026-03-08T16:00:00Z")
    });
  });

  it("keeps the wall clock across the autumn change", () => {
    // 2026-10-31 20:00 daylight time; the clocks go back at 02:00 on 1 November.
    const eve = new Date("2026-11-01T03:00:00Z");
    expect(resolveLocalClock(spec("tomorrow", 9), eve, LA)).toMatchObject({
      localDue: "2026-11-01T09:00",
      dueAt: new Date("2026-11-01T17:00:00Z")
    });
  });

  it("refuses a time the clocks skip", () => {
    const eve = new Date("2026-03-08T04:00:00Z");
    expect(resolveLocalClock(spec("tomorrow", 2, 30), eve, LA)).toEqual({
      kind: "refused",
      reason: "dst_gap",
      localDate: "2026-03-08",
      time: { hour: 2, minute: 30 }
    });
  });

  it("refuses a time the clocks show twice", () => {
    const eve = new Date("2026-11-01T03:00:00Z");
    expect(resolveLocalClock(spec("tomorrow", 1, 30), eve, LA)).toEqual({
      kind: "refused",
      reason: "dst_fold",
      localDate: "2026-11-01",
      time: { hour: 1, minute: 30 }
    });
  });

  it("refuses a deadline that lands in a skipped hour", () => {
    const eve = new Date("2026-03-08T04:00:00Z");
    const resolved = resolveLocalClock(spec(null, 23, 0, { hour: 2, minute: 15 }), eve, LA);
    expect(resolved).toMatchObject({ kind: "refused", reason: "dst_gap" });
  });

  it("places a deadline on the same day when it comes later that day", () => {
    const resolved = resolveLocalClock(spec(null, 15, 0, { hour: 16, minute: 0 }), NOON, LA);
    expect(resolved).toMatchObject({
      deadlineAt: new Date("2026-10-10T23:00:00Z"),
      localDeadline: "2026-10-10T16:00"
    });
  });

  it("places a deadline on the next day when its time comes round after midnight", () => {
    const resolved = resolveLocalClock(spec(null, 23, 0, { hour: 1, minute: 0 }), NOON, LA);
    expect(resolved).toMatchObject({
      deadlineAt: new Date("2026-10-11T08:00:00Z"),
      localDeadline: "2026-10-11T01:00"
    });
  });

  it("refuses a deadline more than 12 hours after the reminder", () => {
    // 14:00 to 13:00 means 13:00 the next day, 23 hours later.
    const resolved = resolveLocalClock(spec(null, 14, 0, { hour: 13, minute: 0 }), NOON, LA);
    expect(resolved).toEqual({ kind: "refused", reason: "deadline_too_far" });
  });

  it("reads an instant back as the owner's wall clock", () => {
    expect(localWallClock(new Date("2026-03-08T10:30:00Z"), LA)).toBe("2026-03-08T03:30");
    expect(localWallClock(new Date("2026-10-10T07:05:00Z"), LA)).toBe("2026-10-10T00:05");
  });
});

describe("clock reminder replies", () => {
  const NOON = new Date("2026-10-10T19:00:00Z");

  function resolved(clock: LocalClockSpec) {
    const result = resolveLocalClock(clock, NOON, LA);
    if (result.kind !== "resolved") throw new Error("expected a resolved reminder");
    return result;
  }

  it("confirms in the owner's 12-hour clock", () => {
    expect(reminderClockSavedReply(resolved(spec(null, 15)), "call Sam", "2026-10-10", "12")).toBe(
      "Okay. I'll remind you today at 3:00 PM Pacific Time: call Sam"
    );
  });

  it("confirms in the owner's 24-hour clock, with the deadline", () => {
    const clock = spec("tomorrow", 9, 0, { hour: 11, minute: 30 });
    expect(reminderClockSavedReply(resolved(clock), "call the bank", "2026-10-10", "24")).toBe(
      "Okay. I'll remind you tomorrow at 09:00 Pacific Time: call the bank\n" +
        "If I can't send it by 11:30, I'll skip it."
    );
  });

  it("names the day of a deadline that falls after midnight", () => {
    const clock = spec(null, 23, 0, { hour: 1, minute: 0 });
    expect(reminderClockSavedReply(resolved(clock), "lock up", "2026-10-10", "12")).toBe(
      "Okay. I'll remind you today at 11:00 PM Pacific Time: lock up\n" +
        "If I can't send it by 1:00 AM tomorrow, I'll skip it."
    );
  });

  it("explains each refusal without setting anything", () => {
    const time = { hour: 2, minute: 30 };
    expect(
      reminderClockRefusedReply(
        { kind: "refused", reason: "time_passed", time },
        "2026-10-10",
        "12"
      )
    ).toBe(
      `It's already past 2:30 AM today, so I didn't set anything. Say "tomorrow at 2:30 AM" if you meant tomorrow.`
    );
    expect(
      reminderClockRefusedReply(
        { kind: "refused", reason: "dst_gap", localDate: "2026-03-08", time },
        "2026-03-07",
        "24"
      )
    ).toBe(
      "The clocks go forward tomorrow, so 02:30 doesn't happen that day. I didn't set anything. Pick a time outside that hour."
    );
    expect(
      reminderClockRefusedReply(
        { kind: "refused", reason: "dst_fold", localDate: "2026-11-01", time },
        "2026-10-10",
        "12"
      )
    ).toBe(
      "The clocks go back on Sunday, November 1, so 2:30 AM happens twice that day. I didn't set anything. Pick a time outside that hour."
    );
    expect(
      reminderClockRefusedReply({ kind: "refused", reason: "deadline_too_far" }, "2026-10-10", "12")
    ).toContain("within 12 hours");
  });
});

describe("listing clock reminders", () => {
  const NOON = new Date("2026-10-10T19:00:00Z");

  function owned(text: string, overrides: Partial<OwnedReminder>): OwnedReminder {
    return {
      id: `id-${text}`,
      text,
      state: "queued",
      contextState: "pending",
      dueAt: new Date("2026-10-10T22:00:00Z"),
      createdAt: NOON,
      timing: "local_clock",
      deadlineAt: null,
      late: null,
      ...overrides
    };
  }

  it("shows each waiting clock reminder at its local time, with any deadline", () => {
    const list = {
      now: NOON,
      open: [
        owned("call Sam", {}),
        owned("lock up", {
          dueAt: new Date("2026-10-11T06:00:00Z"),
          deadlineAt: new Date("2026-10-11T08:00:00Z")
        })
      ],
      finished: [
        owned("stretch", { state: "delivered", late: true }),
        owned("water plants", { state: "delivered", late: false }),
        owned("pay rent", { state: "expired" })
      ]
    };
    expect(reminderListReply(list, { timeZone: LA, clockFormat: "12" })).toBe(
      "Chat reminders waiting:\n" +
        "- call Sam, today at 3:00 PM\n" +
        "- lock up, today at 11:00 PM, skipped if not sent by 1:00 AM tomorrow\n\n" +
        "Recent chat reminders:\n" +
        "- stretch (sent late)\n" +
        "- water plants (sent)\n" +
        "- pay rent (skipped, past its deadline)"
    );
  });

  it("says a waiting reminder past its deadline won't be sent, before the worker marks it", () => {
    const list = {
      now: new Date("2026-10-10T23:30:00Z"),
      open: [owned("call Sam", { deadlineAt: new Date("2026-10-10T23:00:00Z") })],
      finished: []
    };
    expect(reminderListReply(list, { timeZone: LA, clockFormat: "12" })).toBe(
      "Chat reminders waiting:\n- call Sam, today at 3:00 PM, past its deadline, so it won't be sent"
    );
  });

  it("shows the time in the owner's current zone and clock", () => {
    const list = { now: NOON, open: [owned("call Sam", {})], finished: [] };
    expect(reminderListReply(list, { timeZone: "Europe/London", clockFormat: "24" })).toBe(
      "Chat reminders waiting:\n- call Sam, today at 23:00"
    );
  });
});
