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
    const result = await composeBriefing(
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
    // The next run's cutoff is when this run read its tasks, not when it was saved.
    expect(result.sourceMetadata.tasksReadAt).toBe(FIXED_NOW.toISOString());
  });

  it("records no task gap when tasks are not part of the briefing", async () => {
    const inputs: Record<string, unknown>[] = [];
    const result = await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["commitments.listVisible"] }),
      runInput,
      tasksDeps(inputs, [])
    );
    const gaps = result.sourceMetadata.gaps as { source: string }[];
    expect(gaps.filter((gap) => gap.source === "tasks")).toEqual([]);
    expect(inputs.filter((input) => input.status === "done")).toEqual([]);
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

const ALL_COMMITMENTS = [
  { title: "Send the contract", status: "open", dueAt: null, counterparty: "Ana" },
  { title: "Review the budget", status: "at_risk", dueAt: null, counterparty: "Bo" },
  { title: "Reply to the vendor", status: "slipped", dueAt: null, counterparty: "Cy" },
  { title: "Already delivered", status: "done", dueAt: null, counterparty: "Di" },
  { title: "Dropped promise", status: "dismissed", dueAt: null, counterparty: "Ed" },
  { title: "Replaced by new date", status: "renegotiated", dueAt: null, counterparty: "Flo" }
];

function commitmentsDeps(seen: string[]): ComposeDeps {
  const deps = makeFakeDeps({
    generateChat: async (g: GenerateChatInput) => {
      seen.push(g.messages.map((m) => m.content).join("\n"));
      return { text: "synth narrative" };
    }
  });
  const execute: ToolExecute = async () => ({ data: { commitments: ALL_COMMITMENTS } });
  return {
    ...deps,
    moduleManifests: deps.moduleManifests.map((m) => ({
      ...m,
      assistantTools: (m.assistantTools ?? []).map((t) =>
        t.name === "commitments.listVisible" ? { ...t, execute } : t
      )
    }))
  };
}

describe("composeBriefing: commitments still open only (#2757)", () => {
  it("keeps finished, dismissed and renegotiated commitments out of the morning report", async () => {
    const seen: string[] = [];
    await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["commitments.listVisible"] }),
      runInput,
      commitmentsDeps(seen)
    );
    const prompt = seen.join("\n");

    expect(prompt).toContain("Send the contract");
    expect(prompt).toContain("Review the budget");
    expect(prompt).toContain("Reply to the vendor");
    expect(prompt).not.toContain("Already delivered");
    expect(prompt).not.toContain("Dropped promise");
    expect(prompt).not.toContain("Replaced by new date");
  });
});
