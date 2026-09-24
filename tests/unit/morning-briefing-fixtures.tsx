// @vitest-environment jsdom
//
// Shared render harness and fixtures for the morning-briefing reader tests.
// Split out of morning-briefing.test.tsx to keep that file under the
// repo's line-count cap; every describe block there imports from here.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  ApplyExecutionItemReport,
  BriefingActionRowDto,
  BriefingRunDto,
  DayPlanBlockDto,
  GetBriefingRunResponse,
  GetDayPlanResponse,
  LocaleSettingsDto,
  TaskDto
} from "@moss/shared";

import type { DayPlanReviewController } from "../../apps/web/src/today/day-plan-review-controller.js";
import { defaultChoiceFor } from "../../apps/web/src/today/day-plan-review-model.js";
import { MorningBriefingReader } from "../../apps/web/src/today/morning-briefing.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

export const NOW = "2026-09-10T16:00:00.000Z";

export function task(id: string, title: string): TaskDto {
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

export function row(
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

export function fullRun(): BriefingRunDto {
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

export function readyDetail(
  run: BriefingRunDto,
  overrides: Partial<GetBriefingRunResponse> = {}
): GetBriefingRunResponse {
  return { state: "ready", run, latest: true, plan: null, ...overrides };
}

export function seedClient(
  entries: readonly (readonly [readonly unknown[], unknown])[]
): QueryClient {
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

export const liveRoots: ReturnType<typeof createRoot>[] = [];

export function stubReaderController(
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
    expectOwnWrite: () => undefined,
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

export function acceptBlock(
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

export function acceptPlanResponse(): GetDayPlanResponse {
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

export function moveBlock(response: GetDayPlanResponse, id: string): GetDayPlanResponse {
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

export function appliedOutcome(blockId: string, outcome: ApplyExecutionItemReport["outcome"]) {
  return {
    [blockId]: { itemId: `item-${blockId}`, blockId, outcome, result: null }
  };
}

export async function renderReader(
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

export async function flushQueries(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

export async function cleanupRoots(): Promise<void> {
  for (const root of liveRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
}
