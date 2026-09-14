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

describe("composeBriefing — editorial evidence (T10)", () => {
  it("gathers a news section directly after sports when both are selected", async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeFakeDeps({
      generateChat: async (input: GenerateChatInput) => {
        capturedMessages.push(input.messages);
        return { text: "synth narrative" };
      }
    });
    const result = await composeBriefing(
      fakeScopedDb,
      definition({
        selected_tool_names: ["tasks.list", "sports.followedFactsToday", "news.topHeadlinesToday"]
      }),
      runInput,
      deps
    );
    const prompt = (capturedMessages[0] as readonly { content: string }[])[0]!.content;
    expect(prompt).toContain('<external_source type="sports">');
    expect(prompt).toContain('<external_source type="news">');
    expect(prompt.indexOf('<external_source type="sports">')).toBeLessThan(
      prompt.indexOf('<external_source type="news">')
    );
    expect(prompt).toContain("Markets rally — Wire");
    const editorial = result.sourceMetadata.editorial as {
      sports?: { version: number; state: string };
      news?: { version: number; stories: unknown[] };
    };
    expect(editorial.sports?.version).toBe(1);
    expect(editorial.news?.version).toBe(1);
    expect(editorial.news?.stories).toHaveLength(1);
  });

  it("omits the news section when it is not selected", async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeFakeDeps({
      generateChat: async (input: GenerateChatInput) => {
        capturedMessages.push(input.messages);
        return { text: "synth narrative" };
      }
    });
    const result = await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["tasks.list", "sports.followedFactsToday"] }),
      runInput,
      deps
    );
    const prompt = (capturedMessages[0] as readonly { content: string }[])[0]!.content;
    expect(prompt).not.toContain('<external_source type="news">');
    const editorial = result.sourceMetadata.editorial as { news?: unknown };
    expect(editorial.news).toBeUndefined();
  });

  it("keeps evidence URLs and summaries out of the prompt", async () => {
    const capturedMessages: unknown[] = [];
    const deps = makeFakeDeps({
      generateChat: async (input: GenerateChatInput) => {
        capturedMessages.push(input.messages);
        return { text: "synth narrative" };
      }
    });
    await composeBriefing(
      fakeScopedDb,
      definition({
        selected_tool_names: ["tasks.list", "sports.followedFactsToday", "news.topHeadlinesToday"]
      }),
      runInput,
      deps
    );
    const prompt = (capturedMessages[0] as readonly { content: string }[])[0]!.content;
    expect(prompt).not.toContain("https://example.com/markets");
    expect(prompt).not.toContain("Markets rose on calm trading.");
  });

  it("drops an invalid evidence block with a log and keeps the run succeeding", async () => {
    const base = makeFakeDeps();
    const badManifests = base.moduleManifests.map((manifest) => ({
      ...manifest,
      assistantTools: (manifest.assistantTools ?? []).map((tool) =>
        tool.name === "news.topHeadlinesToday"
          ? {
              ...tool,
              execute: (async () => ({
                data: {
                  facts: [{ text: "Markets rally — Wire" }],
                  evidence: { version: 1, capturedAt: "not-a-date", degraded: false, stories: [] }
                }
              })) as ToolExecute
            }
          : tool
      )
    }));
    const errors: unknown[] = [];
    const deps: ComposeDeps = {
      ...base,
      moduleManifests: badManifests,
      logger: { error: (obj: object) => void errors.push(obj) }
    };
    const result = await composeBriefing(
      fakeScopedDb,
      definition({
        selected_tool_names: ["tasks.list", "sports.followedFactsToday", "news.topHeadlinesToday"]
      }),
      runInput,
      deps
    );
    expect(result.status).toBe("succeeded");
    const editorial = result.sourceMetadata.editorial as {
      sports?: unknown;
      news?: unknown;
    };
    expect(editorial.sports).toBeDefined();
    expect(editorial.news).toBeUndefined();
    expect(
      errors.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { event?: string }).event === "briefing_evidence_invalid"
      )
    ).toHaveLength(1);
  });

  it("reports module_cache freshness for sports and news from validated evidence", async () => {
    const deps = makeFakeDeps();
    const result = await composeBriefing(
      fakeScopedDb,
      definition({
        selected_tool_names: ["tasks.list", "sports.followedFactsToday", "news.topHeadlinesToday"]
      }),
      runInput,
      deps
    );
    const ts = result.sourceMetadata.sourceTimestamps as {
      sources: Array<{ source: string; freshnessKind: string; asOf: string | null }>;
    };
    expect(ts).toBeDefined();
    expect(ts.sources.find((s) => s.source === "sports")).toMatchObject({
      freshnessKind: "module_cache",
      asOf: FIXED_NOW.toISOString()
    });
    expect(ts.sources.find((s) => s.source === "news")).toMatchObject({
      freshnessKind: "module_cache",
      asOf: FIXED_NOW.toISOString()
    });
  });
});
