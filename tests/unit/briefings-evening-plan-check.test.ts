/**
 * #3218 review: the evening plan check must read the calendar from the start of the local
 * day, and must stay silent when the calendar could not be read.
 */
import { describe, expect, it } from "vitest";

import type { GenerateChatInput } from "@moss/ai";
import type { ToolExecute } from "@moss/module-sdk";

import type { ComposeDeps } from "../../packages/briefings/src/compose.js";
import { composeEveningBriefing } from "../../packages/briefings/src/compose-evening.js";
import {
  FIXED_NOW,
  TODAY_ISO,
  cannedToolData,
  committedDayPlanBlock,
  definition,
  fakeScopedDb,
  makeFakeDeps,
  runInput,
  type FakeOptions
} from "./briefings-compose.harness.js";

const PLAN = {
  id: "plan-1",
  localDay: "2026-06-13",
  timeZone: "UTC",
  revision: 1,
  sourceRunId: null,
  eveningIntent: {
    priorityTaskIds: [],
    capacity: "light" as const,
    notes: null,
    corrections: [],
    commitments: []
  },
  // Block sits on the 09:00Z event, which is before FIXED_NOW (12:00Z).
  blocks: [committedDayPlanBlock(TODAY_ISO)]
};

/** Calendar tool that honours startsAfter and otherwise starts its window at now. */
function windowedCalendar(
  inputs: Record<string, unknown>[],
  seed?: readonly Record<string, unknown>[],
  disconnected = false
): ToolExecute {
  return async (_db, input) => {
    inputs.push(input as Record<string, unknown>);
    const startsAfter = (input as { startsAfter?: string }).startsAfter;
    const from = new Date(startsAfter ?? FIXED_NOW.toISOString()).getTime();
    const data = cannedToolData("calendar.listVisibleEvents", seed);
    const events = (data.events as { startsAt: string }[]).filter(
      (e) => new Date(e.startsAt).getTime() >= from
    );
    // A disconnected calendar answers with no events, no accounts and a gap.
    return disconnected
      ? { data: { events: [], accounts: [], gaps: [{ reason: "not_connected" }] } }
      : { data: { ...data, events } };
  };
}

async function eveningPrompt(
  options: FakeOptions,
  calendarInputs: Record<string, unknown>[] = [],
  variant: { readonly timezone?: string; readonly disconnected?: boolean } = {}
) {
  const seen: string[] = [];
  const base = makeFakeDeps({
    ...options,
    dayPlan: { plan: PLAN },
    generateChat: async (g: GenerateChatInput) => {
      seen.push(g.messages.map((m) => m.content).join("\n"));
      return { text: "synth narrative" };
    }
  });
  const deps: ComposeDeps = {
    ...base,
    moduleManifests: base.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        t.name === "calendar.listVisibleEvents" && options.failTool !== t.name
          ? {
              ...t,
              execute: windowedCalendar(
                calendarInputs,
                options.calendarEvents,
                variant.disconnected
              )
            }
          : t
      )
    }))
  };
  await composeEveningBriefing(
    fakeScopedDb,
    definition({
      title: "Evening",
      briefing_type: "evening",
      schedule_metadata: { targetTime: "18:00", timezone: variant.timezone ?? "UTC" },
      selected_tool_names: ["tasks.list", "calendar.listVisibleEvents"]
    }),
    runInput,
    deps
  );
  return seen.join("\n");
}

describe("evening plan check", () => {
  it("reads the calendar from the start of the local day so earlier blocks are still found", async () => {
    const inputs: Record<string, unknown>[] = [];
    const prompt = await eveningPrompt({}, inputs);
    expect(inputs[0]?.startsAfter).toBe("2026-06-13T00:00:00.000Z");
    expect(prompt).not.toContain("lost its calendar event");
  });

  it("says nothing about lost events when the calendar read failed", async () => {
    const prompt = await eveningPrompt({ failTool: "calendar.listVisibleEvents" });
    expect(prompt).not.toContain("lost its calendar event");
  });

  it("says nothing about lost events when the calendar is switched off for briefings", async () => {
    const prompt = await eveningPrompt({ disabledBehaviors: new Set(["calendar.briefings"]) });
    expect(prompt).not.toContain("lost its calendar event");
  });

  it("says nothing about lost events when no calendar account is connected", async () => {
    const prompt = await eveningPrompt({}, [], { disconnected: true });
    expect(prompt).not.toContain("lost its calendar event");
  });

  it("says nothing about lost events when the timezone is unknown", async () => {
    const inputs: Record<string, unknown>[] = [];
    const prompt = await eveningPrompt({}, inputs, { timezone: "Not/AZone" });
    // An unknown zone falls back to UTC, so the read still starts at that day's start and the
    // 09:00Z block is found rather than reported lost.
    expect(inputs[0]?.startsAfter).toBe("2026-06-13T00:00:00.000Z");
    expect(prompt).not.toContain("lost its calendar event");
  });

  it("still reports a lost event when the calendar loaded and the event is gone", async () => {
    const prompt = await eveningPrompt({ calendarEvents: [] });
    expect(prompt).toContain("lost its calendar event");
  });
});
