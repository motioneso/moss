import { describe, expect, it } from "vitest";

import type { GenerateChatInput } from "@moss/ai";
import type { ToolExecute } from "@moss/module-sdk";

import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import {
  FIXED_NOW,
  definition,
  fakeScopedDb,
  makeFakeDeps,
  runInput
} from "./briefings-compose.harness.js";

const PREVIOUS_RUN_AT = new Date("2026-06-12T06:00:00.000Z");
const ALL_TASKS = [
  { title: "Draft the quarterly plan", status: "todo", completedAt: null },
  {
    title: "Finished before the last briefing",
    status: "done",
    completedAt: "2026-06-12T05:00:00.000Z"
  },
  {
    title: "Finished after the last briefing",
    status: "done",
    completedAt: "2026-06-12T18:00:00.000Z"
  },
  { title: "Finished thirty hours ago", status: "done", completedAt: "2026-06-12T06:30:00.000Z" },
  { title: "Old archived task", status: "archived", completedAt: "2026-06-13T08:00:00.000Z" }
];

/** Mirrors the task list's own status and completion filters. */
function tasksDeps(inputs: Record<string, unknown>[], seen: string[]): ComposeDeps {
  const deps = makeFakeDeps({
    generateChat: async (g: GenerateChatInput) => {
      seen.push(g.messages.map((m) => m.content).join("\n"));
      return { text: "synth narrative" };
    }
  });
  const execute: ToolExecute = async (_db, input) => {
    inputs.push(input);
    const status = input.status as string | undefined;
    const after =
      typeof input.completedAfter === "string" ? new Date(input.completedAfter) : undefined;
    const items = ALL_TASKS.filter(
      (t) =>
        (status === undefined || t.status === status) &&
        (after === undefined || (t.completedAt !== null && new Date(t.completedAt) > after))
    );
    return { data: { items } };
  };
  return {
    ...deps,
    moduleManifests: deps.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        t.name === "tasks.list" ? { ...t, execute } : t
      )
    }))
  };
}

function tasksBlock(prompt: string): string {
  return prompt.match(/<external_source type="tasks">\n([\s\S]*?)\n<\/external_source>/)?.[1] ?? "";
}

describe("composeBriefing: morning tasks since the last briefing (#2764)", () => {
  it("sends open tasks and only tasks completed since the previous morning run", async () => {
    const inputs: Record<string, unknown>[] = [];
    const seen: string[] = [];
    await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["tasks.list"] }),
      { ...runInput, previousMorningRunAt: PREVIOUS_RUN_AT },
      tasksDeps(inputs, seen)
    );
    const block = tasksBlock(seen.join("\n"));

    expect(block).toContain("Draft the quarterly plan");
    expect(block).toContain("[completed since last briefing] Finished after the last briefing");
    expect(block).toContain("Finished thirty hours ago");
    expect(block).not.toContain("Finished before the last briefing");
    expect(block).not.toContain("Old archived task");
    expect(inputs).toContainEqual({
      status: "done",
      completedAfter: PREVIOUS_RUN_AT.toISOString()
    });
  });

  it("falls back to the last 24 hours when there is no previous morning run", async () => {
    const inputs: Record<string, unknown>[] = [];
    const seen: string[] = [];
    await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["tasks.list"] }),
      { ...runInput, previousMorningRunAt: null },
      tasksDeps(inputs, seen)
    );
    const block = tasksBlock(seen.join("\n"));

    expect(block).toContain("[completed since last briefing] Finished after the last briefing");
    expect(block).not.toContain("Finished thirty hours ago");
    expect(block).not.toContain("Old archived task");
    expect(inputs).toContainEqual({
      status: "done",
      completedAfter: new Date(FIXED_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString()
    });
  });
});
