// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
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
import { TodayPage } from "../../apps/web/src/today/today-page.js";
import { TodayWeatherRow } from "../../apps/web/src/today/header-weather.js";

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

const NOW = new Date("2026-06-30T16:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function clocked(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function sectionHtml(input: {
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly calendarError?: boolean;
}): string {
  const block: DayPlanBlockDto = {
    id: "b1",
    kind: "focus",
    taskId: "t1",
    title: null,
    position: 0,
    actualPlacement: {
      startsAt: clocked(1),
      durationMinutes: 60,
      calendarEventRef: null
    },
    pendingChange: null
  };
  const task: DayPlanTaskSummary = {
    id: "t1",
    title: "Write the draft",
    status: "todo",
    dueAt: null,
    doAt: null,
    effort: null
  };
  return renderToString(
    createElement(DayPlanSection, {
      dayPlan: {
        plan: {
          id: "plan-1",
          localDay: "2026-06-30",
          timeZone: locale.timezone,
          revision: 1,
          sourceRunId: null,
          blocks: [block],
          eveningIntent: {
            priorityTaskIds: [],
            capacity: null,
            notes: null,
            corrections: [],
            commitments: []
          }
        } satisfies DayPlanDto,
        tasks: [task],
        unavailableTaskIds: [],
        sourceRun: null,
        sourceRunUnavailable: false
      } satisfies GetDayPlanResponse,
      events: [],
      locale,
      now: NOW,
      loading: input.loading ?? false,
      error: input.error ?? false,
      calendarError: input.calendarError ?? false,
      onOpenTask: () => undefined
    })
  );
}

function quietPageHtml(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.settings.locale, { locale });
  client.setQueryData(queryKeys.tasks.list, { tasks: [] });
  client.setQueryData(queryKeys.tasks.lists, { lists: [] });
  client.setQueryData(queryKeys.calendar.list, { events: [] });
  client.setQueryData(queryKeys.goals.list, { items: [] });
  client.setQueryData(queryKeys.briefings.definitions, { definitions: [] });
  client.setQueryData(queryKeys.calendar.dayPlan(localDay(NOW, locale.timezone), locale.timezone), {
    plan: null,
    tasks: [],
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  } satisfies GetDayPlanResponse);
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

function parse(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc;
}

describe("Today status announcements", () => {
  it("announces the plan loading, plan error, calendar and combined lines as status", () => {
    for (const html of [
      sectionHtml({ loading: true }),
      sectionHtml({ error: true }),
      sectionHtml({ calendarError: true }),
      sectionHtml({ error: true, calendarError: true })
    ]) {
      const doc = parse(html);
      expect(doc.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
    }
  });

  it("announces the weather unavailable line as status", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.locale, { locale });
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(TodayWeatherRow, {
            weather: null,
            mode: "day",
            isPending: false,
            isError: false
          })
        )
      )
    );
    const doc = parse(html);
    const status = doc.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Weather isn");
  });
});

describe("Today named controls and order", () => {
  it("gives every button and link on the quiet page an accessible name", () => {
    const doc = parse(quietPageHtml());
    const unnamed: string[] = [];
    doc.querySelectorAll("button, a").forEach((el) => {
      const name = (el.textContent ?? "").trim() || el.getAttribute("aria-label");
      if (!name) unnamed.push(el.outerHTML.slice(0, 80));
    });
    expect(unnamed).toEqual([]);
  });

  it("hides decorative icons from assistive technology", () => {
    const doc = parse(quietPageHtml());
    const exposed: string[] = [];
    doc.querySelectorAll("button svg, a svg").forEach((svg) => {
      if (svg.getAttribute("aria-hidden") !== "true") exposed.push(svg.outerHTML.slice(0, 80));
    });
    expect(exposed).toEqual([]);
  });

  it("places quick actions before the schedule and the widget rail after it", () => {
    const html = quietPageHtml();
    const dock = html.indexOf('class="cmd-dock"');
    const schedule = html.indexOf('id="schedule"');
    expect(dock).toBeGreaterThan(-1);
    expect(dock).toBeLessThan(schedule);
    expect(html.indexOf("<aside")).toBeGreaterThan(schedule);
  });
});

const TODAY_SOURCES = [
  "apps/web/src/today/today-page.tsx",
  "apps/web/src/today/day-plan.tsx",
  "apps/web/src/today/header-weather.tsx",
  "apps/web/src/today/evening-mode.tsx",
  "apps/web/src/today/today-quick-actions.tsx",
  "apps/web/src/today/module-today-widgets.tsx",
  "apps/web/src/today/briefing-action-rows.tsx",
  "apps/web/src/today/briefing-report-shell.tsx",
  "apps/web/src/today/morning-briefing.tsx",
  "apps/web/src/today/briefing-dialog.tsx",
  "apps/web/src/today/day-plan-review.tsx",
  "apps/web/src/today/day-plan-review-row.tsx",
  "apps/web/src/today/evening-planning.tsx",
  "apps/web/src/today/evening-planning-frame.tsx",
  "apps/web/src/today/evening-planning-sections.tsx",
  "apps/web/src/today/evening-planning-review.tsx",
  "apps/web/src/today/briefing-feedback-menu.tsx",
  "apps/web/src/today/brief-task-row.tsx",
  "apps/web/src/today/proactive-cards.tsx"
];

describe("Today source rules", () => {
  it("never uses assertive live regions", () => {
    for (const file of TODAY_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(`${file}: ${source}`).not.toContain('role="alert"');
      expect(`${file}: ${source}`).not.toContain('aria-live="assertive"');
    }
  });

  it("uses no positive tabindex", () => {
    for (const file of TODAY_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(`${file}: ${source}`).not.toMatch(/tabIndex=\{?[1-9]/);
    }
  });

  it("keeps visual order in Today CSS free of order and reverse rules", () => {
    for (const file of [
      "apps/web/src/styles/kit-today.css",
      "apps/web/src/styles/kit-today-feeds.css",
      "apps/web/src/styles/kit-today-misc.css",
      "apps/web/src/styles/kit-briefing-reader.css",
      "apps/web/src/styles/kit-day-plan-review.css",
      "apps/web/src/styles/kit-evening-planning.css",
      "packages/ui/src/styles/components-moss-today.css"
    ]) {
      const source = readFileSync(file, "utf8");
      expect(`${file}: ${source}`).not.toMatch(/^\s*order\s*:/m);
      expect(`${file}: ${source}`).not.toMatch(/flex-direction:\s*.*reverse/);
    }
  });

  it("wraps task and event titles instead of clipping them", () => {
    const styles = readFileSync("apps/web/src/styles/kit-today.css", "utf8");
    expect(styles).toMatch(/\.day-ev__title\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(styles).toMatch(/\.jds-task__title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
