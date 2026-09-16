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
