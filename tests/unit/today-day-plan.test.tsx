import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  GetDayPlanResponse,
  LocaleSettingsDto
} from "@moss/shared";

import { DayPlanSection } from "../../apps/web/src/today/day-plan.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const NOW = new Date("2026-06-30T16:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function plan(blocks: DayPlanBlockDto[]): DayPlanDto {
  return {
    id: "plan-1",
    localDay: "2026-06-30",
    timeZone: locale.timezone,
    revision: 1,
    sourceRunId: null,
    blocks,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    }
  };
}

function placed(
  id: string,
  taskId: string | null,
  title: string | null,
  position: number
): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId,
    title,
    position,
    actualPlacement: {
      startsAt: "2026-06-30T17:00:00.000Z",
      durationMinutes: 60,
      calendarEventRef: null
    },
    pendingChange: null
  };
}

function tasks(): DayPlanTaskSummary[] {
  return [
    { id: "t1", title: "Write the draft", status: "todo", dueAt: null, doAt: null, effort: null }
  ];
}

function events(): CalendarEventDto[] {
  return [
    {
      id: "e1",
      connectorAccountId: "account-1",
      ownerUserId: "user-1",
      title: "Standup",
      startsAt: "2026-06-30T16:30:00.000Z",
      endsAt: "2026-06-30T17:00:00.000Z",
      location: "Room A",
      summary: null,
      bodyExcerpt: null,
      externalId: "ext-e1",
      isMossBlock: false,
      allDay: false,
      attendeeCount: 0,
      status: null,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z"
    }
  ];
}

function dayPlanResponse(plan: DayPlanDto | null): GetDayPlanResponse {
  return {
    plan,
    tasks: tasks(),
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  };
}

function render(input: {
  readonly plan?: DayPlanDto | null;
  readonly unavailableTaskIds?: readonly string[];
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly calendarError?: boolean;
  readonly editorial?: boolean;
  readonly showEditorialHeading?: boolean;
  readonly dateline?: string;
  readonly events?: readonly CalendarEventDto[];
  readonly targetDayKey?: string;
}): string {
  const response = dayPlanResponse(input.plan ?? null);
  response.unavailableTaskIds = [...(input.unavailableTaskIds ?? [])];
  return renderToString(
    createElement(DayPlanSection, {
      dayPlan: response,
      events: input.events ?? events(),
      locale,
      now: NOW,
      loading: input.loading ?? false,
      error: input.error ?? false,
      calendarError: input.calendarError ?? false,
      editorial: input.editorial ?? false,
      showEditorialHeading: input.showEditorialHeading,
      dateline: input.dateline,
      targetDayKey: input.targetDayKey,
      onOpenTask: () => undefined
    })
  );
}

/** Base HTML of the plain variant, rendered from the pre-V3 code with the
    same input as the first test. The dialogs keep this byte-for-byte. */
const BASE_PLAIN_HTML = `<section class="jds-brief" id="schedule"><div class="jds-brief__head"><span class="jds-brief__kicker">Walking the day</span></div><div class="jds-brief__title">Schedule and preparation</div><div class="day-list"><div class="day-ev" data-jarvis-capture-text="9:30 am — Standup — Room A — 30m"><div class="day-ev__t">9:30<span class="ap"> <!-- -->am</span></div><div><div class="day-ev__title">Standup</div><div class="day-ev__where">Room A</div></div><div class="day-ev__who">30m</div></div><div class="jds-task" data-state="committed"><div class="day-ev__t">10:00<span class="ap"> <!-- -->am</span></div><div><button type="button" class="jds-task__main"><div class="jds-task__title">Write the draft</div><div class="jds-task__meta"><span class="jds-task__state">On the calendar</span></div></button></div><div class="day-ev__who">1h</div></div></div></section>`;

describe("DayPlanSection", () => {
  it("renders the editorial timeline head, legend and timeline class", () => {
    const html = render({
      plan: plan([placed("b1", "t1", null, 0)]),
      editorial: true,
      dateline: "Tuesday, June 30"
    });
    expect(html).toContain("jds-brief--timeline");
    expect(html).toContain("01");
    expect(html).toContain("Your day, laid out");
    expect(html).toContain("Tuesday, June 30");
    expect(html).toContain("Moss-planned task");
    expect(html).toContain("Calendar commitment");
    expect(html).not.toContain("Schedule and preparation");
    expect(html).toContain("Write the draft");
    expect(html).toContain("On the calendar");
    expect(html).toContain('data-state="committed"');
  });

  it("can omit the editorial heading when the reader supplies the rail heading", () => {
    const html = render({
      plan: plan([placed("b1", "t1", null, 0)]),
      editorial: true,
      showEditorialHeading: false
    });
    expect(html).not.toContain("Your day, laid out");
    expect(html).toContain("Write the draft");
  });

  it("keeps the plain variant byte-identical to the base", () => {
    expect(render({ plan: plan([placed("b1", "t1", null, 0)]) })).toBe(BASE_PLAIN_HTML);
  });

  it("marks every task row with its data-state", () => {
    const html = render({
      plan: plan([
        placed("b1", "t1", null, 0),
        {
          id: "b2",
          kind: "focus",
          taskId: "t1",
          title: null,
          position: 1,
          actualPlacement: null,
          pendingChange: null
        }
      ]),
      editorial: true
    });
    expect(html).toContain('data-state="committed"');
    expect(html).toContain('data-state="proposed"');
    expect(html).toContain("On the calendar");
    expect(html).toContain("Proposed, not on the calendar yet");
  });

  it("renders a proposed block without ever saying On the calendar", () => {
    const html = render({
      plan: plan([
        {
          id: "b1",
          kind: "focus",
          taskId: "t1",
          title: null,
          position: 0,
          actualPlacement: null,
          pendingChange: null
        }
      ])
    });
    expect(html).toContain("Proposed, not on the calendar yet");
    expect(html).not.toContain("On the calendar");
    expect(html).toContain('data-state="proposed"');
    expect(html).toContain("No time yet");
  });

  it("opens the task dialog from a task row but renders unavailable tasks as text", () => {
    const html = render({ plan: plan([placed("b1", "t1", null, 0)]) });
    expect(html).toMatch(/<button[^>]*class="jds-task__main"[^>]*>/);

    const gone = render({
      plan: plan([placed("b1", "gone", "Kept title", 0)]),
      unavailableTaskIds: ["gone"]
    });
    expect(gone).toContain("Task no longer visible");
    expect(gone).not.toMatch(/<button[^>]*class="jds-task__main"[^>]*>/);
  });

  it("keeps calendar events visible with the authored notice when the plan read fails", () => {
    const html = render({ plan: null, error: true });
    expect(html).toContain("Saved plan unavailable; showing calendar events only");
    expect(html).toContain("Standup");
    expect(html).toContain("Room A");
  });

  it("renders the authored empty copy when there is no plan and no events", () => {
    const html = renderToString(
      createElement(DayPlanSection, {
        dayPlan: {
          plan: null,
          tasks: [],
          unavailableTaskIds: [],
          sourceRun: null,
          sourceRunUnavailable: false
        },
        events: [],
        locale,
        now: NOW,
        loading: false,
        error: false,
        calendarError: false,
        onOpenTask: () => undefined
      })
    );
    expect(html).toContain("Nothing on the schedule yet.");
  });

  it("exposes no connector or provider identifiers in the DOM", () => {
    const html = render({ plan: plan([placed("b1", "t1", null, 0)]) });
    expect(html).not.toContain("account-1");
    expect(html).not.toContain("ext-e1");
    expect(html).not.toContain("calendarEventRef");
  });

  it("forwards targetDayKey in loading state and loaded state (VP-TOMORROW-R2)", () => {
    const mixedEvents: CalendarEventDto[] = [
      {
        ...events()[0]!,
        id: "today-evt",
        title: "Today Standup",
        startsAt: "2026-06-30T16:30:00.000Z",
        endsAt: "2026-06-30T17:00:00.000Z"
      },
      {
        ...events()[0]!,
        id: "tmo-evt",
        title: "Tomorrow Planning",
        startsAt: "2026-07-01T16:30:00.000Z",
        endsAt: "2026-07-01T17:00:00.000Z"
      }
    ];

    const loadingTmo = render({
      loading: true,
      events: mixedEvents,
      targetDayKey: "2026-07-01"
    });
    expect(loadingTmo).toContain("Tomorrow Planning");
    expect(loadingTmo).not.toContain("Today Standup");

    const loadingToday = render({
      loading: true,
      events: mixedEvents
    });
    expect(loadingToday).toContain("Today Standup");
    expect(loadingToday).not.toContain("Tomorrow Planning");

    const loadedTmo = render({
      plan: plan([placed("b1", "t1", null, 0)]),
      events: mixedEvents,
      targetDayKey: "2026-07-01"
    });
    expect(loadedTmo).toContain("Tomorrow Planning");
    expect(loadedTmo).not.toContain("Today Standup");
    expect(loadedTmo).toContain("Write the draft");

    const loadedToday = render({
      plan: plan([placed("b1", "t1", null, 0)]),
      events: mixedEvents
    });
    expect(loadedToday).toContain("Today Standup");
    expect(loadedToday).not.toContain("Tomorrow Planning");
  });
});
