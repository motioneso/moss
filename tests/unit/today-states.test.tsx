// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BriefingDefinitionDto,
  BriefingRunDto,
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanDto,
  DayPlanTaskSummary,
  GetDayPlanResponse,
  LocaleSettingsDto,
  MeResponse
} from "@moss/shared";
import { localDay } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { DayPlanSection } from "../../apps/web/src/today/day-plan.js";
import { BriefingActionRowsSection } from "../../apps/web/src/today/briefing-action-rows.js";
import { EveningReviewSection } from "../../apps/web/src/today/evening-mode.js";
import { TodayPage } from "../../apps/web/src/today/today-page.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const me: MeResponse = {
  user: {
    id: "user-1",
    email: "ben@example.com",
    emailVerified: true,
    name: "Ben",
    isInstanceAdmin: true,
    status: "active",
    isBootstrapOwner: true,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

// Fixed wall clock; event times below derive from it so they always land inside
// today's UTC day no matter when the suite runs.
const NOW = new Date("2026-06-30T16:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function clocked(hoursFromNow: number, minutes = 0): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000 + minutes * 60_000).toISOString();
}

function events(): CalendarEventDto[] {
  return [
    {
      id: "e1",
      connectorAccountId: "account-1",
      ownerUserId: "user-1",
      title: "Standup",
      startsAt: clocked(0.5),
      endsAt: clocked(1),
      location: "Room A",
      summary: null,
      bodyExcerpt: null,
      externalId: "ext-e1",
      isMossBlock: false,
      allDay: false,
      attendeeCount: 0,
      status: null,
      createdAt: clocked(-24),
      updatedAt: clocked(-24)
    }
  ];
}

function tasks(): DayPlanTaskSummary[] {
  return [
    { id: "t1", title: "Write the draft", status: "todo", dueAt: null, doAt: null, effort: null }
  ];
}

function plan(blocks: DayPlanBlockDto[]): DayPlanDto {
  return {
    id: "plan-1",
    localDay: "2026-06-30",
    timeZone: locale.timezone,
    revision: 1,
    sourceRunId: null,
    blocks,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    }
  };
}

function placed(id: string, title: string | null, position: number): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: "t1",
    title,
    position,
    actualPlacement: {
      startsAt: clocked(1),
      durationMinutes: 60,
      calendarEventRef: null
    },
    pendingChange: null
  };
}

function renderSection(input: {
  readonly plan?: DayPlanDto | null;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly calendarError?: boolean;
  readonly withEvents?: boolean;
}): string {
  return renderToString(
    createElement(DayPlanSection, {
      dayPlan: {
        plan: input.plan ?? null,
        tasks: tasks(),
        unavailableTaskIds: [],
        sourceRun: null,
        sourceRunUnavailable: false
      },
      events: input.withEvents === false ? [] : events(),
      locale,
      now: NOW,
      loading: input.loading ?? false,
      error: input.error ?? false,
      calendarError: input.calendarError ?? false,
      onOpenTask: () => undefined
    })
  );
}

describe("DayPlanSection calendar failure", () => {
  it("shows the saved plan with the calendar line and never an empty day", () => {
    const html = renderSection({
      plan: plan([placed("b1", null, 0)]),
      calendarError: true
    });
    expect(html).toContain("Calendar isn&#x27;t available right now; showing your saved plan.");
    expect(html).toContain("Write the draft");
    expect(html).not.toContain("Nothing on the schedule yet.");
  });

  it("shows the combined line with no items when the plan fails too", () => {
    const html = renderSection({ plan: null, error: true, calendarError: true });
    expect(html).toContain("Calendar and saved plan aren&#x27;t available right now.");
    expect(html).not.toContain("Write the draft");
    expect(html).not.toContain("Standup");
    expect(html).not.toContain("Nothing on the schedule yet.");
  });

  it("announces the failure lines as status", () => {
    const calendar = renderSection({
      plan: plan([placed("b1", null, 0)]),
      calendarError: true
    });
    expect(calendar).toContain('role="status"');
    const combined = renderSection({ plan: null, error: true, calendarError: true });
    expect(combined).toContain('role="status"');
  });
});

describe("DayPlanSection pending plan", () => {
  it("keeps loaded events visible under the progress line", () => {
    const html = renderSection({ loading: true });
    expect(html).toContain("Gathering your day plan…");
    expect(html).toContain("Standup");
    expect(html).toContain("Room A");
  });
});

function seedPage(input: {
  readonly definitions?: readonly BriefingDefinitionDto[];
  readonly runs?: { readonly definitionId: string; readonly runs: readonly BriefingRunDto[] };
}): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.settings.locale, { locale });
  client.setQueryData(queryKeys.tasks.list, { tasks: [] });
  client.setQueryData(queryKeys.tasks.lists, { lists: [] });
  client.setQueryData(queryKeys.calendar.list, { events: [] });
  client.setQueryData(queryKeys.goals.list, { items: [] });
  client.setQueryData(queryKeys.briefings.definitions, {
    definitions: [...(input.definitions ?? [])]
  });
  if (input.runs) {
    client.setQueryData(queryKeys.briefings.runs(input.runs.definitionId), {
      runs: [...input.runs.runs]
    });
  }
  client.setQueryData(queryKeys.calendar.dayPlan(localDay(NOW, locale.timezone), locale.timezone), {
    plan: null,
    tasks: [],
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  } satisfies GetDayPlanResponse);
  return client;
}

function renderPage(client: QueryClient): string {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        ChatControlsProvider,
        {
          value: {
            openChat: () => undefined,
            openChatWith: () => undefined,
            openAssistantWithDraft: () => undefined
          }
        },
        createElement(
          MemoryRouter,
          null,
          createElement(TodayPage, {
            me,
            wellnessEnabled: false,
            disabledModuleIds: ["news", "sports", "workshop"]
          })
        )
      )
    )
  );
}

function morningDefinition(): BriefingDefinitionDto {
  return {
    id: "def-morning",
    ownerUserId: "user-1",
    title: "Morning",
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { version: 1, targetTime: "07:00", timezone: "UTC" },
    enabled: true,
    selectedToolNames: [],
    lastRunAt: null,
    createdAt: clocked(-24),
    updatedAt: clocked(-24)
  };
}

describe("TodayPage quiet day", () => {
  it("hides stat tiles, keeps the factual empty line and the dock hosts", () => {
    const html = renderPage(seedPage({}));
    expect(html).not.toContain("cmd-glance");
    expect(html).not.toContain("jds-stat-tile");
    expect(html).toContain("Nothing on the schedule yet.");
    expect(html).toContain("Nothing pressing right now.");
    expect(html).toContain('id="widgets"');
  });
});

describe("TodayPage stale source", () => {
  it("names the stale source while the schedule still renders", () => {
    const capturedAt = NOW.toISOString();
    const run: BriefingRunDto = {
      id: "run-1",
      definitionId: "def-morning",
      ownerUserId: "user-1",
      status: "succeeded",
      runKind: "scheduled",
      briefingType: "morning",
      summaryText: "",
      sourceMetadata: {
        sourceTimestamps: {
          version: 1,
          capturedAt,
          sources: [
            {
              source: "email",
              freshnessKind: "connector_sync",
              asOf: new Date(Date.now() - 2 * 86_400_000).toISOString()
            }
          ]
        }
      },
      feedbackItems: [],
      structuredPayload: { version: 1, actionRows: [], catchUp: null },
      createdAt: capturedAt
    };
    const html = renderPage(
      seedPage({
        definitions: [morningDefinition()],
        runs: { definitionId: "def-morning", runs: [run] }
      })
    );
    expect(html).toContain("over a day old");
    expect(html).toContain("Email");
    expect(html).toContain("Nothing on the schedule yet.");
  });
});

describe("TodayPage remaining progress lines", () => {
  function providers(client: QueryClient, element: ReactElement): ReactElement {
    return createElement(
      QueryClientProvider,
      { client },
      createElement(
        ChatControlsProvider,
        {
          value: {
            openChat: () => undefined,
            openChatWith: () => undefined,
            openAssistantWithDraft: () => undefined
          }
        },
        createElement(MemoryRouter, null, element)
      )
    );
  }

  it("announces the needs-you progress line as status", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    const html = renderToString(
      providers(
        client,
        createElement(BriefingActionRowsSection, {
          run: null,
          loading: true,
          tasks: [],
          locale,
          chatAvailable: false,
          onOpenTask: () => undefined
        })
      )
    );
    expect(html).toContain("Checking what needs you…");
    expect(html).toContain('role="status"');
  });

  it("announces the evening progress line as status", () => {
    const html = renderToString(
      createElement(EveningReviewSection, {
        kind: "compact",
        run: null,
        loading: true,
        locale,
        targetTime: "23:00",
        onFeedbackChanged: () => undefined
      })
    );
    expect(html).toContain("Gathering your evening review…");
    expect(html).toContain('role="status"');
  });
});

const widgetMockState = vi.hoisted(() => ({ failIds: new Set<string>() }));

vi.mock("virtual:moss-module-web", () => {
  const entry = (moduleId: string) => ({
    moduleId,
    load: async () => {
      if (widgetMockState.failIds.has(moduleId)) throw new Error(`load failed for ${moduleId}`);
      return {
        default: {
          todayWidgets: [
            { slot: "brief", element: createElement("div", null, `${moduleId} widget`) }
          ]
        }
      };
    }
  });
  return { MODULE_WEB_CONTRIBUTIONS: [entry("news"), entry("sports"), entry("workshop")] };
});

describe("TodayPage widget failure line", () => {
  it("announces the recovery line as status while the sibling renders", async () => {
    const { act, create } = await import("react-test-renderer");
    const { ModuleTodayWidgets } = await import("../../apps/web/src/today/module-today-widgets.js");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    widgetMockState.failIds.add("news");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ModuleTodayWidgets, { disabledModuleIds: [] })
        )
      );
    });
    try {
      const out: string[] = [];
      const walk = (node: unknown): void => {
        if (typeof node === "string") {
          out.push(node);
          return;
        }
        for (const child of (node as { children: unknown[] }).children ?? []) walk(child);
      };
      walk(renderer!.root);
      const text = out.join(" ");
      expect(text).toContain("load this widget right now");
      expect(text).toContain("sports widget");
      const statuses = renderer!.root.findAll((node) => node.props?.role === "status");
      expect(statuses.length).toBeGreaterThan(0);
    } finally {
      renderer?.unmount();
      widgetMockState.failIds.clear();
    }
  });
});

describe("TodayPage background refetch", () => {
  it("keeps the open task dialog and its typed input across a tasks and plan refetch", async () => {
    const { act, create } = await import("react-test-renderer");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const task = {
      id: "task-1",
      ownerUserId: "user-1",
      listId: "list-1",
      parentTaskId: null,
      title: "Write the draft",
      description: null,
      status: "todo",
      priority: null,
      position: 0,
      dueAt: null,
      doAt: null,
      effort: null,
      source: "manual",
      sourceRef: null,
      completedAt: null,
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      tags: [],
      suggestionMetadata: null
    } as const;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData(queryKeys.settings.locale, { locale });
    client.setQueryData(queryKeys.tasks.list, { tasks: [task] });
    client.setQueryData(queryKeys.tasks.lists, { lists: [] });
    client.setQueryData(queryKeys.tasks.detail("task-1"), { task });
    client.setQueryData(queryKeys.tasks.subtasks("task-1"), { tasks: [] });
    client.setQueryData(queryKeys.tasks.activity("task-1"), { activity: [] });
    client.setQueryData(queryKeys.tasks.tags("list-1"), { tags: [] });
    client.setQueryData(queryKeys.calendar.list, { events: [] });
    client.setQueryData(queryKeys.goals.list, { items: [] });
    client.setQueryData(queryKeys.briefings.definitions, { definitions: [] });
    const dayPlanKey = queryKeys.calendar.dayPlan(localDay(NOW, locale.timezone), locale.timezone);
    const emptyPlan = {
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      sourceRun: null,
      sourceRunUnavailable: false
    } satisfies GetDayPlanResponse;
    client.setQueryData(dayPlanKey, emptyPlan);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            ChatControlsProvider,
            {
              value: {
                openChat: () => undefined,
                openChatWith: () => undefined,
                openAssistantWithDraft: () => undefined
              }
            },
            createElement(
              MemoryRouter,
              null,
              createElement(TodayPage, {
                me,
                wellnessEnabled: false,
                disabledModuleIds: ["news", "sports", "workshop"]
              })
            )
          )
        )
      );
    });
    try {
      const texts = (node: { children: readonly unknown[] }): string => {
        const out: string[] = [];
        const walk = (child: unknown): void => {
          if (typeof child === "string") {
            out.push(child);
            return;
          }
          for (const grandchild of (child as { children: readonly unknown[] }).children ?? []) {
            walk(grandchild);
          }
        };
        for (const child of node.children) walk(child);
        return out.join(" ");
      };
      const opener = renderer!.root
        .findAllByType("button")
        .find((button) => texts(button).includes("Write the draft"));
      if (!opener) throw new Error("task open button not found");
      await act(async () => {
        opener.props.onClick();
      });
      const titleInput = renderer!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "Task title");
      if (!titleInput) throw new Error("task title input not found");
      await act(async () => {
        titleInput.props.onChange({ target: { value: "Edited draft title" } });
      });
      // A background refetch of the task list and the day plan arrives.
      await act(async () => {
        client.setQueryData(queryKeys.tasks.list, {
          tasks: [{ ...task, title: "Write the draft" }]
        });
        client.setQueryData(dayPlanKey, { ...emptyPlan });
      });
      const kept = renderer!.root
        .findAllByType("input")
        .find((input) => input.props["aria-label"] === "Task title");
      expect(kept, "dialog stays open across the refetch").toBeDefined();
      expect(kept!.props.value).toBe("Edited draft title");
    } finally {
      renderer?.unmount();
    }
  });
});
