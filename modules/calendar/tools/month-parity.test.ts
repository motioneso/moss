/** Compare Month presentation with the shipped React screen, not a copied model. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CalendarMonth } from "../../../apps/web/src/calendar/calendar-month.js";
import { dtoToViewEvent, groupEventsByDay } from "../../../apps/web/src/calendar/calendar-model.js";
import { queryKeys } from "../../../apps/web/src/api/query-keys.js";
import type { CalendarEventDto } from "@moss/shared";

const binary = process.env.CALENDAR_UI_ORACLE;
assert(binary, "Build Calendar UI model first");
function presentation(html: string) {
  const text = (markup: string, name: string) =>
    new RegExp(`<span class="${name}">([\\s\\S]*?)<\\/span>`).exec(markup)?.[1] ?? null;
  return {
    height: /min-height:([^;" ]+)/.exec(html)?.[1],
    rows: /grid-template-rows:([^;"]+)/.exec(html)?.[1].replaceAll(" ", ""),
    headers: [...html.matchAll(/class="cal-month__dow">([^<]+)/g)].map((m) => m[1]),
    cells: html
      .split(/<div class="cal-mcell(?=[" ])/)
      .slice(1)
      .map((cell) => ({
        classes: cell.slice(0, cell.indexOf('"')).trim().split(" ").filter(Boolean).sort(),
        day: text(cell, "n"),
        month: text(cell, "mo"),
        chips: [
          ...cell.matchAll(/<button\b[^>]*class="(cal-mchip[^"]*)"[^>]*>[\s\S]*?<\/button>/g)
        ].map(([markup, classes]) => ({
          classes,
          title: text(markup, "cal-mchip__title"),
          time: text(markup, "cal-mchip__t"),
          colour: /--ev:([^;" ]+)/.exec(markup)?.[1]
        })),
        more: /class="cal-mmore"[^>]*>([^<]+)/.exec(cell)?.[1] ?? null
      }))
  };
}

test("rendered Month dates, rows and chips match production React", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
  let comparisons = 0;
  try {
    for (const cursor of ["2026-02-01", "2026-11-08", "2026-05-01"]) {
      for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        for (const twelve of [false, true]) {
          for (const populated of [false, true]) {
            const events: CalendarEventDto[] = populated
              ? Array.from({ length: 6 }, (_, i) => ({
                  id: `month-${i}`,
                  title: `Month <${i}>`,
                  startsAt: `${cursor}T${i === 5 ? "23" : "10"}:00:00Z`,
                  endsAt: `${cursor.slice(0, 8)}${String(Number(cursor.slice(8)) + 2).padStart(2, "0")}T11:00:00Z`,
                  allDay: i === 3,
                  isMossBlock: i === 2,
                  location: null,
                  status: null,
                  attendeeCount: 0,
                  readOnly: false,
                  unconfirmed: false,
                  ownerUserId: "owner",
                  connectorAccountId: "connector",
                  externalId: `month-${i}`,
                  summary: null,
                  bodyExcerpt: null,
                  createdAt: `${cursor}T00:00:00Z`,
                  updatedAt: `${cursor}T00:00:00Z`
                }))
              : [];
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            client.setQueryData(queryKeys.settings.locale, {
              locale: { timezone: zone, region: "en-US", dateFormat: twelve ? "12" : "24" }
            });
            const projected = events
              .map((event) => dtoToViewEvent(event, zone))
              .filter((event) => event !== null);
            const expected = renderToStaticMarkup(
              createElement(
                QueryClientProvider,
                { client },
                createElement(CalendarMonth, {
                  cursor: new Date(`${cursor}T00:00:00Z`),
                  eventsByDay: groupEventsByDay(projected, zone),
                  onPickDay: () => {},
                  onPick: () => {}
                })
              )
            );
            const result = spawnSync(binary, {
              input:
                JSON.stringify({
                  operation: "month",
                  cursor,
                  today: "2026-11-08T12:00:00Z",
                  zone,
                  twelve,
                  events
                }) + "\n",
              encoding: "utf8"
            });
            assert.equal(result.status, 0, result.stderr);
            const expectedMonth = presentation(expected);
            assert([35, 42].includes(expectedMonth.cells.length));
            assert.deepEqual(
              presentation(JSON.parse(result.stdout)),
              expectedMonth,
              JSON.stringify({ cursor, zone, twelve, populated })
            );
            client.clear();
            comparisons++;
          }
        }
      }
    }
  } finally {
    vi.useRealTimers();
  }
  console.log(`PASS ${comparisons} rendered Month comparisons against production React`);
});
