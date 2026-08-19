import { describe, expect, it } from "vitest";
import {
  resolveWindow,
  chooseSlot,
  focusBlockEventId,
  type FocusBlockInput
} from "../../packages/calendar/src/focus-time.js";
import { freezeRelativeDate } from "../../packages/calendar/src/tools.js";
import type {
  CalendarWriteService,
  FocusBlockWindow,
  ProposeFocusResult
} from "../../packages/calendar/src/calendar-write-service.js";

const TZ = "America/New_York";
// Fixed "now": 2026-06-16T12:00:00Z (a Tuesday). "tomorrow" = 2026-06-17.
const NOW = new Date("2026-06-16T12:00:00Z");

describe("resolveWindow", () => {
  it("morning maps to 09:00–12:00 local on the given date", () => {
    const w = resolveWindow(
      { date: "2026-06-17", partOfDay: "morning", durationMinutes: 120 },
      NOW,
      TZ
    );
    // 09:00 America/New_York on 2026-06-17 is 13:00Z (EDT, UTC-4).
    expect(w.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-17T16:00:00.000Z");
  });

  it("afternoon maps to 12:00–17:00, evening to 17:00–21:00 local", () => {
    const a = resolveWindow(
      { date: "2026-06-17", partOfDay: "afternoon", durationMinutes: 60 },
      NOW,
      TZ
    );
    expect(a.start.toISOString()).toBe("2026-06-17T16:00:00.000Z"); // 12:00 EDT
    const e = resolveWindow(
      { date: "2026-06-17", partOfDay: "evening", durationMinutes: 60 },
      NOW,
      TZ
    );
    expect(e.start.toISOString()).toBe("2026-06-17T21:00:00.000Z"); // 17:00 EDT
  });

  it("defaults date to tomorrow when only partOfDay is given", () => {
    const w = resolveWindow({ partOfDay: "morning", durationMinutes: 120 }, NOW, TZ);
    expect(w.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
  });

  it("an explicit start sets a window of start..start+duration", () => {
    const w = resolveWindow({ start: "2026-06-17T18:00:00.000Z", durationMinutes: 90 }, NOW, TZ);
    expect(w.start.toISOString()).toBe("2026-06-17T18:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-17T19:30:00.000Z");
  });

  it("clamps duration to 15..480 and defaults title to 'Focus time'", () => {
    const lo = resolveWindow({ partOfDay: "morning", durationMinutes: 5 }, NOW, TZ);
    expect(lo.durationMinutes).toBe(15);
    const hi = resolveWindow({ partOfDay: "morning", durationMinutes: 9000 }, NOW, TZ);
    expect(hi.durationMinutes).toBe(480);
    expect(lo.title).toBe("Focus time");
  });

  it("rejects a malformed start and a malformed date (handler-side validation, Codex MED #5)", () => {
    expect(() => resolveWindow({ start: "not-a-date", durationMinutes: 60 }, NOW, TZ)).toThrow(
      /valid RFC3339/
    );
    expect(() => resolveWindow({ date: "06/17/2026", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /yyyy-mm-dd/
    );
  });

  it("rejects a well-formed but impossible calendar date (overflow, Codex LOW #20)", () => {
    // Date.UTC would silently normalize 2026-99-99 to a real date; resolveWindow must reject it.
    expect(() => resolveWindow({ date: "2026-99-99", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /not a valid calendar date/
    );
    expect(() => resolveWindow({ date: "2026-02-30", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /not a valid calendar date/
    );
  });
});

describe("chooseSlot", () => {
  const window = {
    start: new Date("2026-06-17T13:00:00Z"),
    end: new Date("2026-06-17T16:00:00Z"),
    durationMinutes: 120,
    title: "Focus time"
  };

  it("returns the requested slot unshifted when the window is clear", () => {
    const r = chooseSlot(window, [], 120);
    expect(r.conflict).toBe("none");
    expect(r.shifted).toBe(false);
    expect(r.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:00:00.000Z");
  });

  it("shifts forward past a busy interval to the next clear slot in the window", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("shifted");
    expect(r.shifted).toBe(true);
    expect(r.start.toISOString()).toBe("2026-06-17T13:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:30:00.000Z");
  });

  it("returns no-clear-slot when the window cannot fit the duration", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("no-clear-slot");
    expect(r.shifted).toBe(false);
  });

  it("chooses an exact-fit gap between two busy intervals", () => {
    const busy = [
      { start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" },
      { start: "2026-06-17T15:30:00Z", end: "2026-06-17T16:00:00Z" }
    ];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("shifted");
    expect(r.start.toISOString()).toBe("2026-06-17T13:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:30:00.000Z");
  });
});

describe("focusBlockEventId (outbound-write idempotency floor)", () => {
  // Keyed on the ORIGINAL approved proposal (requested window + duration + actor + title),
  // NOT the post-freeBusy chosen slot — so a retry whose slot shifts still produces the same id.
  const proposal = {
    actorUserId: "user-a",
    windowStart: new Date("2026-06-17T13:00:00Z"),
    windowEnd: new Date("2026-06-17T16:00:00Z"),
    durationMinutes: 120,
    title: "Focus time"
  };

  it("is deterministic: the same approved proposal yields the same id (retry-safe)", () => {
    expect(focusBlockEventId(proposal)).toBe(focusBlockEventId({ ...proposal }));
  });

  it("is INDEPENDENT of the chosen slot: only the requested window/duration/actor/title matter", () => {
    // Two retries of the SAME proposal must collide even though the second retry's freeBusy
    // would shift the slot — the id is keyed on the requested window, not the slot. Proven by
    // construction: focusBlockEventId takes no slot input. This test documents that contract.
    const a = focusBlockEventId(proposal);
    const b = focusBlockEventId({ ...proposal }); // same proposal, regardless of any slot shift
    expect(a).toBe(b);
  });

  it("differs when actor, window, duration, or title changes (no cross-proposal collision)", () => {
    const base = focusBlockEventId(proposal);
    expect(focusBlockEventId({ ...proposal, actorUserId: "user-b" })).not.toBe(base);
    expect(
      focusBlockEventId({ ...proposal, windowStart: new Date("2026-06-17T14:00:00Z") })
    ).not.toBe(base);
    expect(
      focusBlockEventId({ ...proposal, windowEnd: new Date("2026-06-17T17:00:00Z") })
    ).not.toBe(base);
    expect(focusBlockEventId({ ...proposal, durationMinutes: 60 })).not.toBe(base);
    expect(focusBlockEventId({ ...proposal, title: "Deep work" })).not.toBe(base);
  });

  it("is a valid Google event id: base32hex chars only, length within 5..1024", () => {
    const id = focusBlockEventId(proposal);
    expect(id).toMatch(/^jfb[0-9a-v]+$/); // base32hex alphabet (a-v + 0-9), Jarvis tag prefix
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });
});

describe("freezeRelativeDate (card↔execute day agreement across midnight, Codex round 4)", () => {
  const TZ_NY = "America/New_York";

  it("stamps an absolute 'tomorrow' onto a relative input, frozen at the first (card) clock", () => {
    // 23:30 local on 2026-06-16 (EDT, UTC-4) = 2026-06-17T03:30Z. "tomorrow" = 2026-06-17.
    const beforeMidnight = new Date("2026-06-17T03:30:00Z");
    const input: Record<string, unknown> = { partOfDay: "morning", durationMinutes: 120 };
    freezeRelativeDate(input, beforeMidnight, TZ_NY);
    expect(input.date).toBe("2026-06-17");
  });

  it("is a no-op once frozen: a later (after-midnight) execute clock cannot move the day", () => {
    const input: Record<string, unknown> = { partOfDay: "morning", durationMinutes: 120 };
    // Card created at 23:30 local 06-16 → freezes to 06-17.
    freezeRelativeDate(input, new Date("2026-06-17T03:30:00Z"), TZ_NY);
    const frozen = input.date;
    // Approved at 00:30 local 06-17 (04:30Z) — naive "tomorrow" would now be 06-18.
    freezeRelativeDate(input, new Date("2026-06-17T04:30:00Z"), TZ_NY);
    expect(input.date).toBe(frozen);
    expect(input.date).toBe("2026-06-17");
    // resolveWindow on the frozen input gives the SAME day regardless of the execute clock —
    // so the approval card, the inserted event, and the deterministic id all agree.
    const w = resolveWindow(
      readInputForTest(input),
      new Date("2026-06-17T04:30:00Z"), // after-midnight execute clock
      TZ_NY
    );
    expect(w.start.toISOString().slice(0, 10)).toBe("2026-06-17");
  });

  it("never overrides an explicit date or start", () => {
    const withDate: Record<string, unknown> = { date: "2026-07-01", partOfDay: "morning" };
    freezeRelativeDate(withDate, new Date("2026-06-17T03:30:00Z"), TZ_NY);
    expect(withDate.date).toBe("2026-07-01");
    const withStart: Record<string, unknown> = { start: "2026-07-01T18:00:00Z" };
    freezeRelativeDate(withStart, new Date("2026-06-17T03:30:00Z"), TZ_NY);
    expect(withStart.date).toBeUndefined();
  });
});

// Mirror the tool's readInput shape for the resolveWindow assertion above (kept local to the test).
function readInputForTest(input: Record<string, unknown>): FocusBlockInput {
  return {
    date: typeof input.date === "string" ? input.date : undefined,
    partOfDay: input.partOfDay as FocusBlockInput["partOfDay"],
    start: typeof input.start === "string" ? input.start : undefined,
    durationMinutes: typeof input.durationMinutes === "number" ? input.durationMinutes : undefined,
    title: typeof input.title === "string" ? input.title : undefined
  };
}

describe("CalendarWriteService interface shape", () => {
  it("a fake impl satisfies the interface and returns a ProposeFocusResult", async () => {
    const fake: CalendarWriteService = {
      async createEvent(_scopedDb, _ctx, window: FocusBlockWindow) {
        const result: ProposeFocusResult = {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none",
          googleEventId: "evt-1",
          calendarMirror: "written"
        };
        return result;
      },
      async deleteEvent() {
        return { deleted: false, googleDeleted: "skipped-error", cacheMirror: "not-cached" };
      }
    };
    const res = await fake.createEvent(
      {},
      { actorUserId: "u", requestId: "r", chatSessionId: "s" },
      {
        start: new Date("2026-06-17T13:00:00Z"),
        end: new Date("2026-06-17T15:00:00Z"),
        durationMinutes: 120,
        title: "Focus time"
      }
    );
    expect(res.created).toBe(true);
    expect(res.calendarMirror).toBe("written");
  });
});

// Touch the imported type so the unused-import lint rule stays satisfied while
// the file documents the public input shape it exercises.
const _typeWitness: FocusBlockInput = { partOfDay: "morning", durationMinutes: 120 };
void _typeWitness;
