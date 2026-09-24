// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEventDto, DayPlanBlockDto, DayPlanDto, TaskDto } from "@moss/shared";

import {
  commitmentRowsFor,
  effortMinutes,
  eveningIntentPatchFor,
  proposeTomorrowBlocks,
  saveStatusLine,
  tomorrowPlanMissing
} from "../../apps/web/src/today/evening-planning-model.js";
import {
  useEveningPlanning,
  type EveningPlanningController
} from "../../apps/web/src/today/evening-planning-controller.js";
import {
  useDayPlanReview,
  type DayPlanReviewController
} from "../../apps/web/src/today/day-plan-review-controller.js";
import { EveningPlanningDialog } from "../../apps/web/src/today/evening-planning.js";
import {
  defaultChoiceFor,
  localTimeToIso
} from "../../apps/web/src/today/day-plan-review-model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TZ = "America/Los_Angeles";
const TODAY = "2026-09-10";
const TMO = "2026-09-11";

function taskDto(id: string, title: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id,
    title,
    status: "todo",
    dueAt: null,
    effort: null,
    ...overrides
  } as unknown as TaskDto;
}

function block(id: string, overrides: Partial<DayPlanBlockDto> = {}): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: null,
    title: null,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

function taskDtos(): TaskDto[] {
  return [
    taskDto("t1", "Write the launch brief", { dueAt: `${TMO}T12:00:00.000Z` }),
    taskDto("t2", "Call the vendor", { dueAt: `${TODAY}T12:00:00.000Z` }),
    taskDto("t3", "File the report"),
    taskDto("t4", "Water the plants", { status: "done" }),
    taskDto("t-cal", "Dentist", { effort: "medium" })
  ];
}

function todayPlan(): DayPlanDto {
  return {
    id: "plan-today",
    localDay: TODAY,
    timeZone: TZ,
    revision: 2,
    sourceRunId: null,
    eveningIntent: null,
    blocks: [
      block("bt1", { taskId: "t1", position: 0 }),
      block("bt2", { taskId: "t2", position: 1 })
    ]
  };
}

function tomorrowPlan(): DayPlanDto {
  return {
    id: "plan-tmo",
    localDay: TMO,
    timeZone: TZ,
    revision: 4,
    sourceRunId: null,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    },
    blocks: [
      block("b-cal", {
        taskId: "t-cal",
        position: 0,
        actualPlacement: {
          startsAt: `${TMO}T14:00:00.000Z`,
          durationMinutes: 60,
          calendarEventRef: "ev-0"
        }
      }),
      block("b-p1", {
        taskId: "t1",
        position: 1,
        pendingChange: { kind: "add", startsAt: `${TMO}T16:00:00.000Z`, durationMinutes: 30 }
      }),
      block("b-p2", {
        taskId: "t2",
        position: 2,
        pendingChange: { kind: "add", startsAt: `${TMO}T18:00:00.000Z`, durationMinutes: 30 }
      })
    ]
  };
}

function events(): CalendarEventDto[] {
  return [
    {
      id: "ev-morn",
      title: "Standup",
      startsAt: `${TMO}T16:00:00.000Z`,
      endsAt: `${TMO}T17:00:00.000Z`,
      allDay: false,
      isMossBlock: false,
      attendeeCount: 0
    } as unknown as CalendarEventDto
  ];
}

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
    capacity: "light" | "normal",
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

describe("saveStatusLine", () => {
  const line = (overrides: object) =>
    saveStatusLine({
      mode: "suggest",
      saved: true,
      applied: 0,
      failed: 0,
      pending: 0,
      deniedReason: null,
      needsConfirm: false,
      ...overrides
    });
  it("names each outcome without claiming readiness early", () => {
    expect(line({ saved: false })).toBe("Not saved yet.");
    expect(line({})).toBe("Saved. The blocks are proposed for the morning.");
    expect(line({ mode: "off" })).toContain("nothing was written");
    expect(line({ mode: "auto", applied: 1 })).toBe("Tomorrow is ready.");
    expect(line({ mode: "auto", pending: 1 })).toContain("1 pending");
    expect(line({ mode: "auto", deniedReason: "busy" })).toContain("busy");
    expect(line({ mode: "auto", needsConfirm: true })).toContain("Confirm");
  });
});

describe("useEveningPlanning", () => {
  const liveRoots: { unmount(): void }[] = [];
  let draftMode = "ok";
  let policyNow: "off" | "suggest" | "auto" = "suggest";
  let savedPlan: DayPlanDto;
  let calls: { method: string; url: string; body: unknown }[] = [];
  const json = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    text: async () => JSON.stringify(data)
  });
  function stubFetch() {
    const responder = async (url: unknown, init?: { method?: string; body?: string }) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url: href, body });
      if (href.endsWith("/api/calendar/briefing-settings")) {
        return json({
          settings: {
            lookaheadDays: 1,
            prepTaskMode: "suggest",
            timeBlockMode: policyNow,
            suggestTasks: true,
            createTasks: false,
            suggestTimeBlocks: true,
            blockTime: false
          }
        });
      }
      if (href.endsWith("/api/calendar/day-plans") && method === "POST")
        return json({ plan: savedPlan });
      if (/\/api\/calendar\/day-plans\/[^/]+\/draft$/.test(href) && method === "PATCH") {
        if (draftMode === "conflict") return json({ error: "changed" }, 409);
        if (draftMode === "error") return json({ error: "down" }, 500);
        savedPlan = { ...savedPlan, revision: savedPlan.revision + 1 };
        return json({ plan: savedPlan });
      }
      if (href.endsWith("/preview") && method === "POST") {
        return json({
          revision: savedPlan.revision,
          calendarAvailability: "available",
          calendarAsOf: `${TMO}T00:00:00.000Z`,
          blocks: [],
          eligibleBlockIds: ["b-p1", "b-p2"],
          conflicts: []
        });
      }
      if (href.endsWith("/apply") && method === "POST") {
        const selected = (body as { selectedBlockIds: string[] }).selectedBlockIds;
        return json({
          operationId: "op-1",
          planId: savedPlan.id,
          status: "completed",
          items: selected.map((blockId) => ({
            itemId: `item-${blockId}`,
            blockId,
            outcome: "applied",
            result: null
          }))
        });
      }
      if (href.includes("/api/tasks/") && method === "PATCH") {
        return json({ task: taskDto("t1", "Write the launch brief") });
      }
      throw new Error(`unexpected fetch ${method} ${href}`);
    };
    globalThis.fetch = vi.fn(responder) as unknown as typeof fetch;
  }
  function EveningHarness(props: {
    plan: DayPlanDto | null;
    missing: boolean;
    active: boolean;
    stub: DayPlanReviewController | null;
    sourceRunId: string | null;
    seen: (c: EveningPlanningController, r: DayPlanReviewController) => void;
  }) {
    const review = useDayPlanReview({
      plan: props.plan ?? tomorrowPlan(),
      localDay: TMO,
      timeZone: TZ,
      morningDefinitionId: "def-morning"
    });
    const evening = useEveningPlanning({
      active: props.active,
      tomorrowKey: TMO,
      todayKey: TODAY,
      timeZone: TZ,
      queryPlan: props.plan,
      planMissing: props.missing,
      sourceRunId: props.sourceRunId,
      todayPlan: todayPlan(),
      tasks: taskDtos(),
      unavailableTaskIds: [],
      tomorrowEvents: [],
      getReview: () => props.stub ?? review
    });
    useEffect(() => {
      props.seen(evening, review);
    }, [evening, review, props]);
    return null;
  }
  interface MountOptions {
    missing?: boolean;
    active?: boolean;
    stub?: DayPlanReviewController | null;
    sourceRunId?: string | null;
  }
  async function mount(queryPlan: DayPlanDto | null, options: MountOptions = {}) {
    let latest: EveningPlanningController | null = null;
    let liveReview: DayPlanReviewController | null = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    const seen = (c: EveningPlanningController, r: DayPlanReviewController) => {
      latest = c;
      liveReview = r;
    };
    const render = (plan: DayPlanDto | null, active: boolean) =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(EveningHarness, {
            plan,
            missing: options.missing ?? false,
            active,
            stub: options.stub ?? null,
            sourceRunId: options.sourceRunId ?? null,
            seen
          })
        )
      );
    await act(async () => {
      render(queryPlan, options.active ?? true);
    });
    if (!latest || !liveReview) throw new Error("hook did not render");
    return {
      current: () => latest as EveningPlanningController,
      review: () => liveReview as DayPlanReviewController,
      rerender: async (plan: DayPlanDto | null = queryPlan, active = true) => {
        await act(async () => {
          render(plan, active);
        });
      }
    };
  }
  const draftSaves = () =>
    calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/draft")).length;
  const previews = () => calls.filter((c) => c.url.endsWith("/preview")).length;
  const applies = () => calls.filter((c) => c.url.endsWith("/apply")).length;
  const taskWrites = () => calls.filter((c) => c.url.includes("/api/tasks/"));
  const draftBody = () =>
    calls.find((c) => c.method === "PATCH" && c.url.endsWith("/draft"))?.body as {
      eveningIntent?: { corrections?: { taskId: string; note: string; source: string }[] };
      blocks?: { id?: string; taskId: string | null; pendingChange?: { kind?: string } | null }[];
    };
  beforeEach(() => {
    savedPlan = tomorrowPlan();
    draftMode = "ok";
    policyNow = "suggest";
    calls = [];
    stubFetch();
  });
  afterEach(async () => {
    for (const root of liveRoots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
  it("creates the missing plan, then saves the draft once", async () => {
    const m = await mount(null, { missing: true });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(draftSaves()).toBe(1);
    expect(m.current().status).toBe("Saved. The blocks are proposed for the morning.");
  });
  it("suggest mode saves once and never previews or applies", async () => {
    const m = await mount(tomorrowPlan());
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(draftSaves()).toBe(1);
    expect(previews()).toBe(0);
    expect(applies()).toBe(0);
  });
  it("off mode writes the draft and names the setting", async () => {
    policyNow = "off";
    const m = await mount(tomorrowPlan());
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(previews()).toBe(0);
    expect(applies()).toBe(0);
    expect(m.current().status).toBe("Saved. The calendar is off, so nothing was written to it.");
  });
  it("auto mode previews once and applies once, then reports readiness", async () => {
    policyNow = "auto";
    const m = await mount(tomorrowPlan());
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    await m.rerender(savedPlan);
    expect(previews()).toBe(1);
    expect(applies()).toBe(1);
    expect(m.current().status).toBe("Tomorrow is ready.");
  });
  it("switching auto to suggest keeps committed blocks and emits no removal", async () => {
    policyNow = "auto";
    const m = await mount(tomorrowPlan());
    policyNow = "suggest";
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(previews()).toBe(0);
    expect(applies()).toBe(0);
    const rows = draftBody()?.blocks ?? [];
    expect(rows.some((row) => row.taskId === "t1" && row.pendingChange?.kind === "add")).toBe(true);
    expect(rows.some((row) => row.pendingChange?.kind === "remove")).toBe(false);
  });
  it("counts only outcomes from its own activation", async () => {
    const stub = {
      revision: 5,
      choiceFor: defaultChoiceFor,
      touchedIds: [],
      outcomes: {
        "old-block": { itemId: "item-old", blockId: "old-block", outcome: "applied", result: null }
      },
      notice: null,
      approval: null,
      expectOwnWrite: vi.fn(),
      apply: vi.fn(),
      confirm: vi.fn(),
      acceptAllAdditions: vi.fn(),
      dismissApproval: vi.fn()
    } as unknown as DayPlanReviewController;
    const m = await mount(tomorrowPlan(), { stub });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(m.current().status).toBe("Saved. The blocks are proposed for the morning.");
  });
  it("marks its own draft save so the review does not call it a stale plan", async () => {
    const expectOwnWrite = vi.fn();
    const stub = {
      revision: 5,
      choiceFor: defaultChoiceFor,
      touchedIds: [],
      outcomes: {},
      notice: null,
      approval: null,
      expectOwnWrite,
      apply: vi.fn(),
      confirm: vi.fn(),
      acceptAllAdditions: vi.fn(),
      dismissApproval: vi.fn()
    } as unknown as DayPlanReviewController;
    const m = await mount(tomorrowPlan(), { stub });
    await act(async () => {
      await m.current().save();
    });
    expect(expectOwnWrite).toHaveBeenCalledTimes(1);

    draftMode = "conflict";
    await act(async () => {
      await m.current().save();
    });
    expect(expectOwnWrite).toHaveBeenCalledTimes(1);
  });
  it("sends one block per task and drops replaced proposals", async () => {
    const m = await mount(tomorrowPlan());
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    const rows = draftBody()?.blocks ?? [];
    expect(rows.filter((row) => row.taskId === "t1").length).toBe(1);
    expect(rows.some((row) => row.id === "b-p1")).toBe(false);
    expect(rows.some((row) => row.id === "b-p2")).toBe(false);
    expect(rows.some((row) => row.id === "b-cal")).toBe(true);
  });
  it("a lighter day removes unselected proposals", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.current().setCapacity("light");
    });
    await act(async () => {
      m.current().setPriority(["t1"]);
    });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    const rows = draftBody()?.blocks ?? [];
    expect(rows.some((row) => row.taskId === "t2")).toBe(false);
    expect(rows.filter((row) => row.taskId === "t1").length).toBe(1);
  });
  it("a failed move blocks the ready line", async () => {
    policyNow = "auto";
    const stub = {
      revision: 5,
      choiceFor: (block: DayPlanBlockDto) =>
        block.id === "b-cal"
          ? { placement: "move", startsAt: `${TMO}T15:00:00.000Z` }
          : defaultChoiceFor(block),
      touchedIds: ["b-cal"],
      outcomes: {
        "b-cal": { itemId: "item-b-cal", blockId: "b-cal", outcome: "failed", result: null }
      },
      notice: null,
      approval: null,
      expectOwnWrite: vi.fn(),
      apply: vi.fn(),
      confirm: vi.fn(),
      acceptAllAdditions: vi.fn(),
      dismissApproval: vi.fn()
    } as unknown as DayPlanReviewController;
    const m = await mount(tomorrowPlan(), { stub });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(m.current().status).toBe("Saved. Applied 0; 1 failed; 0 pending.");
  });
  it("keeps a review-edited proposal time through the save", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.review().setPlacement("b-p1", "add", `${TMO}T18:00:00.000Z`);
    });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    const rows = draftBody()?.blocks ?? [];
    const edited = rows.find((row) => row.id === "b-p1")?.pendingChange as {
      kind?: string;
      startsAt?: string;
    } | null;
    expect(edited?.kind).toBe("add");
    expect(edited?.startsAt).toBe(`${TMO}T18:00:00.000Z`);
    expect(rows.filter((row) => row.taskId === "t1").length).toBe(1);
  });
  it("passes the evening run id when creating tomorrow's plan", async () => {
    const m = await mount(null, { missing: true, sourceRunId: "run-evening-1" });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    const created = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/calendar/day-plans")
    );
    expect((created?.body as { sourceRunId?: string | null })?.sourceRunId).toBe("run-evening-1");
  });
  it("keeps choices visible when the saved plan changed", async () => {
    draftMode = "conflict";
    const m = await mount(tomorrowPlan());
    let ok = true;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(false);
    expect(m.current().status).toBe(
      "The saved plan changed since it was read. Choices kept; save again."
    );
  });
  it("reports a failed save without losing the dialog", async () => {
    draftMode = "error";
    const m = await mount(tomorrowPlan());
    let ok = true;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(false);
    expect(m.current().status).toBe("Save failed. Check the connection and try again.");
  });
  it("asks for another save when the confirmation expired", async () => {
    const m = await mount(tomorrowPlan());
    let ok = true;
    await act(async () => {
      ok = await m.current().confirmSave();
    });
    expect(ok).toBe(false);
    expect(m.current().status).toBe("The confirmation expired. Review the changes and save again.");
  });
  it("cancelling keeps the saved draft and leaves the calendar alone", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.current().cancelConfirm();
    });
    expect(m.current().status).toBe("Saved draft kept. The calendar is unchanged.");
  });
  it("a correction travels in the draft and touches no task", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.current().setNote("t3", "Need the figures");
    });
    await act(async () => {
      m.current().addCorrectionFor("t3");
    });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(draftBody()?.eveningIntent?.corrections).toEqual([
      { taskId: "t3", note: "Need the figures", source: "actor" }
    ]);
    expect(taskWrites().length).toBe(0);
  });
  it("block times and tomorrow choices write no task field", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.review().setTime("b-p1", `${TMO}T10:00:00.000Z`);
    });
    await act(async () => {
      m.current().setDecision("t1", "tomorrow");
    });
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(taskWrites().length).toBe(0);
  });
  it("writes the due date exactly once with the chosen date", async () => {
    const m = await mount(tomorrowPlan());
    let ok = true;
    await act(async () => {
      ok = await m.current().changeDueDate("t1");
    });
    expect(ok).toBe(false);
    await act(async () => {
      m.current().setDateFor("t1", "not-a-date");
    });
    await act(async () => {
      ok = await m.current().changeDueDate("t1");
    });
    expect(ok).toBe(false);
    expect(m.current().status).toBe("Pick a valid date first.");
    await act(async () => {
      m.current().setDateFor("t1", TMO);
    });
    await act(async () => {
      ok = await m.current().changeDueDate("t1");
    });
    expect(ok).toBe(true);
    const writes = taskWrites();
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ body: { dueAt: localTimeToIso(TMO, "00:00", TZ) } });
  });
  it("close and reopen keep a typed correction and a changed capacity", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.current().setNote("t3", "Need the figures");
    });
    await act(async () => {
      m.current().addCorrectionFor("t3");
    });
    await act(async () => {
      m.current().setCapacity("light");
    });
    await m.rerender(tomorrowPlan(), false);
    await m.rerender(tomorrowPlan(), true);
    expect(m.current().activeCapacity).toBe("light");
    expect(m.current().status).toBe("Not saved yet.");
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(draftBody()?.eveningIntent?.corrections).toEqual([
      { taskId: "t3", note: "Need the figures", source: "actor" }
    ]);
  });
  it("a fresh mount shows the saved intent", async () => {
    const plan = tomorrowPlan();
    plan.eveningIntent = {
      priorityTaskIds: ["t1"],
      capacity: "light",
      notes: "hello",
      corrections: [],
      commitments: []
    };
    const m = await mount(plan);
    expect(m.current().activeCapacity).toBe("light");
    expect(m.current().activeNotes).toBe("hello");
    expect(m.current().activePriority).toEqual(["t1"]);
  });

  it("EveningPlanningDialog passes tomorrowKey to DayPlanSection so tomorrowEvents appear in rail (VP-TOMORROW-R2)", async () => {
    const m = await mount(tomorrowPlan());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);

    const tomorrowEvt = {
      id: "tmo-evt-1",
      connectorAccountId: "acc-1",
      ownerUserId: "u-1",
      title: "Tomorrow Strategy Sync",
      startsAt: `${TMO}T17:00:00.000Z`,
      endsAt: `${TMO}T18:00:00.000Z`,
      allDay: false,
      isMossBlock: false,
      attendeeCount: 0
    } as unknown as CalendarEventDto;

    const todayEvt = {
      id: "today-evt-1",
      connectorAccountId: "acc-1",
      ownerUserId: "u-1",
      title: "Today Retro",
      startsAt: `${TODAY}T17:00:00.000Z`,
      endsAt: `${TODAY}T18:00:00.000Z`,
      allDay: false,
      isMossBlock: false,
      attendeeCount: 0
    } as unknown as CalendarEventDto;

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(EveningPlanningDialog, {
            evening: m.current(),
            review: {} as DayPlanReviewController,
            tasks: taskDtos(),
            taskSummaries: [],
            unavailableTaskIds: [],
            tomorrowEvents: [todayEvt, tomorrowEvt],
            completedToday: [],
            locale: { timezone: TZ, region: "en-US", dateFormat: "12" },
            now: new Date(`${TODAY}T12:00:00.000Z`),
            tomorrowKey: TMO,
            eveningRun: null,
            opener: null,
            onClose: () => undefined,
            onOpenTask: () => undefined
          })
        )
      );
    });

    const rail = document.body.querySelector(".evening-plan__railwrap");
    expect(rail).not.toBeNull();
    expect(rail?.textContent).toContain("Tomorrow Strategy Sync");
    expect(rail?.textContent).not.toContain("Today Retro");
  });

  it("preserves reflection selection across a rerender", async () => {
    const m = await mount(tomorrowPlan());
    expect(m.current().reflection).toBeNull();
    await act(async () => {
      m.current().setReflection("unsent");
    });
    expect(m.current().reflection).toBe("unsent");
    await m.rerender();
    expect(m.current().reflection).toBe("unsent");
  });

  it("lands added notes in saved intent notes without writing tasks", async () => {
    const m = await mount(tomorrowPlan());
    await act(async () => {
      m.current().addNote("First note to keep");
      m.current().addNote("   ");
      m.current().addNote("Second note to remember");
    });
    expect(m.current().activeNotes).toBe("First note to keep\nSecond note to remember");
    expect(taskWrites().length).toBe(0);
    let ok = false;
    await act(async () => {
      ok = await m.current().save();
    });
    expect(ok).toBe(true);
    expect(draftSaves()).toBe(1);
    expect(taskWrites().length).toBe(0);
    const body = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/draft"))?.body as {
      eveningIntent?: { notes?: string | null };
    };
    expect(body.eveningIntent?.notes).toBe("First note to keep\nSecond note to remember");
  });
});
