/** Slice-one differential harness: pure data contracts only, not full Calendar parity. */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { serializeCalendarEvent } from "../../../packages/calendar/src/serialize.js";
import {
  emptyEveningIntent,
  mergeEveningIntent,
  normalizeBlockInput,
  normalizeLocalDay,
  normalizeTimeZone
} from "../../../packages/calendar/src/day-plan-model.js";
import { parseCalendarAutomationMode } from "@moss/shared";
import type { CalendarEvent } from "@moss/db";
import type { DayPlanBlockInput, DayPlanEveningIntent } from "@moss/shared";

type Case = {
  op: string;
  value?: unknown;
  current?: DayPlanEveningIntent;
  patch?: Partial<DayPlanEveningIntent> | null;
  day?: string;
  zone?: string;
};
const base = emptyEveningIntent();
const event = {
  id: "event",
  connector_account_id: "connector",
  owner_user_id: "owner",
  title: "Event",
  starts_at: new Date("2026-11-08T10:00:00Z"),
  ends_at: new Date("2026-11-08T11:00:00Z"),
  location: null,
  summary: null,
  body_excerpt: null,
  external_id: "jfb0123456789abcdefghijklmnopqrstuv",
  created_at: new Date("2026-11-08T09:00:00Z"),
  updated_at: new Date("2026-11-08T09:00:00Z")
};
const cases: Case[] = [
  ...[
    {},
    { jarvisCreated: true },
    { jarvisCreated: false },
    { jarvisCreated: true, source: "outlook-browser-calendar", mirrorUnconfirmed: true },
    { allDay: true, attendeeCount: 3, status: "confirmed", ignoredProviderField: "omitted" }
  ].map((external_metadata) => ({ op: "event", value: { ...event, external_metadata } })),
  ...[
    {},
    { "calendar.signal_create_tasks": true },
    { "calendar.signal_suggest_tasks": false },
    { "calendar.prep_task_mode": "off", "calendar.signal_create_tasks": true },
    { "calendar.time_block_mode": "auto", "calendar.briefing_lookahead_days": 1 },
    { "calendar.briefing_lookahead_days": 5 }
  ].map((value) => ({ op: "settings", value })),
  { op: "intent", current: base },
  { op: "intent", current: base, patch: null },
  {
    op: "intent",
    current: { ...base, notes: "kept", priorityTaskIds: ["one"] },
    patch: { notes: null, priorityTaskIds: [] }
  },
  {
    op: "intent",
    current: base,
    patch: {
      capacity: "light",
      notes: "  saved  ",
      corrections: [{ taskId: null, note: " correction ", source: "actor" }],
      commitments: [{ taskId: "one", decision: "defer" }]
    }
  },
  ...["2026-02-28", "2026-02-30", "2024-02-29", "2025-02-29", " 2026-11-08 "].map((day) => ({
    op: "day",
    day,
    zone: "UTC"
  })),
  { op: "day", day: "2026-11-08", zone: "bad/zone" },
  ...[
    null,
    { kind: "remove" },
    { kind: "add", startsAt: "2026-11-08T10:00:00Z", durationMinutes: 5 },
    { kind: "move", startsAt: "2026-11-08T10:00:00.000Z", durationMinutes: 720 },
    { kind: "add", startsAt: "2026-11-08T10:00:00Z", durationMinutes: 4 },
    { kind: "add", startsAt: "2026-11-08T10:00:00Z", durationMinutes: 721 }
  ].map((pendingChange) => ({
    op: "block",
    value: { kind: "focus", title: " Work ", pendingChange }
  })),
  { op: "block", value: { kind: "focus", actualPlacement: null } }
];
function ts(c: Case): unknown {
  try {
    let value: unknown;
    switch (c.op) {
      case "event":
        value = serializeCalendarEvent(c.value as CalendarEvent);
        break;
      case "day":
        value = [normalizeLocalDay(c.day), normalizeTimeZone(c.zone)];
        break;
      case "intent":
        value = mergeEveningIntent(c.current ?? null, c.patch);
        break;
      case "block": {
        const b = normalizeBlockInput(c.value as DayPlanBlockInput, 0);
        value = { kind: b.kind, title: b.title, taskId: b.taskId, pendingChange: b.pendingChange };
        break;
      }
      case "settings": {
        const p = c.value as Record<string, unknown>;
        const prep = parseCalendarAutomationMode(
          p["calendar.prep_task_mode"],
          p["calendar.signal_create_tasks"] === true
            ? "auto"
            : p["calendar.signal_suggest_tasks"] === false
              ? "off"
              : "suggest"
        );
        const block = parseCalendarAutomationMode(
          p["calendar.time_block_mode"],
          p["calendar.signal_block_time"] === true
            ? "auto"
            : p["calendar.signal_suggest_time_blocks"] === false
              ? "off"
              : "suggest"
        );
        const days = p["calendar.briefing_lookahead_days"];
        value = {
          lookaheadDays: days === 0 || days === 1 || days === 2 ? days : 2,
          prepTaskMode: prep,
          timeBlockMode: block,
          suggestTasks: prep !== "off",
          createTasks: prep === "auto",
          suggestTimeBlocks: block !== "off",
          blockTime: block === "auto"
        };
        break;
      }
    }
    return { ok: value };
  } catch {
    return { error: true };
  }
}
const run = spawnSync(
  process.env.CALENDAR_DATA_ORACLE ??
    "/tmp/js48-host-target/calendar-guest/debug/calendar-data-parity",
  [],
  { input: JSON.stringify(cases), encoding: "utf8" }
);
assert.equal(run.status, 0, run.stderr);
const actual: unknown[] = JSON.parse(run.stdout);
assert.equal(actual.length, cases.length);
cases.forEach((c, i) =>
  assert.deepEqual(actual[i], ts(c), `data parity case ${i}: ${JSON.stringify(c)}`)
);
console.log(
  `PASS ${cases.length} Calendar data differential cases against the existing TypeScript serializer and model; full HTTP/UI parity deferred`
);
