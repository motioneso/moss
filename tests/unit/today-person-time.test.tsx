import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CalendarEventDto, LocaleSettingsDto, TaskDto } from "@moss/shared";

import { buildChatSeeds } from "../../apps/web/src/chat/seeds.js";
import { ClockTime } from "../../apps/web/src/today/clock-time.js";
import { buildDayItems } from "../../apps/web/src/today/day-plan-view-model.js";
import {
  EveningReviewSection,
  EveningTomorrowSection
} from "../../apps/web/src/today/evening-mode.js";
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
  process.env.TZ = ambientTz;
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

  it("captions day plan items in 24-hour time", () => {
    const items = buildDayItems({
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      events: [event()],
      locale: PACIFIC_24,
      now: new Date("2026-10-10T16:00:00.000Z")
    });
    const text = JSON.stringify(items);
    expect(text).not.toMatch(/\b(am|pm)\b/i);
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
