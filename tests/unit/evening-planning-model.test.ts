import { describe, expect, it } from "vitest";
import type { CalendarEventDto, DayPlanBlockDto } from "@moss/shared";

import {
  commitmentRowsFor,
  effortMinutes,
  eveningIntentPatchFor,
  proposeTomorrowBlocks,
  tomorrowPlanMissing
} from "../../apps/web/src/today/evening-planning-model.js";
import {
  TMO,
  TZ,
  block,
  events,
  taskDto,
  taskDtos,
  todayPlan,
  tomorrowPlan
} from "./evening-planning-fixtures.js";

describe("commitmentRowsFor", () => {
  const rows = () => commitmentRowsFor(todayPlan(), tomorrowPlan(), taskDtos(), [], TMO, TZ);
  const byId = (list: ReturnType<typeof rows>) => new Map(list.map((row) => [row.task.id, row]));

  it("derives rows from today blocks and due dates, decided by tomorrow due or saved intent", () => {
    const found = byId(rows());
    expect(found.get("t1")?.decided).toBe("tomorrow");
    expect(found.get("t2")?.decided).toBe(null);
    expect(found.get("t3")?.decided).toBe(undefined);
  });

  it("dedupes tasks shared by blocks and due lists", () => {
    const ids = rows().map((row) => row.task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks done, archived and unavailable tasks with no choice", () => {
    const plan = todayPlan();
    plan.blocks = [
      block("bx", { taskId: "t4" }),
      block("by", { taskId: "t9" }),
      block("bz", { taskId: "t2" })
    ];
    const archived = taskDto("t9", "Old", { status: "archived" });
    const tasks = [archived, ...taskDtos()];
    const found = byId(commitmentRowsFor(plan, tomorrowPlan(), tasks, ["t2"], TMO, TZ));
    expect(found.get("t4")?.marked).toBe("done");
    expect(found.get("t9")?.marked).toBe("archived");
    expect(found.get("t2")?.marked).toBe("unavailable");
  });

  it("prefers saved commitments over undecided", () => {
    const plan = tomorrowPlan();
    plan.eveningIntent = {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: [{ taskId: "t2", decision: "defer" }]
    };
    const found = byId(commitmentRowsFor(todayPlan(), plan, taskDtos(), [], TMO, TZ));
    expect(found.get("t2")?.decided).toBe("another-date");
    for (const [decision, decided] of [
      ["commit", "tomorrow"],
      ["drop", "unscheduled"]
    ] as const) {
      plan.eveningIntent = {
        priorityTaskIds: [],
        capacity: null,
        notes: null,
        corrections: [],
        commitments: [{ taskId: "t2", decision }]
      };
      const rows = byId(commitmentRowsFor(todayPlan(), plan, taskDtos(), [], TMO, TZ));
      expect(rows.get("t2")?.decided).toBe(decided);
    }
  });
});

describe("proposeTomorrowBlocks", () => {
  const tasks = taskDtos();
  const propose = (
    blocks: DayPlanBlockDto[],
    committed: string[],
    priority: string[],
    capacity: "light" | "normal" | "full",
    start: string,
    evts = events()
  ) => proposeTomorrowBlocks(blocks, committed, priority, capacity, start, tasks, evts, TMO, TZ);

  it("keeps placed blocks and saved moves, replaces only proposed additions", () => {
    const out = propose(tomorrowPlan().blocks, ["t1"], [], "normal", "09:00");
    expect(out.find((row) => row.id === "b-cal")?.pendingChange ?? null).toBe(null);
    expect(out.some((row) => row.id === "b-p2")).toBe(false);
    expect(out.filter((row) => row.taskId === "t1").length).toBe(1);
  });

  it("lighter day proposes only the priority task and drops the rest", () => {
    expect(propose([], ["t1", "t2"], ["t1"], "light", "09:00").map((row) => row.taskId)).toEqual([
      "t1"
    ]);
  });

  it("places the proposal after the overlapping event", () => {
    expect(propose([], ["t3"], [], "normal", "09:00")[0]?.pendingChange).toMatchObject({
      kind: "add",
      startsAt: `${TMO}T17:00:00.000Z`,
      durationMinutes: 60
    });
  });

  it("yields a timeless proposal when the day has no room", () => {
    const morning = events()[0] as CalendarEventDto;
    const full = [
      { ...morning, startsAt: `${TMO}T07:00:00.000Z`, endsAt: "2026-09-12T07:00:00.000Z" }
    ];
    expect(propose([], ["t3"], [], "normal", "09:00", full)[0]?.pendingChange ?? null).toBe(null);
  });

  it("uses the effort duration and falls back to 60 minutes", () => {
    expect(effortMinutes("quick")).toBe(30);
    expect(effortMinutes("large")).toBe(120);
    expect(effortMinutes(null)).toBe(60);
    expect(propose([], ["t-cal"], [], "normal", "11:00", [])[0]?.pendingChange).toMatchObject({
      durationMinutes: 60
    });
  });

  it("keeps placed blocks by id and covers no task twice", () => {
    const out = propose(tomorrowPlan().blocks, ["t1", "t-cal"], [], "normal", "09:00", []);
    expect(out.find((row) => row.id === "b-cal")?.taskId).toBe("t-cal");
    expect(out.filter((row) => row.taskId === "t-cal").length).toBe(1);
    expect(out.filter((row) => row.taskId === "t1").length).toBe(1);
  });

  it("lighter day keeps placed blocks and the priority commitment, drops the rest", () => {
    const out = propose(tomorrowPlan().blocks, ["t1", "t2"], ["t1"], "light", "09:00", []);
    expect(out.find((row) => row.id === "b-cal")?.taskId).toBe("t-cal");
    expect(out.filter((row) => row.taskId === "t1").length).toBe(1);
    expect(out.some((row) => row.taskId === "t2")).toBe(false);
  });

  it("lighter day proposes only the first priority when two tasks are committed (T22, T20 follow-up)", () => {
    const light = propose([], ["t1", "t2"], ["t1", "t2"], "light", "09:00", []).map(
      (row) => row.taskId
    );
    expect(light).toEqual(["t1"]);
    const normal = propose([], ["t1", "t2"], ["t1", "t2"], "normal", "09:00", []).map(
      (row) => row.taskId
    );
    expect(normal).toEqual(["t1", "t2"]);
  });

  it("full day uses open time for every selected commitment beyond the steady-day pair", () => {
    const commitments = ["t1", "t2", "t3"];
    const normal = propose([], commitments, ["t1"], "normal", "09:00", []);
    const full = propose([], commitments, ["t1"], "full", "09:00", []);
    expect(
      normal.filter((row) => row.pendingChange?.kind === "add").map((row) => row.taskId)
    ).toEqual(["t1", "t2"]);
    expect(
      full.filter((row) => row.pendingChange?.kind === "add").map((row) => row.taskId)
    ).toEqual(commitments);
  });

  it("emits placeable rows only, and zero blocks is valid", () => {
    const out = propose([], ["t1"], [], "normal", "09:00", []);
    expect(out.length).toBe(1);
    for (const row of out) {
      expect("actualPlacement" in row).toBe(false);
      expect("position" in row).toBe(false);
    }
    expect(propose([], [], [], "normal", "09:00", [])).toEqual([]);
  });
});

describe("eveningIntentPatchFor", () => {
  it("sends only changed fields and appends corrections as actor notes", () => {
    const unchanged = {
      corrections: [],
      commitments: [],
      capacity: null,
      priorityTaskIds: null,
      notes: null
    };
    expect(eveningIntentPatchFor(tomorrowPlan().eveningIntent, unchanged)).toEqual({});
    const patch = eveningIntentPatchFor(tomorrowPlan().eveningIntent, {
      corrections: [{ taskId: "t1", note: "Scope slipped" }],
      commitments: [{ taskId: "t2", decision: "another-date" }],
      capacity: "light",
      priorityTaskIds: ["t1"],
      notes: "Ship it"
    });
    expect(patch.corrections).toEqual([{ taskId: "t1", note: "Scope slipped", source: "actor" }]);
    expect(patch.commitments).toEqual([{ taskId: "t2", decision: "defer" }]);
    expect(patch.capacity).toBe("light");
  });

  it("merges commitments by task over the saved list", () => {
    const saved = tomorrowPlan().eveningIntent!;
    saved.commitments = [{ taskId: "t2", decision: "commit" }];
    const patch = eveningIntentPatchFor(saved, {
      corrections: [],
      commitments: [{ taskId: "t2", decision: "unscheduled" }],
      capacity: null,
      priorityTaskIds: null,
      notes: null
    });
    expect(patch.commitments).toEqual([{ taskId: "t2", decision: "drop" }]);
  });
});

describe("tomorrowPlanMissing", () => {
  it("treats a loaded null plan as missing without a 404", () => {
    expect(tomorrowPlanMissing({ plan: null }, null)).toBe(true);
    expect(tomorrowPlanMissing({ plan: tomorrowPlan() }, null)).toBe(false);
    expect(tomorrowPlanMissing(undefined, { status: 404 })).toBe(true);
    expect(tomorrowPlanMissing(undefined, null)).toBe(false);
    expect(tomorrowPlanMissing(undefined, { status: 500 })).toBe(false);
  });
});
