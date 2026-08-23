import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BriefingDefinitionDto,
  BriefingRunDto,
  CalendarEventDto,
  LocaleSettingsDto,
  MeResponse,
  TaskDto
} from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import {
  deriveTodayMode,
  latestEveningRunForToday,
  scheduleTodayModeRefresh,
  selectActionRowsRun
} from "../../apps/web/src/today/evening-mode.js";
import { TodayPage } from "../../apps/web/src/today/today-page.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

describe("deriveTodayMode", () => {
  it("keeps day mode before the evening target time and flips at the boundary", () => {
    const definition = briefingDefinition({ targetTime: "19:00", timezone: locale.timezone });

    expect(deriveTodayMode(definition, locale, new Date("2026-06-30T01:59:00.000Z"))).toBe("day");
    expect(deriveTodayMode(definition, locale, new Date("2026-06-30T02:00:00.000Z"))).toBe(
      "evening"
    );
  });

  it("stays day mode when evening briefing is disabled", () => {
    expect(
      deriveTodayMode(
        briefingDefinition({ enabled: false, targetTime: "19:00", timezone: locale.timezone }),
        locale,
        new Date("2026-06-30T02:00:00.000Z")
      )
    ).toBe("day");
  });
});

describe("latestEveningRunForToday", () => {
  it("ignores older evening runs in the user's timezone", () => {
    const today = briefingRun({
      id: "run-today",
      createdAt: "2026-06-30T02:15:00.000Z",
      summaryText: "Today"
    });
    const yesterday = briefingRun({
      id: "run-yesterday",
      createdAt: "2026-06-29T02:15:00.000Z",
      summaryText: "Yesterday"
    });

    expect(
      latestEveningRunForToday(
        [yesterday, today],
        locale.timezone,
        new Date("2026-06-30T03:00:00.000Z")
      )?.id
    ).toBe("run-today");
  });
});

describe("scheduleTodayModeRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("promotes an already-open Today page when the evening gate arrives", async () => {
    const definition = briefingDefinition({ targetTime: "19:00", timezone: locale.timezone });
    vi.setSystemTime(new Date("2026-06-30T01:59:00.000Z"));
    let renderedNow = new Date(Date.now());

    const stop = scheduleTodayModeRefresh(definition, locale, () => {
      renderedNow = new Date(Date.now());
    });

    expect(deriveTodayMode(definition, locale, renderedNow)).toBe("day");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(deriveTodayMode(definition, locale, renderedNow)).toBe("day");
    await vi.advanceTimersByTimeAsync(1);
    expect(deriveTodayMode(definition, locale, renderedNow)).toBe("evening");

    stop();
  });
});

describe("selectActionRowsRun", () => {
  it("day selects morning payload and evening selects outstanding evening payload", () => {
    const morningRun = briefingRun({ id: "morning-run" });
    const eveningRun = briefingRun({ id: "evening-run" });

    expect(selectActionRowsRun("day", morningRun, eveningRun)).toBe(morningRun);
    expect(selectActionRowsRun("evening", morningRun, eveningRun)).toBe(eveningRun);
    expect(selectActionRowsRun("day", null, eveningRun)).toBeNull();
    expect(selectActionRowsRun("evening", morningRun, null)).toBeNull();
  });
});

describe("TodayPage evening mode", () => {
  it("does not wait for runs when the morning briefing is absent", () => {
    const html = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [],
      runs: [],
      tasks: [],
      events: []
    });

    expect(html).not.toContain("Checking what needs you");
  });

  it("leads with the readable evening review after the time gate", () => {
    const definition = briefingDefinition({ targetTime: "19:00", timezone: locale.timezone });
    const run = briefingRun({
      createdAt: "2026-06-30T02:15:00.000Z",
      summaryText: "Wrapped the launch notes.\n\n- Sent follow-ups\n- Cleared blockers"
    });
    const html = renderToday({
      now: new Date("2026-06-30T02:30:00.000Z"),
      definitions: [definition],
      runs: [run],
      tasks: [
        task({
          id: "task-done",
          title: "Ship release note",
          status: "done",
          completedAt: "2026-06-30T01:00:00.000Z"
        }),
        task({
          id: "task-open",
          title: "Reply to Alex",
          dueAt: "2026-06-30T20:00:00.000Z"
        })
      ],
      events: [
        calendarEvent({
          id: "tomorrow-1",
          title: "Planning",
          startsAt: "2026-06-30T17:00:00.000Z",
          endsAt: "2026-06-30T17:30:00.000Z"
        })
      ]
    });

    expect(html.indexOf("Evening review")).toBeLessThan(html.indexOf("Start here"));
    expect(html).toContain("What happened today");
    expect(html).toContain("Wrapped the launch notes.");
    expect(html).toContain("Sent follow-ups");
    expect(html).toContain("Accomplished today");
    expect(html).toContain("Carrying forward");
    expect(html).toContain("Tomorrow");
    expect(html.match(/Evening review/g)?.length).toBe(1);
  });

  it("keeps the 220-character cut only on the compact day-mode tile", () => {
    const definition = briefingDefinition({ targetTime: "19:00", timezone: locale.timezone });
    const summaryText = `${"A".repeat(217)} tail that should be clipped`;
    const html = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [definition],
      runs: [briefingRun({ summaryText })],
      tasks: [],
      events: []
    });

    expect(html).toContain(`${"A".repeat(217)}...`);
    expect(html).not.toContain("tail that should be clipped");
  });

  it("keeps the prep-card CTA neutral while the persona name is pending (#1560)", () => {
    const html = renderToday({
      now: new Date("2026-06-30T02:30:00.000Z"),
      definitions: [briefingDefinition({ targetTime: "19:00", timezone: locale.timezone })],
      runs: [],
      tasks: [],
      events: []
    });

    expect(html).toContain(">Chat<");
    expect(html).not.toContain("Chat with Moss");
  });

  it("still shows the configured assistant name once persona resolves (#1560)", () => {
    const html = renderToday({
      now: new Date("2026-06-30T02:30:00.000Z"),
      definitions: [briefingDefinition({ targetTime: "19:00", timezone: locale.timezone })],
      runs: [],
      tasks: [],
      events: [],
      assistantName: "Jarvis"
    });

    expect(html).toContain("Chat with Jarvis");
  });
});

function renderToday(input: {
  readonly now: Date;
  readonly definitions: readonly BriefingDefinitionDto[];
  readonly runs: readonly BriefingRunDto[];
  readonly tasks: readonly TaskDto[];
  readonly events: readonly CalendarEventDto[];
  readonly assistantName?: string;
}): string {
  const previousDocument = globalThis.document;
  const previousDateNow = Date.now;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { getAttribute: () => "light" } }
  });
  Date.now = () => input.now.getTime();

  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.locale, { locale });
    client.setQueryData(queryKeys.tasks.list, { tasks: input.tasks });
    client.setQueryData(queryKeys.tasks.lists, { lists: [] });
    client.setQueryData(queryKeys.calendar.list, { events: input.events });
    client.setQueryData(queryKeys.briefings.definitions, { definitions: input.definitions });
    for (const definition of input.definitions) {
      client.setQueryData(queryKeys.briefings.runs(definition.id), {
        runs: input.runs.filter((run) => run.definitionId === definition.id)
      });
    }
    client.setQueryData(queryKeys.goals.list, { items: [] });
    if (input.assistantName !== undefined) {
      client.setQueryData(queryKeys.settings.persona, {
        persona: { assistantName: input.assistantName, personaText: "" }
      });
    }

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
            createElement(TodayPage, { me, wellnessEnabled: false })
          )
        )
      )
    );
  } finally {
    Date.now = previousDateNow;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument
    });
  }
}

function briefingDefinition(
  overrides: Partial<BriefingDefinitionDto> & {
    readonly targetTime?: string;
    readonly timezone?: string;
  } = {}
): BriefingDefinitionDto {
  return {
    id: "evening-1",
    ownerUserId: "user-1",
    title: "Evening review",
    briefingType: "evening",
    cadence: "daily",
    scheduleMetadata: {
      version: 1,
      targetTime: overrides.targetTime ?? "19:00",
      timezone: overrides.timezone ?? locale.timezone,
      quietHoursBehavior: "defer_notification"
    },
    enabled: true,
    selectedToolNames: ["tasks.search"],
    lastRunAt: null,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides
  };
}

function briefingRun(overrides: Partial<BriefingRunDto> = {}): BriefingRunDto {
  return {
    id: "run-1",
    definitionId: "evening-1",
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "scheduled",
    briefingType: "evening",
    summaryText: "Evening summary",
    sourceMetadata: {},
    feedbackItems: [],
    structuredPayload: { version: 1, actionRows: [], catchUp: null },
    createdAt: "2026-06-30T02:15:00.000Z",
    ...overrides
  };
}

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    ownerUserId: "user-1",
    listId: "list-1",
    parentTaskId: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: 2,
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
    suggestionMetadata: null,
    ...overrides
  };
}

function calendarEvent(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: "event-1",
    connectorAccountId: "account-1",
    ownerUserId: "user-1",
    title: "Event",
    startsAt: "2026-06-30T17:00:00.000Z",
    endsAt: "2026-06-30T17:30:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "external-1",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides
  };
}

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
