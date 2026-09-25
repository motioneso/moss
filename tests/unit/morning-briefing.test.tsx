// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BriefingRunDto,
  DayPlanBlockDto,
  DayPlanDto,
  GetBriefingRunResponse,
  GetDayPlanResponse,
  SportsBriefingEvidenceV1
} from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import {
  acceptAllSelectionFor,
  defaultChoiceFor,
  hasOtherPendingEdits,
  type BlockChoice
} from "../../apps/web/src/today/day-plan-review-model.js";
import { MorningBriefingReader } from "../../apps/web/src/today/morning-briefing.js";
import {
  acceptPlanResponse,
  appliedOutcome,
  cleanupRoots,
  flushQueries,
  fullRun,
  liveRoots,
  locale,
  moveBlock,
  NOW,
  readyDetail,
  renderReader,
  row,
  seedClient,
  stubReaderController,
  task
} from "./morning-briefing-fixtures.js";

afterEach(async () => {
  await cleanupRoots();
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
    expect(html).toContain("Book the launch room");
    expect(html).toContain("Why Book the launch room matters");
    expect(html).toContain("Launch window holds despite weather");
    expect(html).toContain("Crews cleared the range.");
    expect(html).toContain("Vikings defense shines again");
    expect(html).toContain("DAL");
    expect(html).toContain("MIN");
    expect(html).toContain("final.");
    expect(html).toContain("Sources");
    // Q4: the evening-intent/plan-context lists are dropped from the Read tab.
    expect(html).not.toContain("Evening intent");
    expect(html).not.toContain("Write the launch brief · committed");
    // Q5: individual story bylines sit behind the "↗" link now, not inline.
    expect(html).not.toContain("Test News");
    expect(html).not.toContain("Test Sports");
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

  it("attributes priorities to task deadlines and calendar without evening intent", async () => {
    const run = fullRun();
    const noEveningIntent: BriefingRunDto = {
      ...run,
      structuredPayload: {
        ...run.structuredPayload,
        planContext: { ...run.structuredPayload.planContext!, eveningIntent: null }
      }
    };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(noEveningIntent)]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("No evening plan was saved.");
    expect(html).toContain("priorities come from task deadlines and your calendar");
  });

  it("names delayed email separately from the other briefing sources", async () => {
    const run = fullRun();
    const delayed: BriefingRunDto = {
      ...run,
      sourceMetadata: {
        ...run.sourceMetadata,
        sourceTimestamps: {
          version: 1,
          capturedAt: NOW,
          sources: [
            { source: "email", freshnessKind: "connector_sync", asOf: "2026-09-10T03:00:00.000Z" },
            { source: "calendar", freshnessKind: "connector_sync", asOf: NOW },
            { source: "tasks", freshnessKind: "realtime", asOf: NOW }
          ]
        }
      }
    };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(delayed)]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Email hasn’t updated since");
    expect(html).toContain("newer replies this briefing hasn’t seen");
    expect(html).toContain("Calendar and task details remain available");
    expect(html).not.toContain("Some sources are over a day old: Email");
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

  it("names the moved block and its new time in the changed-overnight callout", async () => {
    // FAIL-FIRST at 62ccbb3d: today's code only ever shows the generic
    // "The plan has changed since this report." line and has no disclosure
    // button. This proves that against the base before the callout copy
    // change lands (see proofs/SCREEN-MORNING-READER/fail-first-callout-62ccbb3d.txt).
    const run = fullRun();
    const client = seedClient([
      [
        queryKeys.briefings.run("def-morning", "run-full"),
        readyDetail(run, {
          plan: {
            status: "changed",
            storedRevision: 2,
            currentRevision: 3,
            current: {
              ...run.structuredPayload.planContext!,
              revision: 3,
              blocks: [
                run.structuredPayload.planContext!.blocks[0]!,
                {
                  ...run.structuredPayload.planContext!.blocks[1]!,
                  pendingChange: null,
                  actualPlacement: {
                    startsAt: "2026-09-10T17:15:00.000Z",
                    durationMinutes: 30,
                    calendarEventRef: null
                  }
                }
              ]
            }
          }
        })
      ]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Standup is set for 10:15");
    expect(html).toContain("See the calendar change");
    expect(html).not.toContain("The plan has changed since this report.");
  });

  it("shows tonight's sports games and times under a Tonight heading", async () => {
    // FAIL-FIRST at 62ccbb3d: the reader had no "Tonight" copy at all, only a
    // flat list of finished-game scorelines (see
    // proofs/SCREEN-MORNING-READER/fail-first-sports-tonight-62ccbb3d.txt).
    const run = fullRun();
    const editorial = run.sourceMetadata.editorial as { sports: SportsBriefingEvidenceV1 };
    const tonightGame = {
      id: "game-2",
      competitionKey: "nfl",
      startsAt: "2026-09-10T23:15:00.000Z",
      phase: "tonight" as const,
      statusDetail: "8:15 PM",
      headline: "Eagles host the Giants",
      homeShort: "PHI",
      awayShort: "NYG",
      homeScore: null,
      awayScore: null
    };
    const sports = { ...editorial.sports, games: [...editorial.sports.games, tonightGame] };
    const sourceMetadata = { ...run.sourceMetadata, editorial: { ...editorial, sports } };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail({ ...run, sourceMetadata })]
    ]);
    const html = await renderReader(client);
    expect(html).toContain("Tonight");
    expect(html).toContain("NYG at PHI");
  });

  // B2 fail-first: the jump links were plain fragment anchors with no click
  // handler, so focus stayed on the link instead of moving to the section.
  it("moves focus to the Sports section when its jump link is used", async () => {
    await renderReader(
      seedClient([[queryKeys.briefings.run("def-morning", "run-full"), readyDetail(fullRun())]])
    );
    const sportsLink = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent === "Sports ↓"
    )!;
    act(() => sportsLink.click());
    expect(document.activeElement?.id).toBe("brief-reader-sports");
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
            events: [],
            now: new Date(NOW),
            dayPlanLoading: false,
            dayPlanError: false,
            calendarError: false,
            dayPlan: acceptPlanResponse(),
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
    expect(document.body.innerHTML).toContain("Review proposed blocks");
    expect(document.body.innerHTML).toContain("Accept all time blocks");
  });

  it("shows feedback and preserves task-block choices when a retry request fails", async () => {
    const failedDetail: GetBriefingRunResponse = {
      state: "failed",
      run: null,
      latest: false,
      plan: null
    };
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/run") && init?.method === "POST")
        return Response.json({ message: "temporary failure" }, { status: 503 });
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
            tasks: [
              task("t1", "Draft proposal"),
              task("t2", "Send follow-up"),
              task("t3", "Book room")
            ],
            locale,
            dayPlan: acceptPlanResponse(),
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

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The retry request couldn’t be confirmed"
    );
    expect(document.body.innerHTML).toContain("Review proposed blocks");
    expect(document.body.innerHTML).toContain("Accept all time blocks");
    expect(retry!.disabled).toBe(false);
  });
});

describe("MorningBriefingReader review footer", () => {
  function footerButtons(): string[] {
    const footer = document.body.querySelector(".brief-reader__footer");
    if (!footer) throw new Error("reader footer did not render");
    return [...footer.querySelectorAll("button")].map((node) => node.textContent ?? "");
  }

  it.each([
    ["no saved plan", {}, "There is no saved plan to review today."],
    ["loading plan", { dayPlanLoading: true }, "Today's plan is still loading."],
    ["failed plan", { dayPlanError: true }, "Today's plan couldn't be loaded."]
  ] as const)(
    "keeps the report open when Review is clicked with a %s",
    async (_state, options, message) => {
      const onReview = vi.fn();
      await renderReader(
        seedClient([[queryKeys.briefings.run("def-morning", "run-full"), readyDetail(fullRun())]]),
        { ...options, onReview }
      );

      const reviewTab = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Review task blocks"
      );
      expect(reviewTab, "expected the Review task blocks tab").toBeDefined();
      await act(async () => reviewTab!.click());

      expect(onReview).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toContain("Protect the launch window");
      expect(document.querySelector('[role="status"]')?.textContent).toContain(message);
    }
  );

  it("allows Review with a saved plan that has zero task blocks", async () => {
    const plan = acceptPlanResponse();
    if (!plan.plan) throw new Error("plan missing for the empty-review case");
    const onReview = vi.fn();
    await renderReader(seedClient([]), {
      dayPlan: { ...plan, plan: { ...plan.plan, blocks: [] } },
      onReview
    });

    const reviewTab = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Review task blocks"
    );
    expect(reviewTab, "expected the Review task blocks tab").toBeDefined();
    await act(async () => reviewTab!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("puts Review proposed blocks first, then Accept all, in the proposed surface", async () => {
    await renderReader(seedClient([]), { dayPlan: acceptPlanResponse() });
    expect(footerButtons()).toEqual([
      "Review proposed blocks",
      "Accept all time blocks",
      "Back to Today"
    ]);
  });

  it("keeps Review proposed blocks first even when a move is pending", async () => {
    await renderReader(seedClient([]), { dayPlan: moveBlock(acceptPlanResponse(), "b2") });
    expect(footerButtons()).toEqual(["Review proposed blocks", "Review changes", "Back to Today"]);
  });

  it("puts the Adjust task blocks link before Accept all in the automatic surface", async () => {
    const proposed = acceptPlanResponse();
    if (!proposed.plan) throw new Error("plan missing for the automatic-surface case");
    const withOneCommitted: GetDayPlanResponse = {
      ...proposed,
      plan: {
        ...proposed.plan,
        blocks: [
          {
            ...proposed.plan.blocks[0]!,
            pendingChange: null,
            actualPlacement: {
              startsAt: "2026-09-10T16:00:00.000Z",
              durationMinutes: 30,
              calendarEventRef: "evt-1"
            }
          },
          proposed.plan.blocks[1]!,
          proposed.plan.blocks[2]!
        ]
      }
    };
    await renderReader(seedClient([]), { dayPlan: withOneCommitted });
    expect(footerButtons()).toEqual([
      "Adjust task blocks",
      "Accept all time blocks",
      "Back to Today"
    ]);
  });

  // B5 / Architect R1.2, F1: Moss has already placed the automatic Read's
  // blocks, so a still-pending row keeps its long-form label there. Only
  // the proposed Read gets the short "· Proposed" rail caption.
  it("shows no short Proposed caption on the automatic surface", async () => {
    const proposed = acceptPlanResponse();
    if (!proposed.plan) throw new Error("plan missing for the automatic-surface case");
    const withOneCommitted: GetDayPlanResponse = {
      ...proposed,
      plan: {
        ...proposed.plan,
        blocks: [
          {
            ...proposed.plan.blocks[0]!,
            pendingChange: null,
            actualPlacement: {
              startsAt: "2026-09-10T16:00:00.000Z",
              durationMinutes: 30,
              calendarEventRef: "evt-1"
            }
          },
          proposed.plan.blocks[1]!,
          proposed.plan.blocks[2]!
        ]
      }
    };
    const html = await renderReader(seedClient([]), { dayPlan: withOneCommitted });
    expect(html).toContain('data-briefing-surface="automatic-read"');
    expect(html).not.toContain("· Proposed<");
    expect(html).toContain("Change pending");
  });

  // B3 fail-first: before the fix this read "Review task blocks" (it
  // followed the settings-level mode) with no primary button at all.
  it("makes Adjust task blocks the primary button when nothing awaits acceptance", async () => {
    const base = acceptPlanResponse();
    if (!base.plan) throw new Error("plan missing for the automatic-surface case");
    const committed: DayPlanBlockDto = {
      ...base.plan.blocks[0]!,
      pendingChange: null,
      actualPlacement: {
        startsAt: "2026-09-10T16:00:00.000Z",
        durationMinutes: 30,
        calendarEventRef: null
      }
    };
    await renderReader(seedClient([]), {
      dayPlan: { ...base, plan: { ...base.plan, blocks: [committed] } }
    });
    expect(footerButtons()).toEqual(["Adjust task blocks", "Back to Today"]);
    const adjustButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Adjust task blocks"
    );
    expect(adjustButton?.className).toContain("primary");
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
    expect(accept).toBe(1);
    const target = document.body.querySelector(
      ".brief-reader__footer-actions .jds-btn--primary"
    ) as HTMLButtonElement;
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
    expect(strip.parentElement).toBe(footer);
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
    const target = document.body.querySelector(
      ".brief-reader__footer-actions .jds-btn--primary"
    ) as HTMLButtonElement;
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

describe("MorningBriefingReader Read surface", () => {
  function committedBlock(): DayPlanBlockDto {
    return {
      id: "b-auto",
      kind: "focus",
      taskId: "t1",
      title: null,
      position: 0,
      actualPlacement: {
        startsAt: "2026-09-10T16:00:00.000Z",
        durationMinutes: 30,
        calendarEventRef: "vp-existing"
      },
      pendingChange: null
    };
  }

  function planWith(blocks: DayPlanBlockDto[]): GetDayPlanResponse {
    const base = acceptPlanResponse();
    if (!base.plan) throw new Error("plan missing for the surface case");
    return { ...base, plan: { ...base.plan, blocks } };
  }

  it("marks the automatic-read surface when the plan carries a committed placement", async () => {
    const run = fullRun();
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client, { dayPlan: planWith([committedBlock()]) });
    expect(html).toContain('data-briefing-surface="automatic-read"');
  });

  it("marks the proposed-read surface when the plan has no committed placement", async () => {
    const run = fullRun();
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client, { dayPlan: acceptPlanResponse() });
    expect(html).toContain('data-briefing-surface="proposed-read"');
    expect(html).not.toContain('data-briefing-surface="automatic-read"');
  });
});
