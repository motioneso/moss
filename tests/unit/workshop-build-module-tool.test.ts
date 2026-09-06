import { afterEach, describe, expect, it, vi } from "vitest";

import { liveStreamResult } from "@moss/ai";
import { workshopModuleManifest, workshopBuildModuleExecute } from "@moss/workshop";
import { buildModuleBuildStartService } from "@moss/chat";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import * as workshop from "@moss/workshop";
import { ChatRepository } from "../../packages/chat/src/repository.js";

const ctx = {
  actorUserId: "user-a",
  requestId: "req-1",
  chatSessionId: "chat-1"
};

const requestKey = "00000000-0000-4000-8000-000000000001";
const saved = {
  project: {
    id: "00000000-0000-4000-8000-000000000002",
    title: "a tide clock",
    initialRequest: "a tide clock",
    context: "",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z"
  },
  created: true,
  destination: "/workshop/00000000-0000-4000-8000-000000000002"
};
afterEach(() => vi.restoreAllMocks());

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

  it("requires the explicit request and a stable replay key", () => {
    const properties = Object.keys(findTool().inputSchema?.properties ?? {});
    expect(properties.sort()).toEqual(["description", "requestKey"]);
  });
});

describe("workshop.buildModule execute", () => {
  it("fails closed when the host wired no create service", async () => {
    await expect(
      workshopBuildModuleExecute({}, { description: "a tide clock", requestKey }, ctx, {})
    ).rejects.toThrow(/not available/i);
  });

  it.each(["", "   ", "x".repeat(4001), "x\0"])(
    "rejects invalid description %j",
    async (description) => {
      const start = vi.fn();
      await expect(
        workshopBuildModuleExecute({}, { description, requestKey }, ctx, {
          moduleBuildStart: { start }
        })
      ).rejects.toThrow(/description/i);
      expect(start).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "mcp_random", "bad-key"])("rejects invalid replay key %j", async (key) => {
    const start = vi.fn();
    await expect(
      workshopBuildModuleExecute({}, { description: "a tide clock", requestKey: key }, ctx, {
        moduleBuildStart: { start }
      })
    ).rejects.toThrow(/UUID requestKey/i);
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves the replay key across host request IDs and returns the saved project", async () => {
    const start = vi.fn().mockResolvedValue(saved);
    for (const requestId of ["mcp_one", "mcp_two"]) {
      const result = await workshopBuildModuleExecute(
        {},
        { description: " a tide clock ", requestKey, conversationExcerpt: "private history" },
        { ...ctx, requestId },
        { moduleBuildStart: { start } }
      );
      expect(result.data).toEqual(saved);
    }
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(
      {},
      {
        actorUserId: ctx.actorUserId,
        chatSessionId: ctx.chatSessionId,
        description: "a tide clock",
        requestKey
      }
    );
  });
});

describe("create-only chat handoff", () => {
  const db = { [dataContextBrand]: true, db: {} } as DataContextDb;
  const input = {
    actorUserId: "user-a",
    chatSessionId: "user-a:drawer",
    description: "a tide clock",
    requestKey
  };

  it.each(["chat-1", "user-b:drawer"])(
    "rejects an unowned or unknown surface %s",
    async (chatSessionId) => {
      const create = vi.spyOn(workshop, "createWorkshopProject");
      await expect(
        buildModuleBuildStartService().start(db, { ...input, chatSessionId })
      ).rejects.toThrow(/Open \/workshop\/new/);
      expect(create).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, { incognito: true }, { incognito: undefined }])(
    "rejects missing or private threads %j",
    async (thread) => {
      vi.spyOn(ChatRepository.prototype, "getCurrentThread").mockResolvedValue(thread as never);
      const create = vi.spyOn(workshop, "createWorkshopProject");
      await expect(buildModuleBuildStartService().start(db, input)).rejects.toThrow(
        /Open \/workshop\/new/
      );
      expect(create).not.toHaveBeenCalled();
    }
  );

  it("uses the shared creation service with no queue or model dependency", async () => {
    const current = vi
      .spyOn(ChatRepository.prototype, "getCurrentThread")
      .mockResolvedValue({ incognito: false } as never);
    const create = vi.spyOn(workshop, "createWorkshopProject").mockResolvedValue(saved);
    expect(await buildModuleBuildStartService().start(db, input)).toEqual(saved);
    expect(current).toHaveBeenCalledWith(db, "user-a", "drawer");
    expect(create).toHaveBeenCalledWith(db, {
      requestKey,
      title: "a tide clock",
      initialRequest: "a tide clock"
    });
  });

  it("preserves admin denial from the shared scoped-actor check", async () => {
    vi.spyOn(ChatRepository.prototype, "getCurrentThread").mockResolvedValue({
      incognito: false
    } as never);
    vi.spyOn(workshop, "createWorkshopProject").mockRejectedValue(
      new workshop.WorkshopAdminRequiredError()
    );
    await expect(buildModuleBuildStartService().start(db, input)).rejects.toMatchObject({
      statusCode: 403
    });
  });

  it("curates unexpected persistence errors", async () => {
    vi.spyOn(ChatRepository.prototype, "getCurrentThread").mockResolvedValue({
      incognito: false
    } as never);
    vi.spyOn(workshop, "createWorkshopProject").mockRejectedValue(
      new Error("private database detail")
    );
    await expect(buildModuleBuildStartService().start(db, input)).rejects.toThrow(
      "Workshop could not save this request."
    );
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
