import { describe, expect, it } from "vitest";
import { chooseSlot, isAllDayInterval, type ResolvedWindow } from "./focus-time.js";

const TZ = "America/New_York"; // UTC-4 in June (DST)

describe("isAllDayInterval", () => {
  it("is true for a single all-day event (local midnight to local midnight, 24h)", () => {
    // 2026-06-17 00:00 America/New_York = 2026-06-17T04:00:00Z (EDT, UTC-4)
    expect(
      isAllDayInterval(
        { start: "2026-06-17T04:00:00Z", end: "2026-06-18T04:00:00Z" },
        TZ
      )
    ).toBe(true);
  });

  it("is true for a multi-day all-day event (72h, still midnight-aligned)", () => {
    expect(
      isAllDayInterval(
        { start: "2026-06-17T04:00:00Z", end: "2026-06-20T04:00:00Z" },
        TZ
      )
    ).toBe(true);
  });

  it("is false for a genuine multi-day timed event that isn't midnight-aligned", () => {
    // Starts mid-afternoon on day 1, ends mid-morning two days later — a real 43h meeting.
    expect(
      isAllDayInterval(
        { start: "2026-06-17T18:00:00Z", end: "2026-06-19T13:00:00Z" },
        TZ
      )
    ).toBe(false);
  });

  it("is false for a normal timed meeting", () => {
    expect(
      isAllDayInterval(
        { start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" },
        TZ
      )
    ).toBe(false);
  });

  it("is false when the duration isn't a multiple of 24h even if midnight-aligned at the start", () => {
    expect(
      isAllDayInterval(
        { start: "2026-06-17T04:00:00Z", end: "2026-06-17T16:00:00Z" },
        TZ
      )
    ).toBe(false);
  });
});

describe("chooseSlot with all-day intervals filtered out (issue #1711)", () => {
  const window: ResolvedWindow = {
    start: new Date("2026-06-17T13:00:00Z"),
    end: new Date("2026-06-17T16:00:00Z"),
    durationMinutes: 120,
    title: "Focus time"
  };

  it("an all-day event no longer blocks a slot once filtered", () => {
    const allDayBusy = [{ start: "2026-06-17T04:00:00Z", end: "2026-06-18T04:00:00Z" }];
    const filtered = allDayBusy.filter((b) => !isAllDayInterval(b, TZ));
    const result = chooseSlot(window, filtered, window.durationMinutes);
    expect(result.conflict).toBe("none");
    expect(result.shifted).toBe(false);
  });

  it("a genuine multi-day timed event (not midnight-aligned) still blocks correctly", () => {
    const timedBusy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-19T13:00:00Z" }];
    const filtered = timedBusy.filter((b) => !isAllDayInterval(b, TZ));
    expect(filtered).toEqual(timedBusy); // not filtered out
    const result = chooseSlot(window, filtered, window.durationMinutes);
    expect(result.conflict).toBe("no-clear-slot");
  });

  it("existing shifted case still passes: a short busy interval shifts the slot", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }];
    const result = chooseSlot(window, busy, window.durationMinutes);
    expect(result.shifted).toBe(true);
    expect(result.conflict).toBe("shifted");
  });

  it("existing no-clear-slot case still passes: a fully busy window has no free slot", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }];
    const result = chooseSlot(window, busy, window.durationMinutes);
    expect(result.conflict).toBe("no-clear-slot");
  });
});
