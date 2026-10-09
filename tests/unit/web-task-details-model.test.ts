import { describe, expect, it } from "vitest";

import type { TaskDto } from "@moss/shared";

import {
  buildTaskFields,
  blankTaskDetailsForm,
  formFromTask
} from "../../apps/web/src/tasks/task-details-model.js";
import { toDateInputValue } from "../../apps/web/src/tasks/task-format.js";

describe("task details model", () => {
  // #877 finding 3: toDateInputValue used to slice the UTC day, so the due-date
  // edit form could show a different calendar day than the list label (which
  // reads task-view-model.ts's `localDay(dueAt, tz)`) near local midnight. It
  // must now bucket by the same persisted-locale timezone as the list label.
  it("buckets the due-date input by the given timezone, not UTC", () => {
    // 2026-07-09T04:00:00Z is 9 PM PT on 7/8 — the local day is a day behind UTC.
    expect(toDateInputValue("2026-07-09T04:00:00Z", "America/Los_Angeles")).toBe("2026-07-08");
    expect(toDateInputValue("2026-07-09T04:00:00Z", "UTC")).toBe("2026-07-09");
  });

  it("returns an empty string for a null due date regardless of timezone", () => {
    expect(toDateInputValue(null, "America/Los_Angeles")).toBe("");
  });

  it("builds the task write payload from explicit form state", () => {
    const fields = buildTaskFields(
      {
        ...blankTaskDetailsForm("list-a"),
        title: "  Renew passport  ",
        description: "",
        priority: "4",
        dueAt: "2026-07-01",
        effort: "medium",
        repeat: "weekly"
      },
      "list-fallback"
    );

    expect(fields).toMatchObject({
      title: "Renew passport",
      description: null,
      status: "todo",
      priority: 4,
      effort: "medium",
      listId: "list-a",
      recurrence: {
        freq: "weekly",
        interval: 1,
        occurrence_date: "2026-07-01"
      }
    });
    expect(fields.dueAt).toContain("2026-07-01");
    expect(fields.recurrence).not.toHaveProperty("until");
  });

  it("falls back to a default list and clears recurrence when repeat is never", () => {
    const fields = buildTaskFields(
      { ...blankTaskDetailsForm(), title: "", listId: "", repeat: "never" },
      "default-list"
    );

    expect(fields.title).toBe("Untitled task");
    expect(fields.listId).toBe("default-list");
    expect(fields.recurrence).toBeNull();
  });

  it("seeds the repeat choice from the stored recurrence and keeps it when unchanged", () => {
    const recurrence = { freq: "weekly", interval: 2, occurrence_date: "2026-07-01" } as const;
    const form = formFromTask(
      { ...storedTask(), dueAt: "2026-07-01T00:00:00.000Z", recurrence },
      "UTC"
    );

    expect(form.repeat).toBe("weekly");
    expect(buildTaskFields(form).recurrence).toEqual(recurrence);
    expect(buildTaskFields({ ...form, repeat: "monthly" }).recurrence).toMatchObject({
      freq: "monthly",
      interval: 1
    });
    expect(buildTaskFields({ ...form, repeat: "never" }).recurrence).toBeNull();
  });
});

function storedTask(): TaskDto {
  return {
    id: "t1",
    ownerUserId: "u1",
    listId: "l1",
    parentTaskId: null,
    title: "Stored",
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
}
