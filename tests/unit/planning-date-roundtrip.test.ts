// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TaskDto } from "@moss/shared";
import {
  buildTaskFields,
  blankTaskDetailsForm,
  formFromTask
} from "../../apps/web/src/tasks/task-details-model.js";
import { fromDateInputValue } from "../../apps/web/src/tasks/task-format.js";
import { navigateCursor, plainDate } from "../../apps/web/src/calendar/calendar-model.js";

const task: TaskDto = {
  id: "task-date",
  ownerUserId: "owner",
  listId: "personal",
  parentTaskId: null,
  title: "Keep the chosen date",
  description: null,
  status: "todo",
  priority: null,
  position: 0,
  dueAt: null,
  doAt: null,
  effort: null,
  source: "manual",
  sourceRef: null,
  completedAt: null,
  createdAt: null,
  updatedAt: null,
  tags: [],
  suggestionMetadata: null
};

describe("date-only task intent", () => {
  it("rejects an invalid timezone instead of silently using the machine clock", () => {
    expect(fromDateInputValue("2026-10-11", "Not/A_Timezone")).toBeNull();
  });
  it.each([
    ["Pacific/Kiritimati", "2026-10-11"],
    ["Pacific/Auckland", "2026-06-01"],
    ["Pacific/Auckland", "2026-09-27"],
    ["America/Los_Angeles", "2026-03-08"],
    ["America/Los_Angeles", "2026-11-01"],
    ["UTC", "2026-12-31"]
  ])("round-trips due date, reminder and repeat anchor in %s on %s", (zone, date) => {
    const form = {
      ...blankTaskDetailsForm(task.listId),
      title: task.title,
      dueAt: date,
      doAt: date,
      repeat: "weekly" as const
    };
    const fields = buildTaskFields(form, task.listId, zone);
    const reopened = formFromTask(
      { ...task, ...fields, listId: task.listId, title: task.title },
      zone
    );
    expect(reopened.dueAt).toBe(date);
    expect(reopened.doAt).toBe(date);
    expect(fields.recurrence?.occurrence_date).toBe(date);
  });
});

describe("calendar month navigation", () => {
  it.each([
    [2026, 9, 31, 1, 2026, 10],
    [2026, 2, 31, -1, 2026, 1],
    [2024, 0, 31, 1, 2024, 1],
    [2026, 11, 31, 1, 2027, 0],
    [2026, 0, 31, -1, 2025, 11]
  ])(
    "moves exactly one month from %i-%i-%i by %i",
    (year, month, day, direction, expectedYear, expectedMonth) => {
      const next = navigateCursor(plainDate(year, month, day), "month", direction as -1 | 1);
      expect(next.getUTCFullYear()).toBe(expectedYear);
      expect(next.getUTCMonth()).toBe(expectedMonth);
    }
  );
  it("keeps day and week navigation independent of month lengths", () => {
    const cursor = plainDate(2026, 9, 31);
    expect(navigateCursor(cursor, "day", 1).getUTCDate()).toBe(1);
    expect(navigateCursor(cursor, "week", 1).getUTCDate()).toBe(7);
    expect(cursor.getUTCDate()).toBe(31);
  });
});
