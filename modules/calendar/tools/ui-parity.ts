import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  buildMonthCells,
  buildWeekDays,
  dayKey,
  dtoToViewEvent,
  groupEventsByDay,
  navigateCursor,
  packDay
} from "../../../apps/web/src/calendar/calendar-model.js";
import type { CalendarEventDto } from "@moss/shared";

const binary = process.env.CALENDAR_UI_ORACLE;
if (!binary) throw new Error("Build Calendar UI model first");
let count = 0;
function compare(input: unknown, expected: unknown) {
  const result = spawnSync(binary!, { input: JSON.stringify(input) + "\n", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected, JSON.stringify(input));
  count++;
}
for (const date of [
  "2024-02-29",
  "2026-01-31",
  "2026-02-01",
  "2026-08-31",
  "2026-11-08",
  "2026-12-31"
]) {
  for (const view of ["day", "week", "month"] as const) {
    for (const work of [false, true]) {
      const cursor = new Date(date + "T00:00:00Z");
      compare(
        { operation: "calendar", cursor: date, view, work },
        {
          week: buildWeekDays(cursor, work).map(dayKey),
          month: buildMonthCells(cursor).map(dayKey),
          next: dayKey(navigateCursor(cursor, view, 1)),
          previous: dayKey(navigateCursor(cursor, view, -1))
        }
      );
    }
  }
}
function event(id: string, start: string, end: string, allDay = false): CalendarEventDto {
  return {
    id,
    title: id,
    startsAt: start,
    endsAt: end,
    allDay,
    isMossBlock: false,
    location: null,
    attendeeCount: 0,
    status: null,
    readOnly: false,
    unconfirmed: false,
    ownerUserId: "owner",
    connectorAccountId: "connector",
    externalId: id,
    summary: null,
    bodyExcerpt: null,
    createdAt: start,
    updatedAt: start
  };
}
const cases = [
  [event("all", "2026-11-08T00:00:00Z", "2026-11-11T00:00:00Z", true)],
  [event("midnight", "2026-11-08T22:30:00Z", "2026-11-09T00:00:00Z")],
  [event("multiple", "2026-11-08T22:30:00Z", "2026-11-11T03:30:00Z")],
  [event("invalid", "invalid", "invalid"), event("fallback", "2026-11-08T10:00:00Z", "invalid")],
  [event("reverse", "2026-11-08T10:00:00Z", "2026-11-08T09:00:00Z")],
  [event("spring", "2026-03-08T09:30:00Z", "2026-03-08T11:30:00Z")],
  [event("fall", "2026-11-01T08:30:00Z", "2026-11-01T10:30:00Z")],
  [
    event("a", "2026-11-08T10:00:00Z", "2026-11-08T12:00:00Z"),
    event("b", "2026-11-08T10:30:00Z", "2026-11-08T11:00:00Z"),
    event("c", "2026-11-08T11:00:00Z", "2026-11-08T13:00:00Z"),
    event("d", "2026-11-08T13:00:00Z", "2026-11-08T14:00:00Z")
  ]
];
for (const zone of [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Australia/Sydney",
  "Asia/Kolkata"
]) {
  for (const events of cases) {
    const views = events.map((e) => dtoToViewEvent(e, zone)).filter((e) => e !== null);
    const groups = groupEventsByDay(views, zone);
    const expected = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, entries]) => ({
        day,
        segments: entries.map((e) => ({
          id: e.id,
          startMin: e.startMin,
          endMin: e.endMin,
          allDay: e.allDay
        })),
        packed: packDay(entries).map((e) => ({
          id: e.id,
          startMin: e.startMin,
          endMin: e.endMin,
          column: e._col,
          columns: e._cols
        }))
      }));
    compare({ operation: "events", zone, events }, expected);
  }
}
console.log(
  `Calendar UI: ${count} differential cases passed against production TypeScript date, segmentation and overlap code`
);
