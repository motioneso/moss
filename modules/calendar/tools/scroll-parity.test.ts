// @vitest-environment jsdom
/** Run the shipped React grid's real effect, then compare Rust's initial position. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CalendarTimeGrid } from "../../../apps/web/src/calendar/calendar-time-grid.js";
import { queryKeys } from "../../../apps/web/src/api/query-keys.js";

test("initial Day and Week scroll matches the production grid at different heights", async () => {
  const binary = process.env.CALENDAR_UI_ORACLE;
  assert(binary, "Build Calendar UI model first");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  try {
    for (const minute of [0, 60, 600, 1439]) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 9, 0, minute)));
      for (const height of [240, 540, 800]) {
        const size = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
        for (const count of [1, 5, 7]) {
          const container = document.createElement("div");
          document.body.append(container);
          const root = createRoot(container);
          const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
          client.setQueryData(queryKeys.settings.locale, {
            locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
          });
          try {
            await act(async () => {
              root.render(
                createElement(
                  QueryClientProvider,
                  { client },
                  createElement(CalendarTimeGrid, {
                    days: Array.from({ length: count }, (_, day) => ({
                      date: new Date(Date.UTC(2026, 10, 8 + day)),
                      events: []
                    })),
                    hourH: 58,
                    onPick: () => {}
                  })
                )
              );
            });
            const scroll = container.querySelector<HTMLElement>(".cal-tg__scroll");
            assert(scroll, "Production grid must mount and run its scroll effect");
            const result: SpawnSyncReturns<string> = spawnSync(binary, {
              input: JSON.stringify({ operation: "gridScroll", minute, height }) + "\n",
              encoding: "utf8"
            });
            assert.equal(result.status, 0, result.stderr);
            assert(
              Math.abs(Number(JSON.parse(result.stdout)) - scroll.scrollTop) < 1,
              JSON.stringify({
                minute,
                height,
                count,
                rust: JSON.parse(result.stdout),
                production: scroll.scrollTop
              })
            );
          } finally {
            await act(async () => root.unmount());
            client.clear();
            container.remove();
          }
        }
        size.mockRestore();
      }
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
