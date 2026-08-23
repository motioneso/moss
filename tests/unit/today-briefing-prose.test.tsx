import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type {
  BriefingDefinitionDto,
  BriefingActionRowDto,
  BriefingRunDto,
  LocaleSettingsDto,
  MeResponse,
  OnboardingStatusResponse,
  TaskDto
} from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { TodayPage } from "../../apps/web/src/today/today-page.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

describe("Today morning briefing prose", () => {
  it("renders full morning prose before Start here with authored loading empty and stale states", () => {
    const morning = briefingDefinition({
      id: "morning-1",
      title: "Morning briefing",
      briefingType: "morning"
    });
    const evening = briefingDefinition({ id: "evening-1", targetTime: "19:00" });
    const summaryText = "The day opens with a clear priority.\n\nKeep the afternoon flexible.";
    const html = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [morning, evening],
      runs: [
        briefingRun({
          definitionId: morning.id,
          briefingType: "morning",
          summaryText,
          sourceMetadata: {
            sourceTimestamps: {
              version: 1,
              capturedAt: "2026-06-29T01:30:00.000Z",
              sources: [
                {
                  source: "email",
                  freshnessKind: "connector_sync",
                  asOf: "2026-06-27T01:30:00.000Z"
                }
              ]
            }
          }
        })
      ]
    });

    expect(html.indexOf("Morning briefing")).toBeLessThan(html.indexOf("Start here"));
    expect(html).toContain("The day opens with a clear priority.");
    expect(html).toContain("Keep the afternoon flexible.");
    expect(html).toContain("Some sources are over a day old");
    expect(html).toContain("Email");

    const emptyHtml = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [morning, evening],
      runs: []
    });
    expect(emptyHtml).toContain("Your morning briefing is not ready yet.");

    const loadingHtml = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: undefined,
      runs: []
    });
    expect(loadingHtml).toContain("Gathering your morning briefing…");

    const disabledHtml = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [{ ...morning, enabled: false }, evening],
      runs: []
    });
    expect(disabledHtml).not.toContain("Morning briefing");
  });

  it("enables Reply only when a provider is ready", () => {
    const morning = briefingDefinition({
      id: "morning-1",
      title: "Morning briefing",
      briefingType: "morning"
    });
    const replyRow: BriefingActionRowDto = {
      taskId: "reply-task",
      title: "Reply to Alex",
      explanation: "Alex needs a response.",
      category: "needs_reply",
      status: "suggested",
      primaryAction: { kind: "reply", cacheMessageId: "cache-1" },
      source: "email",
      sourceLabel: "Email",
      sourceRef: "account:message",
      sourceHref: null,
      dueAt: null,
      computedAt: "2026-06-30T01:00:00.000Z",
      resurfaceReason: null
    };
    const replyTask: TaskDto = {
      id: "reply-task",
      ownerUserId: "user-1",
      listId: "list-1",
      parentTaskId: null,
      title: "Reply to Alex",
      description: "Alex needs a response.",
      status: "suggested",
      priority: 2,
      position: 0,
      dueAt: null,
      doAt: null,
      effort: null,
      source: "email",
      sourceRef: "account:message",
      completedAt: null,
      createdAt: "2026-06-30T01:00:00.000Z",
      updatedAt: "2026-06-30T01:00:00.000Z",
      tags: [],
      suggestionMetadata: null
    };
    const runs = [
      briefingRun({
        structuredPayload: { version: 1, actionRows: [replyRow], catchUp: null }
      })
    ];
    let blockedOpenChatCalls = 0;
    const blocked = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [morning],
      runs,
      tasks: [replyTask],
      onboardingStatus: onboardingStatus("needs_login"),
      openChatWith: () => {
        blockedOpenChatCalls += 1;
      }
    });

    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Reply<\/button>/);
    expect(blockedOpenChatCalls).toBe(0);

    const ready = renderToday({
      now: new Date("2026-06-30T01:30:00.000Z"),
      definitions: [morning],
      runs,
      tasks: [replyTask],
      onboardingStatus: onboardingStatus("ready")
    });

    expect(ready).toMatch(/<button[^>]*>Reply<\/button>/);
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Reply<\/button>/);
  });
});

function renderToday(input: {
  readonly now: Date;
  readonly definitions: readonly BriefingDefinitionDto[] | undefined;
  readonly runs: readonly BriefingRunDto[];
  readonly tasks?: readonly TaskDto[];
  readonly onboardingStatus?: OnboardingStatusResponse;
  readonly openChatWith?: (prompt: string) => void;
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
    client.setQueryData(queryKeys.tasks.list, { tasks: input.tasks ?? [] });
    client.setQueryData(queryKeys.tasks.lists, { lists: [] });
    client.setQueryData(queryKeys.calendar.list, { events: [] });
    client.setQueryData(queryKeys.goals.list, { items: [] });
    if (input.onboardingStatus) {
      client.setQueryData(queryKeys.onboarding.status, input.onboardingStatus);
    }
    if (input.definitions) {
      client.setQueryData(queryKeys.briefings.definitions, { definitions: input.definitions });
      for (const definition of input.definitions) {
        client.setQueryData(queryKeys.briefings.runs(definition.id), {
          runs: input.runs.filter((run) => run.definitionId === definition.id)
        });
      }
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
              openChatWith: input.openChatWith ?? (() => undefined),
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

function onboardingStatus(installState: "needs_login" | "ready"): OnboardingStatusResponse {
  return {
    role: "founder",
    state: "completed",
    steps: {
      cliAuth: {
        done: installState === "ready",
        providers: [{ kind: "anthropic", cliPresent: true, installState }]
      },
      connectors: { done: false }
    }
  };
}

function briefingDefinition(
  overrides: Partial<BriefingDefinitionDto> & {
    readonly id?: string;
    readonly targetTime?: string;
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
      timezone: locale.timezone,
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
    definitionId: "morning-1",
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "scheduled",
    briefingType: "morning",
    summaryText: "Morning summary",
    sourceMetadata: {},
    feedbackItems: [],
    structuredPayload: { version: 1, actionRows: [], catchUp: null },
    createdAt: "2026-06-30T01:15:00.000Z",
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
