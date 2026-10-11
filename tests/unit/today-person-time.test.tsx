import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import { buildChatSeeds } from "../../apps/web/src/chat/seeds.js";
import { ClockTime } from "../../apps/web/src/today/clock-time.js";
import { buildScheduleGaps } from "../../apps/web/src/today/day-plan-gaps.js";
import { conflictText } from "../../apps/web/src/today/day-plan-review-model.js";
import { buildDayItems, type DayItem } from "../../apps/web/src/today/day-plan-view-model.js";
import {
  EveningReviewSection,
  EveningTomorrowSection
} from "../../apps/web/src/today/evening-mode.js";
import { PracticalNote } from "../../apps/web/src/today/practical-note.js";
import {
  ampm,
  briefingScheduledReason,
  clockLabel,
  clockText,
  eventCaptureText,
  greeting,
  morningHeroKicker,
  preparedAtLabel,
  timeLabel
} from "../../apps/web/src/today/today-labels.js";

// Issue #3393: a Pacific person on 24-hour time sees Pacific 24-hour times on Today and in
// chat starters, while the machine's own clock runs in UTC.
const PACIFIC_24: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};
const PACIFIC_12: LocaleSettingsDto = { ...PACIFIC_24, dateFormat: "12" };

// 22:05Z is 15:05 in Los Angeles (PDT).
const AFTERNOON = "2026-10-10T22:05:00.000Z";

const ambientTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ambientTz === undefined) delete process.env.TZ;
  else process.env.TZ = ambientTz;
});
afterEach(() => {
  vi.useRealTimers();
});

function event(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: "evt-1",
    title: "Design review",
    startsAt: AFTERNOON,
    endsAt: "2026-10-10T23:05:00.000Z",
    allDay: false,
    location: null,
    ...overrides
  } as CalendarEventDto;
}

function render(element: ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));
}

describe("greeting and morning heading follow the person's clock", () => {
  // 15:00Z: afternoon on a UTC machine, 08:00 in Los Angeles.
  const now = new Date("2026-10-10T15:00:00.000Z");

  it("greets by the person's hour, not the machine's", () => {
    expect(greeting("America/Los_Angeles", now)).toBe("Good morning");
  });

  it("calls it the morning briefing before the person's noon", () => {
    expect(morningHeroKicker("Ben", "America/Los_Angeles", now)).toBe(
      "Good morning, Ben / Morning briefing"
    );
  });
});

describe("Today clock labels honour the 24-hour choice", () => {
  it("shows 24-hour digits with no am/pm", () => {
    expect(timeLabel(AFTERNOON, PACIFIC_24)).toBe("15:05");
    expect(ampm(AFTERNOON, PACIFIC_24)).toBe("");
    expect(clockText(AFTERNOON, PACIFIC_24)).toBe("15:05");
    expect(clockText(AFTERNOON, PACIFIC_24, "")).toBe("15:05");
  });

  it("keeps the split 12-hour form for a 12-hour person", () => {
    expect(timeLabel(AFTERNOON, PACIFIC_12)).toBe("3:05");
    expect(ampm(AFTERNOON, PACIFIC_12)).toBe("pm");
    expect(clockText(AFTERNOON, PACIFIC_12)).toBe("3:05 pm");
  });

  it("says Prepared at in 24-hour time", () => {
    expect(preparedAtLabel(AFTERNOON, PACIFIC_24)).toBe("Prepared at 15:05");
    expect(preparedAtLabel(AFTERNOON, { ...PACIFIC_24, region: "de-DE" })).toBe(
      "Prepared at 15:05"
    );
  });

  it("names the event time in the timeline's page-context text", () => {
    expect(eventCaptureText(event(), PACIFIC_24)).toMatch(/^15:05 — Design review/);
  });

  it("renders timeline and day plan times without an am/pm marker", () => {
    const markup = render(createElement(ClockTime, { iso: AFTERNOON, locale: PACIFIC_24 }));
    expect(markup).toBe("15:05");
    expect(render(createElement(ClockTime, { iso: AFTERNOON, locale: PACIFIC_12 }))).toBe(
      '3:05<span class="ap"> pm</span>'
    );
  });

  it("captions day plan blocks and their reasons in 24-hour time", () => {
    // A 30-minute prep block at 15:05 ends at 15:35, when the meeting starts.
    const prep: DayPlanBlockDto = {
      id: "b1",
      kind: "prep",
      taskId: null,
      title: "Prep",
      position: 0,
      actualPlacement: { startsAt: AFTERNOON, durationMinutes: 30, calendarEventRef: null },
      pendingChange: null
    };
    const plan: DayPlanDto = {
      id: "plan-1",
      localDay: "2026-10-10",
      timeZone: PACIFIC_24.timezone,
      revision: 1,
      sourceRunId: null,
      blocks: [prep],
      eveningIntent: {
        priorityTaskIds: [],
        capacity: null,
        notes: null,
        corrections: [],
        commitments: []
      }
    };
    const items = buildDayItems({
      plan,
      tasks: [],
      unavailableTaskIds: [],
      events: [event({ startsAt: "2026-10-10T22:35:00.000Z" })],
      locale: PACIFIC_24,
      now: new Date("2026-10-10T16:00:00.000Z"),
      targetDayKey: "2026-10-10",
      proposedCaption: "short"
    });
    const block = items.find((item) => item.key === "block:b1");
    expect(block?.label).toBe("15:35 · On calendar");
    expect(block?.reason).toBe("For Design review at 15:35");
  });
});

describe("schedule notes and review lines honour the 24-hour choice", () => {
  it("closes the schedule with a 24-hour time", () => {
    const item = {
      key: "a",
      kind: "event",
      kindLabel: null,
      state: "event",
      label: "",
      title: "Design review",
      startsAt: AFTERNOON,
      endsAt: "2026-10-10T23:05:00.000Z",
      durationMinutes: null,
      taskId: null,
      unavailable: false,
      eventId: "evt-1",
      location: null,
      firstProposal: false,
      tag: null,
      reason: null
    } satisfies DayItem;
    expect(buildScheduleGaps([item], PACIFIC_24).closing?.text).toBe(
      "The evening is open. No more commitments after 16:05."
    );
  });

  it("names the practical note's event time in 24-hour time", () => {
    const markup = render(
      createElement(PracticalNote, {
        events: [event({ location: "Main Street" })],
        now: new Date("2026-10-10T16:00:00.000Z"),
        excludeEventId: null,
        locale: PACIFIC_24
      })
    );
    expect(markup).toContain("Design review at 15:05 is at Main Street.");
  });

  it("names a review conflict's times with the person's 12/24-hour choice", () => {
    const conflict = {
      blockId: "b1",
      kind: "calendar_busy",
      withBlockId: null,
      detail: "",
      calendarEvent: {
        eventKey: "k1",
        title: "Design review",
        startsAt: AFTERNOON,
        endsAt: "2026-10-10T23:05:00.000Z",
        accountLabel: "Google"
      }
    } as const;
    expect(conflictText(conflict, PACIFIC_24)).toBe("Overlaps Design review, 15:05 to 16:05");
    expect(conflictText(conflict, PACIFIC_12)).toBe("Overlaps Design review, 3:05 pm to 4:05 pm");
  });
});

describe("briefing schedule times honour the 24-hour choice", () => {
  it("says It runs at 07:00", () => {
    expect(clockLabel("07:00", PACIFIC_24)).toBe("07:00");
    expect(briefingScheduledReason("07:00", false, PACIFIC_24)).toBe("It runs at 07:00.");
    expect(briefingScheduledReason("07:00", false, PACIFIC_12)).toBe("It runs at 7:00 AM.");
  });
});

describe("evening times honour the 24-hour choice", () => {
  function readyAt(locale: LocaleSettingsDto): string {
    return render(
      createElement(EveningReviewSection, {
        kind: "compact",
        run: null,
        locale,
        targetTime: "19:00",
        onFeedbackChanged: () => undefined
      })
    );
  }

  it("says Ready at 19:00", () => {
    expect(readyAt(PACIFIC_24)).toContain("Ready at 19:00");
    expect(readyAt(PACIFIC_12)).toContain("Ready at 7 PM");
  });

  it("shows tomorrow's events in 24-hour time", () => {
    const markup = render(
      createElement(EveningTomorrowSection, {
        dateLabel: "Sunday",
        events: [event()],
        tasks: [] as TaskDto[],
        locale: PACIFIC_24,
        interviewPending: false,
        onPlan: () => undefined,
        onPrep: () => undefined,
        onOpenTask: () => undefined
      })
    );
    expect(markup).toContain("15:05 / Calendar");
  });
});

describe("chat starters honour the 24-hour choice", () => {
  it("names the next event in 24-hour time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T16:00:00.000Z"));
    expect(buildChatSeeds([], [event()], PACIFIC_24)[0]).toBe("Move my 15:05 to tomorrow");
    expect(buildChatSeeds([], [event()], PACIFIC_12)[0]).toBe("Move my 3:05pm to tomorrow");
  });
});
