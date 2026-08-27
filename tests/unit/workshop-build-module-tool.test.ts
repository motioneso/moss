import { describe, expect, it } from "vitest";

import { liveStreamResult } from "@moss/ai";
import { workshopModuleManifest, workshopBuildModuleExecute } from "@moss/workshop";
import { buildModuleBuildStartService } from "@moss/chat";
import type { DataContextDb } from "@moss/db";

const ctx = {
  actorUserId: "user-a",
  requestId: "req-1",
  chatSessionId: "chat-1"
};

function findTool() {
  const tool = workshopModuleManifest.assistantTools?.find(
    (entry) => entry.name === "workshop.buildModule"
  );
  if (!tool) throw new Error("workshop.buildModule is missing from the manifest");
  return tool;
}

describe("workshop.buildModule manifest declaration", () => {
  it("is a write tool in the module_builds family, so chat can show its result", () => {
    const tool = findTool();
    // risk "write" is load-bearing: the gateway only emits an action_result record for
    // non-read tools, so a read tool's plan would never reach the browser at all.
    expect(tool.risk).toBe("write");
    expect(tool.actionFamilyId).toBe("module_builds");
    expect(tool.executionPolicy).toBe("auto");
    expect(tool.selfOperationGrant).toBe("granted_at_install");
    expect(tool.requiresServices).toEqual(["moduleBuildStart"]);
    expect(tool.streamsStructuredResult).toBe(true);
  });

  it("declares a family that can be promoted or tightened, but starts at ask each time", () => {
    const family = workshopModuleManifest.assistantActionFamilies?.find(
      (entry) => entry.id === "module_builds"
    );
    expect(family?.defaultTier).toBe("ask_each_time");
    expect(family?.allowedTiers).toEqual(["ask_each_time", "trusted_auto", "always_confirm"]);
  });

  it("only exposes the two inputs the planner needs, and nothing generic", () => {
    const properties = Object.keys(findTool().inputSchema?.properties ?? {});
    expect(properties.sort()).toEqual(["conversationExcerpt", "description"]);
  });
});

describe("workshop.buildModule execute", () => {
  it("fails closed when the host wired no build service", async () => {
    await expect(
      workshopBuildModuleExecute({}, { description: "a tide clock" }, ctx, {})
    ).rejects.toThrow(/not available/i);
  });

  it("rejects an empty description rather than planning nothing", async () => {
    const service = {
      start: async () => ({ buildId: "b1", plan: {} as never, awaitingApproval: true })
    };
    await expect(
      workshopBuildModuleExecute({}, { description: "   " }, ctx, { moduleBuildStart: service })
    ).rejects.toThrow(/description/i);
  });

  it("hands back the plan, the build id, and whether it is still waiting", async () => {
    const plan = {
      whatItDoes: "Shows the tide",
      whatItReaches: ["the tide service"],
      whatItKeeps: "Today's tide times",
      whenItRuns: "Each morning",
      roughCost: { time: "about an hour", budgetCents: 40 }
    };
    const service = {
      start: async () => ({ buildId: "b1", plan, awaitingApproval: true })
    };
    const result = await workshopBuildModuleExecute({}, { description: "a tide clock" }, ctx, {
      moduleBuildStart: service
    });
    expect(result.data).toEqual({ buildId: "b1", awaitingApproval: true, plan });
  });
});

describe("who may ask for a module", () => {
  it("refuses a signed-in user who is not an administrator", async () => {
    const service = buildModuleBuildStartService({
      boss: {} as never,
      aiRepository: {} as never,
      isYoloActive: async () => false,
      isInstanceAdmin: async () => false
    });
    await expect(
      service.start({} as DataContextDb, {
        actorUserId: "user-a",
        chatSessionId: "chat-1",
        description: "a tide clock",
        conversationExcerpt: ""
      })
    ).rejects.toThrow(/administrator/i);
  });
});

describe("what reaches the browser on the chat stream", () => {
  const structured = { buildId: "b1", plan: { whatItDoes: "Shows the tide" } };
  const rendered = { text: "Build b1 planned." };

  it("sends only the rendered text for an ordinary tool", () => {
    expect(liveStreamResult({}, { ok: true, data: rendered, structuredData: structured })).toBe(
      rendered
    );
  });

  it("sends the structured result only for a tool that asked for it", () => {
    expect(
      liveStreamResult(
        { streamsStructuredResult: true },
        { ok: true, data: rendered, structuredData: structured }
      )
    ).toBe(structured);
  });

  it("falls back to the rendered text when there is no structured result to send", () => {
    expect(liveStreamResult({ streamsStructuredResult: true }, { ok: true, data: rendered })).toBe(
      rendered
    );
  });
});
