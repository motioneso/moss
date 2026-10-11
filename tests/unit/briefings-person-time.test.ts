import { describe, expect, it } from "vitest";

import type { GenerateChatInput } from "@moss/ai";
import type { ToolExecute } from "@moss/module-sdk";
import { DEFAULT_LOCALE_SETTINGS, type LocaleSettingsDto } from "@moss/shared";

import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import {
  localStamp,
  resolveOwnerLocale,
  withTimeZone
} from "../../packages/briefings/src/compose-shared.js";
import { calendarTodaySection } from "../../packages/briefings/src/morning-day.js";
import { definition, fakeScopedDb, makeFakeDeps } from "./briefings-compose.harness.js";

// Issue #3390: a Pacific person's 17:15Z event must read 10:15 AM, never 17:15 or UTC text.
const PACIFIC_12: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};
const PACIFIC_24: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-GB",
  dateFormat: "24"
};

const STANDUP = {
  id: "evt-standup",
  title: "Standup",
  startsAt: "2026-10-11T17:15:00.000Z",
  endsAt: "2026-10-11T17:45:00.000Z",
  allDay: false,
  location: null
};
const OPEN_COMMITMENT = {
  title: "Send the contract",
  status: "open",
  dueAt: "2026-10-11T17:15:00.000Z"
};

function personDeps(captured: { prompt: string }): ComposeDeps {
  const deps = makeFakeDeps({
    generateChat: async (g: GenerateChatInput) => {
      captured.prompt = g.messages.map((m) => m.content).join("\n");
      return { text: "synth narrative" };
    }
  });
  const executes: Record<string, ToolExecute> = {
    "calendar.listVisibleEvents": async () => ({
      data: { events: [STANDUP], accounts: [], gaps: [] }
    }),
    "commitments.listVisible": async () => ({ data: { commitments: [OPEN_COMMITMENT] } })
  };
  return {
    ...deps,
    moduleManifests: deps.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        executes[t.name] ? { ...t, execute: executes[t.name]! } : t
      )
    }))
  };
}

async function promptFor(
  briefingType: "morning" | "evening",
  now: Date,
  locale: LocaleSettingsDto
): Promise<string> {
  const captured = { prompt: "" };
  // The stored definition says UTC; the run follows the person (repository.generateRun).
  const stored = definition({
    briefing_type: briefingType,
    selected_tool_names: ["calendar.listVisibleEvents", "commitments.listVisible"]
  });
  await composeBriefing(
    fakeScopedDb,
    withTimeZone(stored, locale.timezone),
    { runKind: "manual", runId: "run-1", now, locale },
    personDeps(captured)
  );
  return captured.prompt;
}

describe("briefing times follow the person's locale (#3390)", () => {
  it("morning: today's events, calendar lines and due times read in Pacific 12-hour", async () => {
    // 08:00 Sunday in Los Angeles.
    const prompt = await promptFor("morning", new Date("2026-10-11T15:00:00.000Z"), PACIFIC_12);

    expect(prompt).toContain("10:15 AM-10:45 AM · Standup");
    expect(prompt).toContain("Send the contract · open · Sun, Oct 11, 10:15 AM");
    expect(prompt).not.toContain("17:15");
    expect(prompt).not.toContain("5:15 PM");
  });

  it("morning: a 24-hour person sees 24-hour times", async () => {
    const prompt = await promptFor("morning", new Date("2026-10-11T15:00:00.000Z"), PACIFIC_24);

    expect(prompt).toContain("10:15-10:45 · Standup");
    expect(prompt).not.toMatch(/10:15\s?AM/);
    expect(prompt).not.toContain("17:15");
  });

  it("evening: tomorrow's calendar and due times read in Pacific 12-hour", async () => {
    // 16:00 Saturday in Los Angeles; the standup is tomorrow morning.
    const prompt = await promptFor("evening", new Date("2026-10-10T23:00:00.000Z"), PACIFIC_12);

    expect(prompt).toContain("Sun, Oct 11, 10:15 AM · Standup");
    expect(prompt).toContain("Send the contract · open · Sun, Oct 11, 10:15 AM");
    expect(prompt).not.toContain("2026-10-11T17:15");
  });
});

describe("calendarTodaySection", () => {
  it("writes each event in the person's timezone and clock", () => {
    const now = new Date("2026-10-11T15:00:00.000Z");
    expect(calendarTodaySection([STANDUP], now, PACIFIC_12).lines).toEqual([
      "10:15 AM-10:45 AM · Standup"
    ]);
    expect(calendarTodaySection([STANDUP], now, PACIFIC_24).lines).toEqual([
      "10:15-10:45 · Standup"
    ]);
  });
});

describe("localStamp", () => {
  it("formats an instant with weekday, date and time in the person's locale", () => {
    expect(localStamp("2026-10-11T17:15:00.000Z", PACIFIC_12)).toBe("Sun, Oct 11, 10:15 AM");
  });

  it("leaves date-only, empty, unparseable and non-string values alone", () => {
    expect(localStamp("2026-10-11", PACIFIC_12)).toBe("2026-10-11");
    expect(localStamp("  ", PACIFIC_12)).toBe("");
    expect(localStamp("next week", PACIFIC_12)).toBe("next week");
    expect(localStamp(null, PACIFIC_12)).toBe("");
  });
});

describe("resolveOwnerLocale", () => {
  const utcDefinition = definition({ schedule_metadata: { targetTime: "07:00", timezone: "UTC" } });

  it("uses the person's saved locale over the briefing's stored UTC", async () => {
    const locale = await resolveOwnerLocale(
      fakeScopedDb,
      { localePreferences: { get: async () => PACIFIC_12 } },
      utcDefinition
    );
    expect(locale).toEqual(PACIFIC_12);
  });

  it("uses the app default, not UTC, when the person saved nothing", async () => {
    const locale = await resolveOwnerLocale(
      fakeScopedDb,
      { localePreferences: { get: async () => undefined } },
      utcDefinition
    );
    expect(locale).toEqual(DEFAULT_LOCALE_SETTINGS);
  });

  it("keeps the stored timezone only when no locale source is wired", async () => {
    const locale = await resolveOwnerLocale(fakeScopedDb, {}, utcDefinition);
    expect(locale.timezone).toBe("UTC");
  });
});
