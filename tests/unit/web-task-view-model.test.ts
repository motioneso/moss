import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskDto, TaskListDto } from "@moss/shared";
import {
  deriveTaskFilters,
  primaryListSelection,
  groupTasksByQuadrant,
  type ListState
} from "../../apps/web/src/tasks/task-view-model.js";

describe("task view model", () => {
  it("derives visible tasks and list counts in one filter pass", () => {
    const lists = [list("work", "Work"), list("home", "Home")];
    const tasks = [
      task("a", { listId: "work", title: "Send report", tags: ["urgent"], priority: 5 }),
      task("b", { listId: "work", title: "Plan trip", status: "done", tags: ["travel"] }),
      task("c", { listId: "home", title: "Buy paint", tags: ["house"] }),
      task("sub", { listId: "home", title: "Nested", parentTaskId: "c" })
    ];

    const derived = deriveTaskFilters({
      tasks,
      lists,
      statusFilter: "todo",
      focus: null,
      listStates: {},
      tagFilter: [],
      search: "paint"
    });

    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["c"]);
    expect(derived.soloIds).toEqual([]);
    expect(derived.allTags).toEqual(["house", "travel", "urgent"]);
    expect(derived.listCounts).toEqual({ work: 1, home: 1 });
    expect(derived.listCountTotal).toBe(2);
  });

  it("uses Sets for solo lists and tag filters without changing filter semantics", () => {
    const listStates: Record<string, ListState> = { work: "solo", home: "included" };
    const tasks = [
      task("a", { listId: "work", title: "One", tags: ["urgent"] }),
      task("b", { listId: "work", title: "Two", tags: ["house"] }),
      task("c", { listId: "home", title: "Three", tags: ["urgent"] })
    ];

    const derived = deriveTaskFilters({
      tasks,
      lists: [list("work", "Work"), list("home", "Home")],
      statusFilter: "todo",
      focus: null,
      listStates,
      tagFilter: ["urgent"],
      search: ""
    });

    expect(derived.soloIds).toEqual(["work"]);
    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["a"]);
    expect(derived.listCounts).toEqual({ work: 1, home: 1 });
  });

  it("filters by natural-language effort intent", () => {
    const derived = deriveTaskFilters({
      tasks: [
        task("quick", { effort: "quick" }),
        task("medium", { effort: "medium" }),
        task("large", { effort: "large" })
      ],
      lists: [list("work", "Work")],
      statusFilter: "todo",
      focus: null,
      listStates: {},
      tagFilter: [],
      search: "",
      searchIntent: baseIntent({ effort: "medium" })
    });

    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["medium"]);
  });

  it("does not apply the typed sentence as a title filter when the intent has no residual text", () => {
    const derived = deriveTaskFilters({
      tasks: [task("quick", { effort: "quick" }), task("medium", { effort: "medium" })],
      lists: [list("work", "Work")],
      statusFilter: "todo",
      focus: null,
      listStates: {},
      tagFilter: [],
      search: "medium effort tasks",
      searchIntent: baseIntent({ effort: "medium", text: null })
    });

    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["medium"]);
  });

  it("combines natural-language tag intent with literal text", () => {
    const derived = deriveTaskFilters({
      tasks: [
        task("a", { title: "File invoice", tags: ["Invoices"] }),
        task("b", { title: "File receipt", tags: ["Invoices"] }),
        task("c", { title: "File invoice", tags: ["Taxes"] })
      ],
      lists: [list("work", "Work")],
      statusFilter: "todo",
      focus: null,
      listStates: {},
      tagFilter: [],
      search: "invoice",
      searchIntent: baseIntent({ tagNames: ["invoices"], text: "invoice" })
    });

    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["a"]);
  });

  it("composes natural-language priority and quadrant intent with list filters", () => {
    const listStates: Record<string, ListState> = { home: "solo" };
    const derived = deriveTaskFilters({
      tasks: [
        task("a", { listId: "home", priority: 5, dueAt: "2026-06-14T12:00:00.000Z" }),
        task("b", { listId: "home", priority: 5 }),
        task("c", { listId: "work", priority: 5, dueAt: "2026-06-14T12:00:00.000Z" })
      ],
      lists: [list("work", "Work"), list("home", "Home")],
      statusFilter: "todo",
      focus: null,
      listStates,
      tagFilter: [],
      search: "",
      searchIntent: baseIntent({ priority: 5, quadrant: "do" })
    });

    expect(derived.visibleTasks.map((item) => item.id)).toEqual(["a"]);
  });

  it("groups matrix tasks with one pass over the task list", () => {
    const grouped = groupTasksByQuadrant([
      task("do", { priority: 5, dueAt: "2026-06-14T12:00:00.000Z" }),
      task("schedule", { priority: 4 }),
      task("delegate", { priority: 2, dueAt: "2026-06-14T12:00:00.000Z" }),
      task("eliminate", { priority: null })
    ]);

    expect(grouped.do.map((item) => item.id)).toEqual(["do"]);
    expect(grouped.schedule.map((item) => item.id)).toEqual(["schedule"]);
    expect(grouped.delegate.map((item) => item.id)).toEqual(["delegate"]);
    expect(grouped.eliminate.map((item) => item.id)).toEqual(["eliminate"]);
  });
});

describe("matrix quadrant rules under a controlled clock", () => {
  const NOW = new Date("2026-06-14T12:00:00.000Z");
  const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats priority 4+ as important and due within 48 hours, or overdue, as urgent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const grouped = groupTasksByQuadrant([
      task("p4-inside", { priority: 4, dueAt: hoursFromNow(24) }),
      task("p5-at-edge", { priority: 5, dueAt: hoursFromNow(48) }),
      task("p4-outside", { priority: 4, dueAt: hoursFromNow(49) }),
      task("p4-undated", { priority: 4 }),
      task("p3-overdue", { priority: 3, dueAt: hoursFromNow(-30) }),
      task("p3-inside", { priority: 3, dueAt: hoursFromNow(1) }),
      task("p3-outside", { priority: 3, dueAt: hoursFromNow(72) }),
      task("p3-undated", { priority: 3 }),
      task("p5-overdue", { priority: 5, dueAt: hoursFromNow(-2) })
    ]);

    const ids = (key: keyof typeof grouped) => grouped[key].map((item) => item.id).sort();
    expect(ids("do")).toEqual(["p4-inside", "p5-at-edge", "p5-overdue"]);
    expect(ids("schedule")).toEqual(["p4-outside", "p4-undated"]);
    expect(ids("delegate")).toEqual(["p3-inside", "p3-overdue"]);
    expect(ids("eliminate")).toEqual(["p3-outside", "p3-undated"]);
  });
});

function baseIntent(
  overrides: Partial<NonNullable<Parameters<typeof deriveTaskFilters>[0]["searchIntent"]>>
): NonNullable<Parameters<typeof deriveTaskFilters>[0]["searchIntent"]> {
  return {
    text: null,
    status: null,
    effort: null,
    priority: null,
    listIds: [],
    tagNames: [],
    quadrant: null,
    due: null,
    ...overrides
  };
}

const OWNER_ID = "11111111-1111-1111-1111-111111111111";

function list(id: string, name: string): TaskListDto {
  return {
    id,
    ownerUserId: OWNER_ID,
    name,
    position: 0,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z"
  };
}

function task(
  id: string,
  overrides: Partial<Omit<TaskDto, "tags">> & { readonly tags?: readonly string[] } = {}
): TaskDto {
  const tagNames = overrides.tags ?? [];
  return {
    id,
    ownerUserId: OWNER_ID,
    listId: overrides.listId ?? "work",
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? id,
    description: overrides.description ?? null,
    status: overrides.status ?? "todo",
    priority: overrides.priority === undefined ? null : overrides.priority,
    position: overrides.position ?? 0,
    dueAt: overrides.dueAt ?? null,
    doAt: overrides.doAt ?? null,
    effort: overrides.effort ?? null,
    source: overrides.source ?? "manual",
    sourceRef: overrides.sourceRef ?? null,
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-06-14T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-14T00:00:00.000Z",
    tags: tagNames.map((name, index) => ({
      id: `${id}-tag-${index}`,
      ownerUserId: OWNER_ID,
      listId: overrides.listId ?? "work",
      name,
      createdAt: "2026-06-14T00:00:00.000Z"
    })),
    suggestionMetadata: null
  };
}

describe("primary list selection", () => {
  it("reads an untouched or fully included state as all lists", () => {
    expect(primaryListSelection({})).toEqual({ kind: "all" });
    expect(primaryListSelection({ a: "included" })).toEqual({ kind: "all" });
  });

  it("reads a single solo list as that one list", () => {
    expect(primaryListSelection({ a: "solo", b: "included" })).toEqual({ kind: "one", id: "a" });
  });

  it("reports hidden lists and several solo lists as custom", () => {
    expect(primaryListSelection({ a: "excluded" })).toEqual({ kind: "custom" });
    expect(primaryListSelection({ a: "solo", b: "solo" })).toEqual({ kind: "custom" });
    expect(primaryListSelection({ a: "solo", b: "excluded" })).toEqual({ kind: "custom" });
  });
});
