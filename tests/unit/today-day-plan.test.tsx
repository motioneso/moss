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
}): string {
  const response = dayPlanResponse(input.plan ?? null);
  response.unavailableTaskIds = [...(input.unavailableTaskIds ?? [])];
  return renderToString(
    createElement(DayPlanSection, {
      dayPlan: response,
      events: events(),
      locale,
      now: NOW,
      loading: input.loading ?? false,
      error: input.error ?? false,
      onOpenTask: () => undefined
    })
  );
}

describe("DayPlanSection", () => {
  it("renders plan rows with state text and data-state", () => {
    const html = render({ plan: plan([placed("b1", "t1", null, 0)]) });
    expect(html).toContain("Schedule and preparation");
    expect(html).toContain("Write the draft");
    expect(html).toContain("On the calendar");
    expect(html).toContain('data-state="committed"');
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
});
