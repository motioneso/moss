/** Compare visible event labels with the real production React time grid. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CalendarTimeGrid } from "../../../apps/web/src/calendar/calendar-time-grid.js";
import {
  buildWeekDays,
  dtoToViewEvent,
  groupEventsByDay,
  dayKey
} from "../../../apps/web/src/calendar/calendar-model.js";
import { queryKeys } from "../../../apps/web/src/api/query-keys.js";
import type { CalendarEventDto } from "@moss/shared";

const binary = process.env.CALENDAR_UI_ORACLE;
assert(binary, "Build Calendar UI model first");
function labels(html: string) {
  return [
    ...html.matchAll(/<button\b[^>]*class="(cal-ev [^"]*|cal-allchip)"[^>]*>[\s\S]*?<\/button>/g)
  ].map(([markup, classes]) => {
    const text = (name: string) =>
      new RegExp(`<span class="${name}">([\\s\\S]*?)<\\/span>`).exec(markup)?.[1] ?? null;
    return {
      classes,
      title: text("cal-ev__titletext"),
      time: text("cal-ev__meta"),
      location: text("cal-ev__where"),
      held: markup.includes("cal-ev__hold"),
      colour: /--ev:([^;" ]+)/.exec(markup)?.[1]
    };
  });
}
test("rendered event labels match the production React time grid", () => {
  const cursor = "2026-11-08";
  let comparisons = 0;
  for (const week of [false, true]) {
    for (const twelve of [false, true]) {
      for (const minutes of [0, 15, 45, 46, 59, 60, 90]) {
        for (const metadata of [
          {},
          { status: "tentative" },
          { status: "needsAction" },
          { isMossBlock: true },
          { allDay: true, isMossBlock: true }
        ]) {
          const event: CalendarEventDto = {
            id: "grid",
            title: "Grid meeting",
            startsAt: `${cursor}T10:00:00Z`,
            endsAt: `${cursor}T${String(10 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`,
            allDay: false,
            isMossBlock: false,
            location: "Room <north>",
            status: null,
            attendeeCount: 0,
            readOnly: false,
            unconfirmed: false,
            ownerUserId: "owner",
            connectorAccountId: "connector",
            externalId: "grid",
            summary: null,
            bodyExcerpt: null,
            createdAt: `${cursor}T10:00:00Z`,
            updatedAt: `${cursor}T10:00:00Z`,
            ...metadata
          };
          const date = new Date(`${cursor}T00:00:00Z`);
          const locale = {
            timezone: "UTC",
            region: "en-US",
            dateFormat: twelve ? ("12" as const) : ("24" as const)
          };
          const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
          client.setQueryData(queryKeys.settings.locale, { locale });
          const projected = dtoToViewEvent(event, "UTC");
          assert(projected);
          const groups = groupEventsByDay([projected], "UTC");
          const days = (week ? buildWeekDays(date, false) : [date]).map((date) => ({
            date,
            events: groups.get(dayKey(date)) ?? []
          }));
          const expected = renderToStaticMarkup(
            createElement(
              QueryClientProvider,
              { client },
              createElement(CalendarTimeGrid, { days, hourH: 58, onPick: () => {} })
            )
          );
          const result = spawnSync(binary, {
            input:
              JSON.stringify({
                operation: "grid",
                cursor,
                week,
                twelve,
                zone: "UTC",
                events: [event]
              }) + "\n",
            encoding: "utf8"
          });
          assert.equal(result.status, 0, result.stderr);
          const expectedLabels = labels(expected);
          assert.equal(expectedLabels.length, 1, "The production fixture must render one chip");
          assert.deepEqual(
            labels(JSON.parse(result.stdout)),
            expectedLabels,
            JSON.stringify({ week, twelve, minutes, metadata })
          );
          client.clear();
          comparisons++;
        }
      }
    }
  }
  console.log(`PASS ${comparisons} rendered event-grid comparisons against production React`);
});
