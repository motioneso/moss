// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  LocaleSettingsDto
} from "@moss/shared";

import { defaultChoiceFor } from "../../apps/web/src/today/day-plan-review-model.js";
import type { DayPlanReviewController } from "../../apps/web/src/today/day-plan-review-controller.js";
import { DayPlanReview } from "../../apps/web/src/today/day-plan-review.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TZ = "America/Los_Angeles";
const DAY = "2026-09-10";
const NOW = "2026-09-10T16:00:00.000Z";
const locale: LocaleSettingsDto = { timezone: TZ, region: "en-US", dateFormat: "12" };

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

function plan(): DayPlanDto {
  return {
    id: "plan-1",
    localDay: DAY,
    timeZone: TZ,
    revision: 3,
    sourceRunId: null,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    },
    blocks: [
      block("b1", {
        taskId: "t1",
        position: 0,
        pendingChange: { kind: "add", startsAt: "2026-09-10T16:00:00.000Z", durationMinutes: 30 }
      }),
      block("b2", { taskId: "t2", position: 1 })
    ]
  };
}

function tasks(): DayPlanTaskSummary[] {
  return [
    {
      id: "t1",
      title: "Write the launch brief",
      status: "todo",
      dueAt: null,
      doAt: null,
      effort: null
    },
    { id: "t2", title: "Call the vendor", status: "todo", dueAt: null, doAt: null, effort: null }
  ];
}

function stubController(overrides: Partial<DayPlanReviewController> = {}): DayPlanReviewController {
  return {
    choices: {},
    touchedIds: [],
    revision: 3,
    changedIds: [],
    stalePreview: false,
    preview: null,
    approval: null,
    outcomes: {},
    notice: null,
    busy: false,
    choiceFor: (entry) => defaultChoiceFor(entry),
    setPlacement: () => undefined,
    dismissApproval: () => undefined,
    setTime: () => undefined,
    runPreview: async () => true,
    saveChanges: async () => true,
    acceptAllAdditions: async () => true,
    apply: async () => true,
    confirm: async () => true,
    retry: async () => true,
    ...overrides
  };
}

const liveRoots: ReturnType<typeof createRoot>[] = [];

async function renderReview(
  controller: DayPlanReviewController,
  options: {
    readonly onSelectBriefingTab?: (event: { currentTarget: HTMLElement }) => void;
  } = {}
): Promise<void> {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      JSON.stringify({
        settings: { timeBlockMode: "manual", suggestTasks: false, createTasks: false }
      })
  })) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  liveRoots.push(root);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DayPlanReview, {
          controller,
          plan: plan(),
          tasks: tasks(),
          unavailableTaskIds: [],
          events: [],
          locale,
          now: new Date(NOW),
          opener: null,
          onClose: () => undefined,
          onOpenTask: () => undefined,
          onSelectBriefingTab: options.onSelectBriefingTab
        })
      )
    );
  });
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {});
  }
}

afterEach(async () => {
  for (const root of liveRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("DayPlanReview in the report shell", () => {
  it("selects the review tab with the panel headline and labelled panel", async () => {
    await renderReview(stubController());
    const tabs = [...document.body.querySelectorAll('[role="tab"]')];
    const review = tabs.find((tab) => tab.textContent === "Review task blocks") as HTMLElement;
    const briefing = tabs.find((tab) => tab.textContent === "The briefing") as HTMLElement;
    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(review.tabIndex).toBe(0);
    expect(briefing.getAttribute("aria-selected")).toBe("false");
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel.getAttribute("aria-labelledby")).toBe(review.id);
    expect(panel.textContent).toContain("Make the plan fit.");
  });

  it("hands the briefing tab back to Today", async () => {
    const seen: HTMLElement[] = [];
    await renderReview(stubController(), {
      onSelectBriefingTab: (event) => seen.push(event.currentTarget)
    });
    const briefing = [...document.body.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "The briefing"
    ) as HTMLElement;
    await act(async () => briefing.click());
    expect(seen).toEqual([briefing]);
  });

  it("associates visible Time and Placement labels with their controls", async () => {
    await renderReview(
      stubController({
        choiceFor: () => ({ placement: "add", startsAt: "2026-09-10T16:00:00.000Z" })
      })
    );
    const placement = document.body.querySelector("#b1-placement") as HTMLSelectElement;
    const time = document.body.querySelector("#b1-time") as HTMLInputElement;
    expect(document.body.querySelector('label[for="b1-placement"]')?.textContent).toBe("Placement");
    expect(document.body.querySelector('label[for="b1-time"]')?.textContent).toBe("Time");
    expect(placement.getAttribute("aria-label")).toBe("Write the launch brief: placement");
    expect(time.getAttribute("aria-label")).toBe("Write the launch brief: start time");
    expect(time.compareDocumentPosition(placement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the outcome line in the panel status strip live region", async () => {
    await renderReview(
      stubController({
        outcomes: { b1: { itemId: "item-b1", blockId: "b1", outcome: "applied", result: null } }
      })
    );
    const strip = document.body.querySelector(".plan-review__status") as HTMLElement;
    const status = strip.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain("Applied 1");
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel.contains(strip)).toBe(true);
  });
});

describe("p6 automatic Review fail-first", () => {
  it("(a) wraps the report in the review surface", async () => {
    await renderReview(stubController());
    expect(document.body.querySelector('[data-briefing-surface="review"]')).not.toBeNull();
  });

  it("(b) shows Time with the start and Keep on calendar on a calendar row", async () => {
    const calendarPlan = {
      ...plan(),
      blocks: [
        {
          ...block("cal1"),
          title: "Parity carry-over",
          actualPlacement: {
            startsAt: "2026-09-10T15:30:00.000Z",
            durationMinutes: 90,
            calendarEventRef: null
          },
          pendingChange: null
        }
      ]
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          settings: { timeBlockMode: "manual", suggestTasks: false, createTasks: false }
        })
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DayPlanReview, {
            controller: stubController(),
            plan: calendarPlan,
            tasks: tasks(),
            unavailableTaskIds: [],
            events: [],
            locale,
            now: new Date(NOW),
            opener: null,
            onClose: () => undefined,
            onOpenTask: () => undefined
          })
        )
      );
    });
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {});
    }
    const time = document.body.querySelector("#cal1-time") as HTMLInputElement | null;
    expect(time).not.toBeNull();
    expect(time?.value).toBe("08:30");
    const placement = document.body.querySelector("#cal1-placement") as HTMLSelectElement;
    expect([...placement.options].map((option) => option.textContent)).toContain(
      "Keep on calendar"
    );
  });

  it("(c) always shows What will change with No changes selected", async () => {
    await renderReview(stubController());
    expect(document.body.textContent).toContain("What will change");
    expect(document.body.textContent).toContain("No changes selected.");
  });

  it("(d) keeps one rail heading", async () => {
    await renderReview(stubController());
    expect(document.body.textContent).toContain("Your day, in order.");
    expect(document.body.textContent).not.toContain("Your day, laid out");
  });

  it("R1.3 leave keeps a visible disabled Time with the proposed start", async () => {
    await renderReview(
      stubController({ choiceFor: () => ({ placement: "leave", startsAt: null }) })
    );
    const time = document.body.querySelector("#b1-time") as HTMLInputElement | null;
    expect(time).not.toBeNull();
    expect(time?.disabled).toBe(true);
    expect(time?.value).toBe("09:00");
    expect(document.body.textContent).toContain("30 minutes");
    expect(document.body.textContent).not.toMatch(/no time set/);
  });

  it("(e) guard: ReviewRow without the prop shows no Time field on a kept row", async () => {
    const { ReviewRow: BareRow } = await import("../../apps/web/src/today/day-plan-review-row.js");
    const kept = {
      ...block("cal1"),
      title: "Parity carry-over",
      actualPlacement: {
        startsAt: "2026-09-10T15:30:00.000Z",
        durationMinutes: 90,
        calendarEventRef: null
      },
      pendingChange: null
    };
    const single = { ...plan(), blocks: [kept] };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    await act(async () => {
      root.render(
        createElement(BareRow, {
          block: kept,
          title: "Parity carry-over",
          savedLabel: "Due today",
          choice: { placement: "keep", startsAt: null },
          changed: false,
          task: undefined,
          unavailable: false,
          controller: stubController(),
          plan: single,
          locale,
          onOpenTask: () => undefined
        })
      );
    });
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {});
    }
    expect(document.body.querySelector("#cal1-time")).toBeNull();
  });

  it("keeps the due-date hint for an evening leave row", async () => {
    const { ReviewRow: BareRow } = await import("../../apps/web/src/today/day-plan-review-row.js");
    const leave = {
      ...block("due1"),
      taskId: "due-task",
      actualPlacement: {
        startsAt: "2026-09-10T15:30:00.000Z",
        durationMinutes: 90,
        calendarEventRef: null
      },
      pendingChange: null
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    await act(async () => {
      root.render(
        createElement(BareRow, {
          block: leave,
          title: "Due task",
          savedLabel: "On calendar",
          choice: { placement: "leave", startsAt: null },
          changed: false,
          task: {
            id: "due-task",
            title: "Due task",
            status: "todo",
            dueAt: "2026-09-12T12:00:00.000Z",
            doAt: null,
            effort: null
          },
          unavailable: false,
          controller: stubController(),
          plan: { ...plan(), blocks: [leave] },
          locale,
          onOpenTask: () => undefined
        })
      );
    });
    expect(document.body.textContent).toMatch(/Due .*?, no time set/);
  });
});
