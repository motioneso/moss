// @vitest-environment jsdom
/** Compare the real production Calendar toolbar with the rendered Rust screen. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CalendarPage } from "../../../apps/web/src/calendar/calendar-page.js";
import { queryKeys } from "../../../apps/web/src/api/query-keys.js";

function presentation(markup: string) {
  const root = document.createElement("div");
  root.innerHTML = markup;
  const toolbar = root.querySelector(".cal-toolbar")!;
  const buttons = (parent: Element) =>
    [...parent.querySelectorAll("button")].map((button) => ({
      label: button.getAttribute("aria-label") ?? button.textContent,
      classes: button.className,
      pressed: button.getAttribute("aria-pressed"),
      type: button.type,
      icon: button.querySelector("svg path")?.getAttribute("d") ?? null
    }));
  return {
    heading: toolbar.querySelector(".cal-range")?.textContent?.replace(/\s+/g, " "),
    buttons: buttons(toolbar),
    groups: [...toolbar.querySelectorAll('[role="group"]')].map((group) => ({
      label: group.getAttribute("aria-label"),
      classes: group.className,
      buttons: buttons(group)
    }))
  };
}

test("Calendar toolbar controls and selected states match production React", () => {
  const binary = process.env.CALENDAR_UI_ORACLE;
  assert(binary, "Build Calendar UI model first");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  try {
    for (const view of ["day", "week", "month"]) {
      for (const work of [false, true]) {
        localStorage.clear();
        localStorage.setItem("moss.cal.view", view);
        localStorage.setItem("moss.cal.cursor", "2026-11-09");
        localStorage.setItem("moss.cal.workweek", work ? "1" : "0");
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        client.setQueryData(queryKeys.settings.locale, {
          locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
        });
        try {
          const expected = renderToStaticMarkup(
            createElement(
              QueryClientProvider,
              { client },
              createElement(MemoryRouter, {}, createElement(CalendarPage))
            )
          );
          const result = spawnSync(binary, {
            input:
              JSON.stringify({ operation: "toolbar", cursor: "2026-11-09", view, work }) + "\n",
            encoding: "utf8"
          });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(
            presentation(JSON.parse(result.stdout)),
            presentation(expected),
            `${view}, work=${work}`
          );
        } finally {
          client.clear();
        }
      }
    }
  } finally {
    localStorage.clear();
    vi.useRealTimers();
  }
  console.log("PASS 6 rendered toolbar comparisons with production CalendarPage");
});
