// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BriefingDefinitionDto, BriefingRunDto, MeResponse } from "@moss/shared";
import { localDay } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { TodayPage } from "../../apps/web/src/today/today-page.js";
import {
  EVENING_READ_FULL_LABEL,
  EVENING_SOURCES_LABEL
} from "../../apps/web/src/today/today-labels.js";
import {
  cleanupRoots,
  flushQueries,
  liveRoots,
  locale,
  readyDetail,
  seedClient
} from "./morning-briefing-fixtures.js";

// 7:30 pm in Los Angeles, after the 19:00 evening gate.
const NOW = new Date("2026-06-30T02:30:00.000Z");

let scrolled: Element[] = [];

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
  );
});

afterEach(async () => {
  await cleanupRoots();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Today evening hero links", () => {
  it("opens the evening report in the briefing reader", async () => {
    await renderEveningToday();

    await click(heroButton(EVENING_READ_FULL_LABEL));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const text = dialog?.textContent ?? "";
    expect(text).toContain("Moss / Evening briefing");
    expect(text).toContain("Your day, reviewed.");
    expect(text).toContain("Wrapped the launch notes.");
    expect(text).not.toContain("Morning briefing");
    expect(text).not.toContain("Review task blocks");
    expect(text).not.toContain("Adjust task blocks");
    expect(text).not.toContain("No evening priorities were available");
    expect(dialog?.querySelector('[role="tablist"]')).toBeNull();
    const sources = dialog?.querySelector<HTMLDetailsElement>(".brief-reader__sources");
    expect(sources?.open).toBe(false);
    expect(scrolled).not.toContain(sources);
  });

  it("opens the evening report at its sources from the sources link", async () => {
    await renderEveningToday();

    await click(heroButton(EVENING_SOURCES_LABEL));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Moss / Evening briefing");
    const sources = dialog?.querySelector<HTMLDetailsElement>(".brief-reader__sources");
    expect(sources?.open).toBe(true);
    expect(scrolled).toContain(sources);
    expect(document.activeElement).toBe(sources?.querySelector("summary"));
  });
});

async function renderEveningToday(): Promise<void> {
  const definition = eveningDefinition();
  const run = eveningRun();
  const client = seedClient([
    [queryKeys.settings.locale, { locale }],
    [queryKeys.tasks.list, { tasks: [] }],
    [queryKeys.tasks.lists, { lists: [] }],
    [queryKeys.calendar.list, { events: [] }],
    [
      queryKeys.calendar.dayPlan(localDay(NOW, locale.timezone), locale.timezone),
      {
        plan: null,
        tasks: [],
        unavailableTaskIds: [],
        sourceRun: null,
        sourceRunUnavailable: false
      }
    ],
    [queryKeys.briefings.definitions, { definitions: [definition] }],
    [queryKeys.briefings.runs(definition.id), { runs: [run] }],
    [queryKeys.briefings.run(definition.id, run.id), readyDetail(run)],
    [queryKeys.goals.list, { items: [] }],
    [queryKeys.settings.persona, { persona: { assistantName: "Moss", personaText: "" } }]
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  liveRoots.push(root);
  await act(async () => {
    root.render(
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
  });
  await flushQueries(2);
}

function heroButton(label: string): HTMLButtonElement {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(".today-hero__links .jds-btn--link")
  ].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`no hero link named ${label}`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await flushQueries(2);
}

function eveningDefinition(): BriefingDefinitionDto {
  return {
    id: "evening-1",
    ownerUserId: "user-1",
    title: "Evening review",
    briefingType: "evening",
    cadence: "daily",
    scheduleMetadata: {
      version: 1,
      targetTime: "19:00",
      timezone: locale.timezone,
      quietHoursBehavior: "defer_notification"
    },
    enabled: true,
    selectedToolNames: ["tasks.search"],
    lastRunAt: null,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z"
  };
}

function eveningRun(): BriefingRunDto {
  return {
    id: "run-evening",
    definitionId: "evening-1",
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "scheduled",
    briefingType: "evening",
    summaryText: "Wrapped the launch notes. The team cleared the blockers.",
    sourceMetadata: {
      sourceTimestamps: {
        version: 1,
        capturedAt: "2026-06-30T02:10:00.000Z",
        sources: [
          { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-30T02:10:00.000Z" }
        ]
      }
    },
    feedbackItems: [],
    structuredPayload: { version: 1, actionRows: [], catchUp: null },
    createdAt: "2026-06-30T02:15:00.000Z"
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
