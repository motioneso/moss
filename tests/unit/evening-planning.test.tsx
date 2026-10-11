// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEventDto, DayPlanDto } from "@moss/shared";

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

import {
  TMO,
  TODAY,
  TZ,
  block,
  taskDto,
  taskDtos,
  todayPlan,
  tomorrowPlan
} from "./evening-planning-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useEveningPlanning", () => {
  const liveRoots: { unmount(): void }[] = [];
  let draftMode = "ok";
  let applyOutcome: "applied" | "failed" = "applied";
  let previewMode: "available" | "conflict" | "unavailable" = "available";
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
        const unavailable = previewMode === "unavailable";
        return json({
          revision: savedPlan.revision,
          calendarAvailability: unavailable ? "unavailable" : "available",
          calendarAsOf: unavailable ? null : `${TMO}T00:00:00.000Z`,
          blocks: [],
          eligibleBlockIds: unavailable ? [] : ["b-p1", "b-p2"],
          conflicts:
            previewMode === "conflict"
              ? [
                  {
                    blockId: "b-p2",
                    kind: "calendar_busy",
                    withBlockId: null,
                    detail: "Overlaps Standup",
                    calendarEvent: null
                  }
                ]
              : []
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
            outcome: applyOutcome,
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
    applyOutcome = "applied";
    previewMode = "available";
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
  it("auto mode reports an addition held back by a preview conflict as not applied", async () => {
    policyNow = "auto";
    previewMode = "conflict";
    const m = await mount(tomorrowPlan());
    await act(async () => expect(await m.current().save()).toBe(true));
    await m.rerender(savedPlan);
    expect(applies()).toBe(1);
    expect(calls.find((c) => c.url.endsWith("/apply"))?.body).toMatchObject({
      selectedBlockIds: ["b-p1"]
    });
    expect(m.current().status).toBe("Saved. Applied 1; 0 failed; 0 pending; 1 not applied.");
  });
  it("auto mode reports every addition as not applied when the calendar is unavailable", async () => {
    policyNow = "auto";
    previewMode = "unavailable";
    const m = await mount(tomorrowPlan());
    await act(async () => expect(await m.current().save()).toBe(true));
    await m.rerender(savedPlan);
    expect(previews()).toBe(1);
    expect(applies()).toBe(0);
    expect(m.current().status).toBe("Saved. Applied 0; 0 failed; 0 pending; 2 not applied.");
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
  it.each(["applied", "failed", "unknown"] as const)(
    "old %s move outcome cannot settle a new activation",
    async (outcome) => {
      policyNow = "auto";
      savedPlan.blocks = [
        block("b-cal", {
          taskId: "t-cal",
          actualPlacement: {
            startsAt: `${TMO}T14:00:00.000Z`,
            durationMinutes: 60,
            calendarEventRef: "ev-0"
          },
          pendingChange: { kind: "move", startsAt: `${TMO}T15:00:00.000Z`, durationMinutes: 60 }
        })
      ];
      const stub = {
        revision: 5,
        choiceFor: defaultChoiceFor,
        touchedIds: ["b-cal"],
        outcomes: {
          "b-cal": { itemId: "old-operation-item", blockId: "b-cal", outcome, result: null }
        },
        notice: null,
        approval: null,
        expectOwnWrite: vi.fn(),
        apply: vi.fn(() => new Promise(() => undefined)),
        confirm: vi.fn(),
        acceptAllAdditions: vi.fn(),
        dismissApproval: vi.fn()
      } as unknown as DayPlanReviewController;
      const m = await mount(savedPlan, { stub });
      await act(async () => {
        await m.current().save();
      });
      expect(stub.apply).toHaveBeenCalledOnce();
      expect(m.current().status).toContain("1 pending");
      expect(m.current().status).not.toBe("Tomorrow is ready.");
      stub.outcomes = {
        "b-cal": {
          itemId: "new-operation-item",
          blockId: "b-cal",
          outcome: "applied",
          result: null
        }
      };
      await m.rerender(savedPlan);
      expect(m.current().status).toBe("Tomorrow is ready.");
    }
  );
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
  it("a failed move from this activation blocks the ready line", async () => {
    policyNow = "auto";
    applyOutcome = "failed";
    const m = await mount(tomorrowPlan());
    await act(async () => m.review().setPlacement("b-cal", "move", `${TMO}T15:00:00.000Z`));
    await act(async () => expect(await m.current().save()).toBe(true));
    await m.rerender(savedPlan);
    expect(applies()).toBe(1);
    expect(m.current().status).toBe("Saved. Applied 0; 1 failed; 0 pending; 2 not applied.");
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

  it("a fresh mount preserves saved full-day capacity", async () => {
    const plan = tomorrowPlan();
    plan.eveningIntent = {
      ...plan.eveningIntent!,
      capacity: "full"
    };
    const m = await mount(plan);
    expect(m.current().activeCapacity).toBe("full");
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
