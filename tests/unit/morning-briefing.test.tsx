// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApplyExecutionItemReport,
  BriefingActionRowDto,
  BriefingRunDto,
  DayPlanBlockDto,
  DayPlanDto,
  GetBriefingRunResponse,
  GetDayPlanResponse,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type { DayPlanReviewController } from "../../apps/web/src/today/day-plan-review-controller.js";
import {
  acceptAllSelectionFor,
  defaultChoiceFor,
  hasOtherPendingEdits,
  type BlockChoice
} from "../../apps/web/src/today/day-plan-review-model.js";
import { MorningBriefingReader } from "../../apps/web/src/today/morning-briefing.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const NOW = "2026-09-10T16:00:00.000Z";

function task(id: string, title: string): TaskDto {
  return {
    id,
    ownerUserId: "user-1",
    listId: "list-1",
    parentTaskId: null,
    title,
    description: null,
    status: "todo",
    priority: null,
    position: 0,
    dueAt: null,
    doAt: null,
    effort: null,
    source: "email",
    sourceRef: "subject:x",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    suggestionMetadata: null
  };
}

function row(
  taskId: string,
  title: string,
  overrides: Partial<BriefingActionRowDto> = {}
): BriefingActionRowDto {
  return {
    taskId,
    title,
    explanation: `Why ${title} matters`,
    category: "needs_action",
    status: "suggested",
    primaryAction: { kind: "view", href: `https://example.test/source/${taskId}` },
    source: "email",
    sourceLabel: "Gmail",
    sourceRef: `source:${taskId}`,
    sourceHref: `https://example.test/source/${taskId}`,
    dueAt: null,
    computedAt: NOW,
    resurfaceReason: null,
    ...overrides
  };
}

function fullRun(): BriefingRunDto {
  return {
    id: "run-full",
    definitionId: "def-morning",
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "manual",
    briefingType: "morning",
    summaryText: "Protect the launch window and reply to Alex about the contract.",
    sourceMetadata: {
      sourceTimestamps: {
        version: 1,
        capturedAt: NOW,
        sources: [
          { source: "email", freshnessKind: "connector_sync", asOf: NOW },
          { source: "vault", freshnessKind: "connector_sync", asOf: "2026-09-08T16:00:00.000Z" }
        ]
      },
      gaps: [{ source: "chats", reason: "empty" }],
      editorial: {
        news: {
          version: 1,
          capturedAt: NOW,
          degraded: false,
          stories: [
            {
              id: "news-1",
              title: "Launch window holds despite weather",
              sourceLabel: "Test News",
              sourceKey: "test-news",
              url: "https://example.test/news/1",
              publishedAt: NOW,
              summary: "Crews cleared the range.",
              imageUrl: null
            }
          ]
        },
        sports: {
          version: 1,
          capturedAt: NOW,
          degraded: false,
          state: "finals",
          ambiguousFollowCount: 0,
          games: [
            {
              id: "game-1",
              competitionKey: "nfl",
              startsAt: "2026-09-09T17:00:00.000Z",
              phase: "final",
              statusDetail: "Final",
              headline: "Vikings beat Cowboys 21-14",
              homeShort: "MIN",
              awayShort: "DAL",
              homeScore: 21,
              awayScore: 14
            }
          ],
          stories: [
            {
              teamKey: "min",
              competitionKey: "nfl",
              title: "Vikings defense shines again",
              url: "https://example.test/sports/1",
              publishedAt: NOW,
              imageUrl: null,
              publisherLabel: "Test Sports",
              publisherDomain: "example.test"
            }
          ]
        }
      }
    },
    feedbackItems: [],
    structuredPayload: {
      version: 1,
      actionRows: [row("task-1", "Book the launch room")],
      catchUp: null,
      planContext: {
        version: 1,
        planId: "plan-1",
        revision: 2,
        localDay: "2026-09-10",
        timeZone: "America/Los_Angeles",
        sourceRunId: null,
        eveningIntent: {
          priorityTaskIds: ["task-1", "task-gone"],
          capacity: "light",
          notes: "Keep the morning clear.",
          corrections: [],
          commitments: []
        },
        blocks: [
          {
            id: "block-1",
            kind: "focus",
            taskId: null,
            title: "Write the launch brief",
            position: 0,
            actualPlacement: null,
            pendingChange: null
          },
          {
            id: "block-2",
            kind: "meeting",
            taskId: null,
            title: "Standup",
            position: 1,
            actualPlacement: null,
            pendingChange: "add"
          }
        ]
      }
    },
    createdAt: NOW
  };
}

function readyDetail(
  run: BriefingRunDto,
  overrides: Partial<GetBriefingRunResponse> = {}
): GetBriefingRunResponse {
  return { state: "ready", run, latest: true, plan: null, ...overrides };
}

function seedClient(entries: readonly (readonly [readonly unknown[], unknown])[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  for (const [key, data] of entries) {
    client.setQueryData(key as readonly unknown[], data);
  }
  client.setQueryData(["calendar", "briefing-settings"], {
    settings: {
      lookaheadDays: 1,
      prepTaskMode: "suggest",
      timeBlockMode: "suggest",
      suggestTasks: true,
      createTasks: false,
      suggestTimeBlocks: true,
      blockTime: false
    }
  });
  return client;
}

const liveRoots: ReturnType<typeof createRoot>[] = [];

function stubReaderController(
  overrides: Partial<DayPlanReviewController> = {}
): DayPlanReviewController {
  return {
    choices: {},
    touchedIds: [],
    revision: 2,
    changedIds: [],
    stalePreview: false,
    preview: null,
    approval: null,
    outcomes: {},
    notice: null,
    busy: false,
    choiceFor: (block: DayPlanBlockDto) => defaultChoiceFor(block),
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

function acceptBlock(
  id: string,
  taskId: string,
  position: number,
  startsAt: string,
  pendingKind: "add" | "move" = "add"
): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId,
    title: null,
    position,
    actualPlacement: null,
    pendingChange: { kind: pendingKind, startsAt, durationMinutes: 30 }
  };
}

function acceptPlanResponse(): GetDayPlanResponse {
  return {
    plan: {
      id: "plan-1",
      localDay: "2026-09-10",
      timeZone: "America/Los_Angeles",
      revision: 2,
      sourceRunId: null,
      eveningIntent: {
        priorityTaskIds: [],
        capacity: null,
        notes: null,
        corrections: [],
        commitments: []
      },
      blocks: [
        acceptBlock("b1", "t1", 0, "2026-09-10T16:00:00.000Z"),
        acceptBlock("b2", "t2", 1, "2026-09-10T18:00:00.000Z"),
        acceptBlock("b3", "t3", 2, "2026-09-10T20:00:00.000Z")
      ]
    },
    tasks: [],
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  };
}

function moveBlock(response: GetDayPlanResponse, id: string): GetDayPlanResponse {
  if (!response.plan) throw new Error("plan missing for the move case");
  return {
    ...response,
    plan: {
      ...response.plan,
      blocks: response.plan.blocks.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              pendingChange: {
                kind: "move",
                startsAt: "2026-09-10T22:00:00.000Z",
                durationMinutes: 30
              }
            }
          : entry
      )
    }
  };
}

function appliedOutcome(blockId: string, outcome: ApplyExecutionItemReport["outcome"]) {
  return {
    [blockId]: { itemId: `item-${blockId}`, blockId, outcome, result: null }
  };
}

async function renderReader(
  client: QueryClient,
  options: {
    readonly runId?: string;
    readonly runs?: readonly BriefingRunDto[];
    readonly tasks?: readonly TaskDto[];
    readonly controller?: DayPlanReviewController;
    readonly dayPlan?: GetDayPlanResponse;
  } = {}
): Promise<string> {
  const runId = options.runId ?? "run-full";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  liveRoots.push(root);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MorningBriefingReader, {
          definitionId: "def-morning",
          initialRunId: runId,
          runs: options.runs ?? [],
          tasks: options.tasks ?? [task("task-1", "Book the launch room")],
          locale,
          dayPlan: options.dayPlan,
          events: [],
          now: new Date(NOW),
          dayPlanLoading: false,
          dayPlanError: false,
          calendarError: false,
          opener: null,
          onClose: () => undefined,
          onOpenTask: () => undefined,
          onReview: () => undefined,
          controller: options.controller ?? stubReaderController()
        })
      )
    );
  });
  return document.body.innerHTML;
}

async function flushQueries(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
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
describe("MorningBriefingReader report", () => {
  it("renders each carried section with the run's own text", async () => {
    const run = fullRun();
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Protect the launch window and reply to Alex about the contract.");
    expect(html).toContain("Keep the morning clear.");
    expect(html).toContain("light");
    expect(html).toContain("Book the launch room");
    expect(html).toContain("Write the launch brief");
    expect(html).toContain("committed");
    expect(html).toContain("Standup");
    expect(html).toContain("proposed");
    expect(html).toContain("Why Book the launch room matters");
    expect(html).toContain("Launch window holds despite weather");
    expect(html).toContain("Test News");
    expect(html).toContain("Vikings beat Cowboys 21-14");
    expect(html).toContain("Test Sports");
    expect(html).toContain("Sources");
  });

  it("omits sections the run does not carry", async () => {
    const run: BriefingRunDto = {
      ...fullRun(),
      summaryText: "Short report.",
      sourceMetadata: {},
      structuredPayload: { version: 1, actionRows: [], catchUp: null }
    };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client, { tasks: [] });
    expect(html).toContain("Short report.");
    expect(html).not.toContain("Evening intent");
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("brief-reader-news");
    expect(html).not.toContain("brief-reader-sports");
    expect(html).not.toContain("Sources");
    expect(html).not.toContain("Earlier reports");
  });

  it("marks unavailable references without their cached content", async () => {
    const run: BriefingRunDto = {
      ...fullRun(),
      structuredPayload: {
        version: 1,
        actionRows: [row("task-1", "Book the launch room"), row("task-gone", "Ghost row title")],
        catchUp: null
      }
    };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    // task-gone (row and intent priority) and chats (gap) are absent; task-1 is present.
    const html = await renderReader(client);
    expect(html).toContain("No longer available");
    expect(html).toContain("chats");
    expect(html).toContain("Book the launch room");
    expect(html).not.toContain("Ghost row title");
    expect(html).not.toContain("Why Ghost row title matters");
  });

  it("carries no task buttons inside the reader rows", async () => {
    const run = fullRun();
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Book the launch room");
    expect(html).not.toContain(">Open<");
  });

  it("shows the pending line with no prose while queued", async () => {
    const client = seedClient([
      [
        queryKeys.briefings.run("def-morning", "run-full"),
        { state: "pending", run: null, latest: false, plan: null }
      ]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Your morning briefing is being prepared.");
    expect(html).not.toContain("Protect the launch window");
    expect(html).not.toContain("Try again");
  });

  it("shows the unavailable line with retry when the run failed", async () => {
    const client = seedClient([
      [
        queryKeys.briefings.run("def-morning", "run-full"),
        { state: "failed", run: null, latest: false, plan: null }
      ]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Your morning briefing isn");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Protect the launch window");
  });

  it("dates an earlier report and notes a changed plan, with mutating controls absent", async () => {
    const older: BriefingRunDto = {
      ...fullRun(),
      id: "run-old",
      createdAt: "2026-09-09T16:00:00.000Z"
    };
    const client = seedClient([
      [
        queryKeys.briefings.run("def-morning", "run-old"),
        readyDetail(older, {
          latest: false,
          plan: { status: "changed", storedRevision: 1, currentRevision: 2, current: null }
        })
      ]
    ]);
    const html = await renderReader(client, { runId: "run-old", runs: [fullRun(), older] });
    expect(html).toContain("Report from");
    expect(html).toContain("The plan has changed since this report.");
    expect(html).not.toContain("Accept");
    expect(html).not.toContain("Dismiss");
    expect(html).not.toContain("Reply");
  });

  it("requests nothing from news or sports endpoints for a payload without them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const run: BriefingRunDto = {
      ...fullRun(),
      sourceMetadata: {},
      structuredPayload: { version: 1, actionRows: [], catchUp: null }
    };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client, { tasks: [] });
    expect(html).not.toContain("brief-reader-news");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("MorningBriefingReader retry", () => {
  it("sends one run-now request and re-reads the new run", async () => {
    const failedDetail: GetBriefingRunResponse = {
      state: "failed",
      run: null,
      latest: false,
      plan: null
    };
    const ready = readyDetail(fullRun());
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/run") && !url.includes("/runs/")) {
        return Response.json({ jobId: "job-2", runId: "run-2" });
      }
      if (url.includes("/runs/run-2")) {
        return Response.json({ ...ready, run: { ...ready.run!, id: "run-2" } });
      }
      return Response.json(failedDetail);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } }
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    liveRoots.push(root);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MorningBriefingReader, {
            definitionId: "def-morning",
            initialRunId: "run-full",
            runs: [],
            tasks: [task("task-1", "Book the launch room")],
            locale,
            dayPlan: undefined,
            events: [],
            now: new Date(NOW),
            dayPlanLoading: false,
            dayPlanError: false,
            calendarError: false,
            opener: null,
            onClose: () => undefined,
            onOpenTask: () => undefined,
            onReview: () => undefined,
            controller: stubReaderController()
          })
        )
      );
    });
    await flushQueries();
    const retry = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again"
    );
    expect(retry, "expected the retry button on a failed run").toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await flushQueries();
    const posts = fetchMock.mock.calls.filter(([input, init]) => {
      const url = String(input);
      return url.endsWith("/run") && !url.includes("/runs/") && init?.method === "POST";
    });
    expect(posts).toHaveLength(1);
    expect(document.body.innerHTML).toContain("Protect the launch window");
  });
});

describe("MorningBriefingReader review footer", () => {
  function footerButtons(): string[] {
    const footer = document.body.querySelector(".brief-reader__footer");
    if (!footer) throw new Error("reader footer did not render");
    return [...footer.querySelectorAll("button")].map((node) => node.textContent ?? "");
  }

  it("offers Accept all first when proposed additions are eligible", async () => {
    await renderReader(seedClient([]), { dayPlan: acceptPlanResponse() });
    expect(footerButtons()).toEqual([
      "Accept all time blocks",
      "Review task blocks",
      "Back to Today"
    ]);
  });

  it("offers Review changes instead when a move is pending", async () => {
    await renderReader(seedClient([]), { dayPlan: moveBlock(acceptPlanResponse(), "b2") });
    expect(footerButtons()).toEqual(["Review changes", "Review task blocks", "Back to Today"]);
  });

  it("announces the applied count and keeps focus on activation", async () => {
    const acceptAllAdditions = vi.fn(async () => true);
    await renderReader(seedClient([]), {
      dayPlan: acceptPlanResponse(),
      controller: stubReaderController({
        acceptAllAdditions,
        outcomes: appliedOutcome("b1", "applied")
      })
    });
    const accept = footerButtons().indexOf("Accept all time blocks");
    expect(accept).toBe(0);
    const target = document.body.querySelector(".brief-reader__footer button") as HTMLButtonElement;
    (document.activeElement as HTMLElement | null)?.blur?.();
    await act(async () => {
      target.click();
    });
    expect(acceptAllAdditions).toHaveBeenCalledTimes(1);
    const footer = document.body.querySelector(".brief-reader__footer");
    expect(footer?.textContent).toContain("Added 1 to the calendar");
    expect(footer?.querySelectorAll("button")).toHaveLength(3);
    expect(document.activeElement?.textContent).toBe("Accept all time blocks");
  });

  it("marks the accept button busy while it runs", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const acceptAllAdditions = vi.fn(() => gate);
    await renderReader(seedClient([]), {
      dayPlan: acceptPlanResponse(),
      controller: stubReaderController({ acceptAllAdditions })
    });
    const accept = document.body.querySelector(
      ".brief-reader__footer-actions .jds-btn--primary"
    ) as HTMLButtonElement;
    expect(accept.textContent).toBe("Accept all time blocks");
    const clicked = act(async () => {
      accept.click();
    });
    await act(async () => {});
    expect(accept.getAttribute("aria-busy")).toBe("true");
    expect(accept.disabled).toBe(true);
    expect(accept.className).toContain("jds-btn--primary");
    await act(async () => {
      release?.();
      await gate;
    });
    await clicked;
  });

  it("reads the outcome line from the footer status strip", async () => {
    const acceptAllAdditions = vi.fn(async () => true);
    await renderReader(seedClient([]), {
      dayPlan: acceptPlanResponse(),
      controller: stubReaderController({
        acceptAllAdditions,
        outcomes: appliedOutcome("b1", "applied")
      })
    });
    const accept = document.body.querySelector(
      ".brief-reader__footer-actions .jds-btn--primary"
    ) as HTMLButtonElement;
    await act(async () => {
      accept.click();
    });
    const strip = document.body.querySelector(".brief-reader__status") as HTMLElement;
    expect(strip.querySelector('[role="status"]')?.textContent).toContain("Added 1");
    const footer = document.body.querySelector(".brief-reader__footer") as HTMLElement;
    expect(footer.contains(strip)).toBe(true);
  });

  it("names nothing added and hands off to review when an item failed", async () => {
    const acceptAllAdditions = vi.fn(async () => true);
    await renderReader(seedClient([]), {
      dayPlan: acceptPlanResponse(),
      controller: stubReaderController({
        acceptAllAdditions,
        outcomes: appliedOutcome("b1", "failed")
      })
    });
    const target = document.body.querySelector(".brief-reader__footer button") as HTMLButtonElement;
    (document.activeElement as HTMLElement | null)?.blur?.();
    await act(async () => {
      target.click();
    });
    const footer = document.body.querySelector(".brief-reader__footer");
    expect(footer?.textContent).toContain("Nothing was added");
    const review = [...(footer?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === "Review changes"
    );
    expect(review).toBeDefined();
    expect(document.activeElement?.textContent).toBe("Review changes");
  });
});
describe("day-plan-review accept-all model", () => {
  function modelBlock(id: string, overrides: Partial<DayPlanBlockDto> = {}): DayPlanBlockDto {
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

  function modelPlan(): DayPlanDto {
    return {
      id: "plan-1",
      localDay: "2026-09-10",
      timeZone: "America/Los_Angeles",
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
        modelBlock("b1", {
          taskId: "t1",
          pendingChange: {
            kind: "add",
            startsAt: "2026-09-10T16:00:00.000Z",
            durationMinutes: 30
          }
        }),
        modelBlock("b2", {
          taskId: "t2",
          position: 1,
          actualPlacement: {
            startsAt: "2026-09-10T21:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "ev-1"
          }
        }),
        modelBlock("b3", { taskId: "t3", position: 2 })
      ]
    };
  }

  function choiceFor(choices: Record<string, BlockChoice>) {
    return (block: DayPlanBlockDto) => choices[block.id] ?? defaultChoiceFor(block);
  }

  it("selects untouched saved adds and nothing else", () => {
    expect(acceptAllSelectionFor(modelPlan(), choiceFor({}), [])).toEqual(["b1"]);
  });

  it("excludes a local leave, calendar rows and moves or removals", () => {
    const target = modelPlan();
    expect(
      acceptAllSelectionFor(target, choiceFor({ b1: { placement: "leave", startsAt: null } }), [
        "b1"
      ])
    ).toEqual([]);
    expect(
      acceptAllSelectionFor(
        target,
        choiceFor({ b2: { placement: "add", startsAt: "2026-09-10T22:00:00.000Z" } }),
        ["b2"]
      )
    ).toEqual(["b1"]);
    expect(
      acceptAllSelectionFor(target, choiceFor({ b1: { placement: "remove", startsAt: null } }), [
        "b1"
      ])
    ).toEqual([]);
  });

  it("selects a touched add so the draft carries its edited time", () => {
    const target = modelPlan();
    const selected = acceptAllSelectionFor(
      target,
      choiceFor({ b1: { placement: "add", startsAt: "2026-09-10T18:00:00.000Z" } }),
      ["b1"]
    );
    expect(selected).toEqual(["b1"]);
  });

  it("gates on saved or touched moves and removals, never on leave", () => {
    const target = modelPlan();
    expect(hasOtherPendingEdits(target, choiceFor({}), [])).toBe(false);
    expect(
      hasOtherPendingEdits(target, choiceFor({ b1: { placement: "leave", startsAt: null } }), [
        "b1"
      ])
    ).toBe(false);
    const moved: DayPlanDto = {
      ...target,
      blocks: target.blocks.map((entry) =>
        entry.id === "b2"
          ? {
              ...entry,
              pendingChange: {
                kind: "move",
                startsAt: "2026-09-10T22:00:00.000Z",
                durationMinutes: 60
              }
            }
          : entry
      )
    };
    expect(hasOtherPendingEdits(moved, choiceFor({}), [])).toBe(true);
    expect(
      hasOtherPendingEdits(
        target,
        choiceFor({ b2: { placement: "move", startsAt: "2026-09-10T22:00:00.000Z" } }),
        ["b2"]
      )
    ).toBe(true);
    expect(
      hasOtherPendingEdits(target, choiceFor({ b1: { placement: "remove", startsAt: null } }), [
        "b1"
      ])
    ).toBe(true);
  });
});
