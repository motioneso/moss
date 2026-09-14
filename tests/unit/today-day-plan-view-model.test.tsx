import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { buildDayItems } from "../../apps/web/src/today/day-plan-view-model.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

// 2026-06-30 in Los Angeles: UTC midnight-07:00. All times below are same-local-day.
const NOW = new Date("2026-06-30T16:00:00.000Z");

function summary(
  overrides: Partial<DayPlanTaskSummary> & { readonly id: string }
): DayPlanTaskSummary {
  return {
    title: `Task ${overrides.id}`,
    status: "todo",
    dueAt: null,
    doAt: null,
    effort: null,
    ...overrides
  };
}

function block(overrides: Partial<DayPlanBlockDto> & { readonly id: string }): DayPlanBlockDto {
  return {
    kind: "focus",
    taskId: null,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

function plan(blocks: DayPlanBlockDto[], eveningIntent = true): DayPlanDto {
  return {
    id: "plan-1",
    localDay: "2026-06-30",
    timeZone: locale.timezone,
    revision: 1,
    sourceRunId: null,
    blocks,
    eveningIntent: eveningIntent
      ? { priorityTaskIds: [], capacity: null, notes: null, corrections: [], commitments: [] }
      : null
  };
}

function event(overrides: Partial<CalendarEventDto> & { readonly id: string }): CalendarEventDto {
  return {
    connectorAccountId: "account-1",
    ownerUserId: "user-1",
    title: `Event ${overrides.id}`,
    startsAt: "2026-06-30T16:30:00.000Z",
    endsAt: "2026-06-30T17:00:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: `ext-${overrides.id}`,
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const base = {
  tasks: [] as DayPlanTaskSummary[],
  unavailableTaskIds: [] as string[],
  events: [] as CalendarEventDto[],
  locale,
  now: NOW
};

describe("buildDayItems state rules", () => {
  it("marks a placed block committed and labels it On the calendar", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({
          id: "b1",
          taskId: "t1",
          position: 0,
          actualPlacement: {
            startsAt: "2026-06-30T17:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "evt-1"
          }
        })
      ]),
      tasks: [summary({ id: "t1", title: "Write the draft" })]
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("committed");
    expect(items[0]?.label).toBe("On the calendar");
    expect(items[0]?.title).toBe("Write the draft");
    expect(items[0]?.startsAt).toBe("2026-06-30T17:00:00.000Z");
    expect(items[0]?.durationMinutes).toBe(60);
  });

  it("marks an unplaced block proposed when the plan has an evening intent", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([block({ id: "b1", taskId: "t1", title: "Draft", position: 0 })]),
      tasks: [summary({ id: "t1", title: "Draft" })]
    });
    expect(items[0]?.state).toBe("proposed");
    expect(items[0]?.label).toBe("Proposed, not on the calendar yet");
    expect(items[0]?.startsAt).toBeNull();
  });

  it("marks an unplaced block proposed when another block is committed", () => {
    const items = buildDayItems({
      ...base,
      plan: plan(
        [
          block({
            id: "b1",
            taskId: "t1",
            position: 0,
            actualPlacement: {
              startsAt: "2026-06-30T17:00:00.000Z",
              durationMinutes: 30,
              calendarEventRef: null
            }
          }),
          block({ id: "b2", taskId: "t2", title: "Later", position: 1 })
        ],
        false
      ),
      tasks: [summary({ id: "t1" }), summary({ id: "t2" })]
    });
    expect(items.find((item) => item.key === "block:b2")?.state).toBe("proposed");
  });

  it("marks a block unscheduled when there is no intent and no committed block", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([block({ id: "b1", taskId: "t1", title: "Loose", position: 0 })], false),
      tasks: [summary({ id: "t1" })]
    });
    expect(items[0]?.state).toBe("unscheduled");
    expect(items[0]?.label).toBe("Unscheduled");
  });

  it("marks a pending-change block pending even when it has a placement", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({
          id: "b1",
          taskId: "t1",
          position: 0,
          actualPlacement: {
            startsAt: "2026-06-30T17:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: null
          },
          pendingChange: {
            kind: "move",
            startsAt: "2026-06-30T19:00:00.000Z",
            durationMinutes: 30
          }
        })
      ]),
      tasks: [summary({ id: "t1" })]
    });
    expect(items[0]?.state).toBe("pending");
    expect(items[0]?.label).toBe("Change pending");
    expect(items[0]?.label).not.toContain("On the calendar");
  });

  it("marks a done task completed and never On the calendar for proposed or pending", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({
          id: "b1",
          taskId: "t1",
          position: 0,
          actualPlacement: {
            startsAt: "2026-06-30T17:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: null
          }
        }),
        block({ id: "b2", taskId: "t2", title: "Draft", position: 1 })
      ]),
      tasks: [summary({ id: "t1", title: "Finished", status: "done" }), summary({ id: "t2" })]
    });
    expect(items.find((item) => item.key === "block:b1")?.state).toBe("completed");
    expect(items.find((item) => item.key === "block:b1")?.label).toBe("Done");
    for (const item of items) {
      if (item.state === "proposed" || item.state === "pending") {
        expect(item.label).not.toContain("On the calendar");
      }
    }
  });
});

describe("buildDayItems joins and ordering", () => {
  it("sorts timed items by start and pushes untimed blocks to the end in position order", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({ id: "late", taskId: "t3", title: "Late", position: 2 }),
        block({
          id: "early",
          taskId: "t1",
          position: 0,
          actualPlacement: {
            startsAt: "2026-06-30T15:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: null
          }
        }),
        block({
          id: "mid",
          taskId: "t2",
          position: 1,
          actualPlacement: {
            startsAt: "2026-06-30T18:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: null
          }
        })
      ]),
      tasks: [summary({ id: "t1" }), summary({ id: "t2" }), summary({ id: "t3" })]
    });
    expect(items.map((item) => item.key)).toEqual(["block:early", "block:mid", "block:late"]);
  });

  it("marks tasks outside the plan response unavailable and renders Untitled block", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({ id: "b1", taskId: "gone", title: "Kept title", position: 0 }),
        block({ id: "b2", taskId: null, title: null, position: 1 })
      ]),
      tasks: [],
      unavailableTaskIds: ["gone"]
    });
    expect(items[0]?.unavailable).toBe(true);
    expect(items[0]?.taskId).toBe("gone");
    expect(items[0]?.title).toBe("Kept title");
    expect(items[1]?.title).toBe("Untitled block");
    expect(items[1]?.startsAt).toBeNull();
  });

  it("never joins a task that is visible in the list but missing from the plan response", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([block({ id: "b1", taskId: "t1", title: null, position: 0 })]),
      tasks: [summary({ id: "other", title: "Visible elsewhere" })]
    });
    expect(items[0]?.title).toBe("Untitled block");
  });

  it("labels preparation and travel kinds and keeps events in the user zone", () => {
    const items = buildDayItems({
      ...base,
      plan: plan([
        block({ id: "prep", kind: "prep", title: "Read the brief", position: 0 }),
        { ...block({ id: "trip", title: "Drive downtown", position: 1 }), kind: "travel" as never }
      ]),
      events: [
        event({
          id: "e1",
          startsAt: "2026-06-30T14:00:00.000Z",
          endsAt: "2026-06-30T14:30:00.000Z"
        }),
        event({
          id: "next",
          startsAt: "2026-07-01T14:00:00.000Z",
          endsAt: "2026-07-01T15:00:00.000Z"
        })
      ]
    });
    expect(items.find((item) => item.key === "block:prep")?.kindLabel).toBe("Preparation");
    expect(items.find((item) => item.key === "block:trip")?.kindLabel).toBe("Travel");
    const eventItems = items.filter((item) => item.state === "event");
    expect(eventItems).toHaveLength(1);
    expect(eventItems[0]?.eventId).toBe("e1");
  });

  it("returns events only when the plan is null", () => {
    const items = buildDayItems({
      ...base,
      plan: null,
      events: [event({ id: "e1" })]
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("event");
  });
});
