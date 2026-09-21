// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BriefingRunDto, DayPlanBlockDto, DayPlanDto, TaskDto } from "@moss/shared";

import {
  useEveningPlanning,
  type EveningPlanningController
} from "../../apps/web/src/today/evening-planning-controller.js";
import {
  useDayPlanReview,
  type DayPlanReviewController
} from "../../apps/web/src/today/day-plan-review-controller.js";
import { EveningPlanningDialog } from "../../apps/web/src/today/evening-planning.js";

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
    taskDto("t1", "Write the launch brief"),
    taskDto("t2", "Call the vendor"),
    taskDto("t4", "Water the plants", { status: "done", completedAt: `${TODAY}T10:00:00.000Z` })
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
    blocks: [block("bt1", { taskId: "t1", position: 0 })]
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
        taskId: "t1",
        position: 0,
        actualPlacement: {
          startsAt: `${TMO}T14:00:00.000Z`,
          durationMinutes: 60,
          calendarEventRef: "ev-0"
        }
      })
    ]
  };
}

function eveningRun(): BriefingRunDto {
  return {
    summaryText: "The proposal is sent and the team agreed a direction."
  } as unknown as BriefingRunDto;
}

function stubFetch() {
  globalThis.fetch = vi.fn(async (url: unknown) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      JSON.stringify(
        String(url).endsWith("/api/calendar/briefing-settings")
          ? { settings: { timeBlockMode: "suggest" } }
          : { plan: SHARED_TOMORROW }
      )
  })) as unknown as typeof fetch;
}

const liveRoots: ReturnType<typeof createRoot>[] = [];

function DialogHarness(props: {
  readonly evening: EveningPlanningController;
  readonly review: DayPlanReviewController;
  readonly run: BriefingRunDto | null;
}) {
  return createElement(EveningPlanningDialog, {
    evening: props.evening,
    review: props.review,
    tasks: taskDtos(),
    taskSummaries: [],
    unavailableTaskIds: [],
    tomorrowEvents: [],
    completedToday: taskDtos().filter((task) => task.status === "done"),
    locale: { timezone: TZ, region: "en-US", dateFormat: "12" },
    now: new Date(`${TODAY}T12:00:00.000Z`),
    tomorrowKey: TMO,
    eveningRun: props.run,
    opener: null,
    onClose: () => undefined,
    onOpenTask: () => undefined
  });
}

// Stable across renders: the hooks resync on identity, so fresh objects loop.
const SHARED_TASKS = taskDtos();
const SHARED_TODAY = todayPlan();
const SHARED_TOMORROW = tomorrowPlan();

function ControllersHarness(props: {
  readonly run: BriefingRunDto | null;
  readonly seen: (evening: EveningPlanningController, review: DayPlanReviewController) => void;
}) {
  const review = useDayPlanReview({
    plan: SHARED_TOMORROW,
    localDay: TMO,
    timeZone: TZ,
    morningDefinitionId: "def-morning"
  });
  const evening = useEveningPlanning({
    active: true,
    tomorrowKey: TMO,
    todayKey: TODAY,
    timeZone: TZ,
    queryPlan: SHARED_TOMORROW,
    planMissing: false,
    sourceRunId: null,
    todayPlan: SHARED_TODAY,
    tasks: SHARED_TASKS,
    unavailableTaskIds: [],
    tomorrowEvents: [],
    getReview: () => review
  });
  useEffect(() => {
    props.seen(evening, review);
  }, [evening, review, props]);
  return createElement(DialogHarness, { evening, review, run: props.run });
}

async function mountDialogInStrictMode(run: BriefingRunDto | null) {
  let latest: EveningPlanningController | null = null;
  let liveReview: DayPlanReviewController | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  liveRoots.push(root);
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(ControllersHarness, {
            run,
            seen: (c, r) => {
              latest = c;
              liveReview = r;
            }
          })
        )
      )
    );
  });
  return {
    get evening() {
      return latest!;
    },
    get review() {
      return liveReview!;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  };
}

async function mountDialog(run: BriefingRunDto | null) {
  let latest: EveningPlanningController | null = null;
  let liveReview: DayPlanReviewController | null = null;
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
        createElement(ControllersHarness, {
          run,
          seen: (c, r) => {
            latest = c;
            liveReview = r;
          }
        })
      )
    );
  });
  if (!latest || !liveReview) throw new Error("controllers did not render");
  return {
    evening: latest as EveningPlanningController,
    review: liveReview as DayPlanReviewController
  };
}

afterEach(async () => {
  for (const root of liveRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evening step strip", () => {
  it("lists four numbered steps with only Reflect current", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const buttons = [...nav.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "01 Reflect",
      "02 Open commitments",
      "03 Shape tomorrow",
      "04 Review"
    ]);
    expect(buttons.map((button) => button.getAttribute("aria-current"))).toEqual([
      "step",
      null,
      null,
      null
    ]);
  });

  it("shows step 1 in DOM order with the footer Next action", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    expect(panel.getAttribute("aria-labelledby")).toBe("evening-step-reflect-heading");
    const speaker = panel.querySelector(".evening-plan__speaker") as HTMLElement;
    const lede = panel.querySelector(".evening-plan__lede") as HTMLElement;
    const prose = panel.querySelector(".evening-plan__prose") as HTMLElement;
    const question = panel.querySelector(".evening-plan__question") as HTMLElement;
    const choices = panel.querySelector(".evening-plan__choices") as HTMLElement;
    for (const [first, second] of [
      [speaker, lede],
      [lede, prose],
      [prose, question],
      [question, choices]
    ] as const) {
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(lede.textContent).toContain("carrying forward");
    expect(document.body.querySelector(".brief-reader__footer-actions")?.textContent).toContain(
      "Next: Open commitments"
    );
    expect(document.body.querySelector(".brief-reader__footer-back")?.textContent).toContain(
      "Back to Today"
    );
  });

  it("renders the tomorrow rail beside the panel", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const rail = document.body.querySelector(".evening-plan__railwrap") as HTMLElement;
    expect(rail.querySelector(".evening-plan__rail-heading")?.textContent).toBe(
      "Tomorrow, taking shape."
    );
    expect(rail.querySelector(".evening-plan__rail-date")?.textContent).toContain("September 11");
    expect(rail.querySelector("summary")?.textContent).toBe("Tomorrow's plan");
    const panel = document.body.querySelector(".evening-plan__panel") as HTMLElement;
    expect(panel.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("evening step navigation", () => {
  it("keeps dialog title focus on initial render under StrictMode", async () => {
    stubFetch();
    await mountDialogInStrictMode(eveningRun());
    const title = document.body.querySelector("[data-briefing-title]") as HTMLElement;
    expect(document.activeElement).toBe(title);
  });

  it("does not hide visible step numbers from accessible names", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const buttons = [...nav.querySelectorAll("button")];
    for (const button of buttons) {
      const span = button.querySelector("span");
      expect(span).not.toBeNull();
      expect(span?.getAttribute("aria-hidden")).toBeNull();
    }
  });

  it("keeps status outside the footer actions container", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const status = document.body.querySelector(".evening-plan__status");
    expect(status).not.toBeNull();
    expect(document.body.querySelector(".brief-reader__footer-actions")?.contains(status)).toBe(
      false
    );
  });

  it("applies evening-plan__status--saved modifier only when saved", async () => {
    stubFetch();
    const harness = await mountDialog(eveningRun());
    const status = document.body.querySelector(".evening-plan__status");
    expect(status?.textContent).toBe("Not saved yet.");
    expect(status?.classList.contains("evening-plan__status--saved")).toBe(false);

    await act(async () => {
      await harness.evening.save();
    });

    const statusAfter = document.body.querySelector(".evening-plan__status");
    expect(statusAfter?.textContent).toBe("Saved. The blocks are proposed for the morning.");
    expect(statusAfter?.classList.contains("evening-plan__status--saved")).toBe(true);
  });

  it("focuses the named heading when advancing to steps 3 and 4 via Next", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nextButton = () =>
      document.body.querySelector(".brief-reader__footer-actions button") as HTMLButtonElement;

    // Step 1 -> Step 2
    await act(async () => {
      nextButton().click();
    });
    expect(document.activeElement).toBe(document.getElementById("evening-commitments-heading"));

    // Step 2 -> Step 3
    await act(async () => {
      nextButton().click();
    });
    expect(document.activeElement).toBe(document.getElementById("evening-shape-heading"));

    // Step 3 -> Step 4
    await act(async () => {
      nextButton().click();
    });
    expect(document.activeElement).toBe(document.getElementById("evening-review-heading"));
  });

  it("moves current and focus to step 2 and keeps the frame chrome", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const second = [...nav.querySelectorAll("button")][1] as HTMLButtonElement;
    await act(async () => {
      second.click();
    });
    expect(second.getAttribute("aria-current")).toBe("step");
    const heading = document.getElementById("evening-commitments-heading") as HTMLElement;
    expect(document.activeElement).toBe(heading);
    expect(document.body.querySelector('[role="region"]')?.textContent).toContain(
      "Open commitments"
    );
    expect(document.body.querySelector(".evening-plan__railwrap")).not.toBeNull();
    expect(document.body.querySelector(".brief-reader__footer-actions")?.textContent).toContain(
      "Next: Shape tomorrow"
    );
  });

  it("renders three reflection cards and no h3 Reflect heading in step 1", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const panel = document.getElementById("evening-reflect") as HTMLElement;
    expect(panel.getAttribute("aria-label")).toBe("Reflect");
    const group = panel.querySelector(
      '[role="radiogroup"][aria-label="Reflection"]'
    ) as HTMLElement | null;
    expect(group, "reflection radiogroup").not.toBeNull();
    expect(document.getElementById("evening-reflect-heading")).toBeNull();
    const cards = [...(group?.querySelectorAll("label.evening-plan__choice") ?? [])];
    expect(cards.length).toBe(3);
    expect(cards.map((card) => card.querySelector("strong")?.textContent)).toEqual([
      "That captures it",
      "The follow-up isn't sent",
      "It took more out of me than expected"
    ]);
    expect(cards.map((card) => card.querySelector("small")?.textContent)).toEqual([
      "I'm ready to look ahead.",
      "I still need to send the message.",
      "Make some room in tomorrow's plan."
    ]);
  });

  it("preserves card selection and added note when leaving and returning to step 1", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    const group = panel.querySelector(
      '[role="radiogroup"][aria-label="Reflection"]'
    ) as HTMLElement | null;
    expect(group, "reflection radiogroup").not.toBeNull();
    const cards = [...(group?.querySelectorAll("label.evening-plan__choice") ?? [])];
    await act(async () => {
      cards[1]?.querySelector("input")?.click();
    });
    expect(cards[1]?.getAttribute("data-state")).toBe("selected");

    const noteInput = document.body.querySelector(
      'textarea[aria-label="Or tell Moss in your own words"]'
    ) as HTMLTextAreaElement;
    await act(async () => {
      noteInput.focus();
      const native = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      native?.call(noteInput, "Need the figures");
      noteInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const addNoteBtn = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Add note"
    );
    await act(async () => {
      addNoteBtn?.click();
    });

    const hints = [...panel.querySelectorAll(".evening-plan__hint")];
    expect(hints.some((h) => h.textContent?.includes("Noted: Need the figures"))).toBe(true);

    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const buttons = [...nav.querySelectorAll("button")] as HTMLButtonElement[];
    await act(async () => {
      buttons[1]!.click();
    });
    await act(async () => {
      buttons[0]!.click();
    });

    const refreshedGroup = document.body.querySelector(
      '[role="radiogroup"][aria-label="Reflection"]'
    ) as HTMLElement;
    const refreshedCards = [...refreshedGroup.querySelectorAll("label.evening-plan__choice")];
    expect(refreshedCards[1]?.getAttribute("data-state")).toBe("selected");
    const refreshedHints = [...document.body.querySelectorAll(".evening-plan__hint")];
    expect(refreshedHints.some((h) => h.textContent?.includes("Noted: Need the figures"))).toBe(
      true
    );
  });

  it("offers the save action on step 4", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const fourth = [...nav.querySelectorAll("button")][3] as HTMLButtonElement;
    await act(async () => {
      fourth.click();
    });
    expect(fourth.getAttribute("aria-current")).toBe("step");
    expect(document.body.querySelector(".brief-reader__footer-actions")?.textContent).toContain(
      "Save tomorrow's plan"
    );
  });

  it("names the region when no run summary exists", async () => {
    stubFetch();
    await mountDialog(null);
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    expect(panel.getAttribute("aria-label")).toBe("Reflect");
    expect(panel.querySelector(".evening-plan__lede")).toBeNull();
    expect(panel.querySelector(".evening-plan__prose")?.textContent).toContain("not ready yet");
  });
});

describe("evening steps 2 to 4 (V8)", () => {
  it("renders commitment choice cards with React-selected state", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const second = [...nav.querySelectorAll("button")][1] as HTMLButtonElement;
    await act(async () => {
      second.click();
    });
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    expect(panel.querySelector(".evening-plan__speaker")?.textContent).toContain("Moss");
    expect(panel.querySelector(".evening-plan__lede")?.textContent).toContain(
      "Give this a place, or leave it open."
    );
    const group = panel.querySelector(
      '[role="radiogroup"][aria-label="Write the launch brief: plan"]'
    ) as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.classList.contains("evening-plan__choices")).toBe(true);
    const cards = [...group.querySelectorAll("label.evening-plan__choice")];
    expect(cards.length).toBe(3);
    expect(cards.map((card) => card.querySelector("strong")?.textContent)).toEqual([
      "Tomorrow",
      "Another date",
      "Keep on the list"
    ]);
    const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.length).toBe(3);
    for (const radio of radios) {
      expect(radio.hidden).toBe(false);
      expect(radio.getAttribute("aria-hidden")).not.toBe("true");
    }
    await act(async () => {
      cards[0]!.querySelector("input")!.click();
    });
    const checked = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(checked.filter((radio) => radio.checked).length).toBe(1);
    expect(group.querySelectorAll('label[data-state="selected"]').length).toBe(1);
    expect(
      (group.querySelector('label[data-state="selected"]') as HTMLElement).textContent
    ).toContain("Tomorrow");
  });

  it("renders capacity cards and visible priority labels", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const third = [...nav.querySelectorAll("button")][2] as HTMLButtonElement;
    await act(async () => {
      third.click();
    });
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    expect(panel.querySelector(".evening-plan__lede")?.textContent).toContain(
      "How much room do you want tomorrow?"
    );
    const group = panel.querySelector(
      '[role="radiogroup"][aria-label="Day capacity"]'
    ) as HTMLElement;
    const cards = [...group.querySelectorAll("label.evening-plan__choice")];
    expect(cards.length).toBe(3);
    await act(async () => {
      cards[0]!.querySelector("input")!.click();
    });
    expect(group.querySelectorAll('label[data-state="selected"]').length).toBe(1);
    const priorityLabel = panel.querySelector('label[for="evening-priority"]') as HTMLElement;
    expect(priorityLabel?.textContent).toBe("Main priority");
    const startLabel = panel.querySelector('label[for="evening-start"]') as HTMLElement;
    expect(startLabel?.textContent).toBe("Task time starts at");
    expect(panel.querySelector("#evening-priority")).not.toBeNull();
    expect(panel.querySelector("#evening-start")).not.toBeNull();
    expect(panel.querySelector('select[aria-label="Main priority"]')).toBeNull();
    expect(panel.querySelector('input[aria-label="Task time starts at"]')).toBeNull();
  });

  it("groups the review into Changes, Keep and No change in order", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const fourth = [...nav.querySelectorAll("button")][3] as HTMLButtonElement;
    await act(async () => {
      fourth.click();
    });
    const panel = document.body.querySelector('[role="region"]') as HTMLElement;
    expect(panel.querySelector(".evening-plan__lede")?.textContent).toContain(
      "A plan you can leave with."
    );
    const groups = [...panel.querySelectorAll("section.evening-plan__group")];
    const eyebrows = groups.map(
      (group) => group.querySelector("h4.evening-plan__eyebrow")?.textContent
    );
    expect(eyebrows[0]).toBe("Changes");
    expect(eyebrows).toContain("Keep as they are");
    expect(eyebrows).toContain("No change");
    for (let i = 0; i + 1 < groups.length; i += 1) {
      expect(
        groups[i]!.compareDocumentPosition(groups[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    const changes = groups[0]!;
    expect(changes.textContent).toContain("Nothing changes tomorrow.");
    const keep = groups.find(
      (group) => group.querySelector("h4")?.textContent === "Keep as they are"
    )!;
    expect(keep.querySelectorAll(".plan-review__rows > *").length).toBeGreaterThan(0);
    const noChange = groups.find(
      (group) => group.querySelector("h4")?.textContent === "No change"
    )!;
    expect(noChange.textContent).toContain("Write the launch brief");
    expect(panel.querySelector(".evening-plan__controls")?.textContent).toContain(
      "Preview changes"
    );
  });

  it("keeps the step heading focus and the footer save on step 4", async () => {
    stubFetch();
    await mountDialog(eveningRun());
    const nav = document.body.querySelector('nav[aria-label="Plan steps"]') as HTMLElement;
    const fourth = [...nav.querySelectorAll("button")][3] as HTMLButtonElement;
    await act(async () => {
      fourth.click();
    });
    const heading = document.getElementById("evening-review-heading") as HTMLElement;
    expect(document.activeElement).toBe(heading);
    expect(document.body.querySelector(".brief-reader__footer-actions")?.textContent).toContain(
      "Save tomorrow's plan"
    );
  });
});
