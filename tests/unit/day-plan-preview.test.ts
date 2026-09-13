import { describe, expect, it } from "vitest";

import type { DayPlanDto } from "@moss/shared";

import { DayPlanValidationError } from "../../packages/calendar/src/day-plan-model.js";
import {
  buildDayPlanPreview,
  type DayPlanPreviewTaskFact
} from "../../packages/calendar/src/day-plan-preview.js";

function planWith(blocks: DayPlanDto["blocks"]): DayPlanDto {
  return {
    id: "plan-a",
    localDay: "2026-09-12",
    timeZone: "America/Los_Angeles",
    revision: 3,
    sourceRunId: null,
    eveningIntent: null,
    blocks
  };
}

const noTasks: ReadonlyMap<string, DayPlanPreviewTaskFact> = new Map();

describe("buildDayPlanPreview", () => {
  it("reports before and after timing for a moved block without changing the saved values", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: "Write the report",
        position: 0,
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: null
        },
        pendingChange: { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.revision).toBe(3);
    expect(result.blocks).toEqual([
      {
        blockId: "block-a",
        taskId: null,
        changeKind: "move",
        before: { startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 },
        after: { startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 60 },
        eligible: true,
        ineligibleReason: null,
        deadlineRisk: false
      }
    ]);
    expect(result.eligibleBlockIds).toEqual(["block-a"]);
    expect(result.conflicts).toEqual([]);
    expect(result.calendarAvailability).toBe("available");
  });

  it("only previews blocks explicitly selected, leaving others out of the response", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      },
      {
        id: "block-b",
        kind: "focus",
        taskId: null,
        title: null,
        position: 1,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T18:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks.map((block) => block.blockId)).toEqual(["block-a"]);
  });

  it("rejects a selected id that is not part of the plan", () => {
    const plan = planWith([]);
    expect(() =>
      buildDayPlanPreview({
        plan,
        selectedBlockIds: ["missing-block"],
        taskFacts: noTasks,
        busyIntervals: [],
        calendarAvailability: "available",
        calendarAsOf: null,
        now: new Date("2026-09-12T12:00:00.000Z")
      })
    ).toThrow(DayPlanValidationError);
  });

  it("rejects a selected id that has no saved pending change", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 30,
          calendarEventRef: null
        },
        pendingChange: null
      }
    ]);
    expect(() =>
      buildDayPlanPreview({
        plan,
        selectedBlockIds: ["block-a"],
        taskFacts: noTasks,
        busyIntervals: [],
        calendarAvailability: "available",
        calendarAsOf: null,
        now: new Date("2026-09-12T12:00:00.000Z")
      })
    ).toThrow(DayPlanValidationError);
  });

  it("de-duplicates a repeated selected id instead of double-counting it", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a", "block-a"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks).toHaveLength(1);
  });

  it("marks a block ineligible when its task is done", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: "task-a",
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: new Map([["task-a", { status: "done", dueAt: null }]]),
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks[0]).toMatchObject({ eligible: false, ineligibleReason: "task_done" });
    expect(result.eligibleBlockIds).toEqual([]);
  });

  it("marks a block ineligible when its task is archived", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: "task-a",
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: new Map([["task-a", { status: "archived", dueAt: null }]]),
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks[0]).toMatchObject({ eligible: false, ineligibleReason: "task_archived" });
  });

  it("uses the same ineligible reason for a task that does not exist and one owned by someone else", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: "task-missing",
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks[0]).toMatchObject({
      eligible: false,
      ineligibleReason: "task_unavailable"
    });
  });

  it("flags deadline risk when the proposed time ends after the task's due date", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: "task-a",
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T23:45:00.000Z", durationMinutes: 30 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: new Map([["task-a", { status: "other", dueAt: "2026-09-13T00:00:00.000Z" }]]),
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks[0]?.deadlineRisk).toBe(true);
  });

  it("reports a selected_overlap conflict symmetrically for two overlapping selected changes", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 }
      },
      {
        id: "block-b",
        kind: "focus",
        taskId: null,
        title: null,
        position: 1,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:30:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a", "block-b"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.conflicts).toEqual([
      {
        blockId: "block-a",
        kind: "selected_overlap",
        withBlockId: "block-b",
        detail: expect.any(String),
        calendarEvent: null
      },
      {
        blockId: "block-b",
        kind: "selected_overlap",
        withBlockId: "block-a",
        detail: expect.any(String),
        calendarEvent: null
      }
    ]);
  });

  it("reports a calendar_busy conflict against a timed calendar commitment", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [
        {
          start: "2026-09-12T16:30:00.000Z",
          end: "2026-09-12T17:00:00.000Z",
          title: "Team sync",
          accountLabel: "Google",
          eventKey: "meeting-1"
        }
      ],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.conflicts).toEqual([
      {
        blockId: "block-a",
        kind: "calendar_busy",
        withBlockId: null,
        detail: expect.any(String),
        calendarEvent: {
          eventKey: "meeting-1",
          title: "Team sync",
          startsAt: "2026-09-12T16:30:00.000Z",
          endsAt: "2026-09-12T17:00:00.000Z",
          accountLabel: "Google"
        }
      }
    ]);
  });

  it("reports a calendar_busy conflict against a stale-cache calendar commitment", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [
        {
          start: "2026-09-12T16:30:00.000Z",
          end: "2026-09-12T17:00:00.000Z",
          title: "Team sync",
          accountLabel: "Google",
          eventKey: "meeting-1"
        }
      ],
      calendarAvailability: "stale",
      calendarAsOf: "2026-09-12T09:00:00.000Z",
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ blockId: "block-a", kind: "calendar_busy" });
    expect(result.calendarAvailability).toBe("stale");
    expect(result.calendarAsOf).toBe("2026-09-12T09:00:00.000Z");
  });

  it("excludes a block's own already-linked calendar event from calendar_busy conflicts", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: "own-event"
        },
        pendingChange: { kind: "move", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [
        {
          start: "2026-09-12T16:00:00.000Z",
          end: "2026-09-12T17:00:00.000Z",
          title: "Own event",
          accountLabel: "Google",
          eventKey: "own-event"
        }
      ],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.conflicts).toEqual([]);
  });

  it("never reports calendar_busy conflicts when the calendar state is unavailable", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 60 }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [
        {
          start: "2026-09-12T16:30:00.000Z",
          end: "2026-09-12T17:00:00.000Z",
          title: "Team sync",
          accountLabel: "Google",
          eventKey: "meeting-1"
        }
      ],
      calendarAvailability: "unavailable",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.conflicts).toEqual([]);
    expect(result.calendarAvailability).toBe("unavailable");
  });

  it("produces the same result on repeated calls with the same input", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: null,
        title: null,
        position: 0,
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T16:00:00.000Z", durationMinutes: 30 }
      }
    ]);
    const input = {
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: noTasks,
      busyIntervals: [],
      calendarAvailability: "available" as const,
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    };
    expect(buildDayPlanPreview(input)).toEqual(buildDayPlanPreview(input));
  });

  it("treats a removed block as having no after timing and no deadline risk", () => {
    const plan = planWith([
      {
        id: "block-a",
        kind: "focus",
        taskId: "task-a",
        title: null,
        position: 0,
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 30,
          calendarEventRef: null
        },
        pendingChange: { kind: "remove" }
      }
    ]);
    const result = buildDayPlanPreview({
      plan,
      selectedBlockIds: ["block-a"],
      taskFacts: new Map([["task-a", { status: "other", dueAt: "2026-09-12T00:00:00.000Z" }]]),
      busyIntervals: [],
      calendarAvailability: "available",
      calendarAsOf: null,
      now: new Date("2026-09-12T12:00:00.000Z")
    });
    expect(result.blocks[0]).toMatchObject({ after: null, deadlineRisk: false });
  });
});
