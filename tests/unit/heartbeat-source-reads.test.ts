import { describe, expect, it, vi } from "vitest";
import { AssistantToolGateway } from "@moss/ai";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  HEARTBEAT_SOURCES,
  HEARTBEAT_SOURCE_READ_TOOLS,
  capHeartbeatItems,
  heartbeatRevision,
  parseHeartbeatSourceReadInput
} from "@moss/shared";

import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";
import { commitmentsModuleManifest } from "../../packages/commitments/src/manifest.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";

const manifests = [
  calendarModuleManifest,
  tasksModuleManifest,
  commitmentsModuleManifest,
  sportsModuleManifest,
  newsModuleManifest
] as unknown as MossModuleManifest[];

function toolFor(name: string) {
  const tool = manifests.flatMap((m) => m.assistantTools ?? []).find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("heartbeat source contract", () => {
  it("names one read tool per source, five in all", () => {
    expect(HEARTBEAT_SOURCES).toEqual(["calendar", "tasks", "memory", "sports", "news"]);
    expect(Object.keys(HEARTBEAT_SOURCE_READ_TOOLS).sort()).toEqual([...HEARTBEAT_SOURCES].sort());
  });

  it("accepts bounded input and refuses anything outside the contract", () => {
    expect(parseHeartbeatSourceReadInput({})).toEqual({ horizonHours: 24, limit: 20 });
    expect(parseHeartbeatSourceReadInput({ horizonHours: 48, limit: 5 })).toEqual({
      horizonHours: 48,
      limit: 5
    });
    for (const bad of [
      { horizonHours: 49 },
      { horizonHours: 0 },
      { limit: 21 },
      { limit: 1.5 },
      { limit: "3" },
      { ownerUserId: "someone-else" },
      null,
      []
    ])
      expect(parseHeartbeatSourceReadInput(bad)).toBeNull();
  });

  it("keeps the revision stable for equal rows and changes it on a material edit", () => {
    const rows = ["a|Pay rent|2026-11-01", "b|Call Sam|2026-11-02"];
    expect(heartbeatRevision(rows)).toBe(heartbeatRevision([...rows]));
    expect(heartbeatRevision(rows)).not.toBe(
      heartbeatRevision(["a|Pay rent|2026-11-03", rows[1]!])
    );
    expect(heartbeatRevision([])).toBe(heartbeatRevision([]));
  });

  it("caps at twenty items and reports the cut", () => {
    const many = Array.from({ length: 30 }, (_, i) => i);
    expect(capHeartbeatItems(many, 20)).toMatchObject({ truncated: true });
    expect(capHeartbeatItems(many, 20).items).toHaveLength(20);
    expect(capHeartbeatItems(many, 99).items).toHaveLength(20);
    expect(capHeartbeatItems(many.slice(0, 3), 20).truncated).toBe(false);
  });
});

describe("the five declared source tools", () => {
  it.each(Object.entries(HEARTBEAT_SOURCE_READ_TOOLS))(
    "%s: %s is a read tool with a background check that refuses foreign input",
    async (_source, name) => {
      const tool = toolFor(name);
      expect(tool.risk).toBe("read");
      expect(tool.authorizeBackgroundRead).toBeTypeOf("function");
      const ctx = { actorUserId: "owner", requestId: "r", chatSessionId: "" };
      const db = {} as never;
      expect(await tool.authorizeBackgroundRead!(db, {}, ctx)).toBe(true);
      expect(await tool.authorizeBackgroundRead!(db, { horizonHours: 12, limit: 5 }, ctx)).toBe(
        true
      );
      expect(await tool.authorizeBackgroundRead!(db, { ownerUserId: "other" }, ctx)).toBe(false);
      expect(await tool.authorizeBackgroundRead!(db, { userId: "other", limit: 5 }, ctx)).toBe(
        false
      );
      expect(await tool.authorizeBackgroundRead!(db, { limit: 500 }, ctx)).toBe(false);
    }
  );
});

describe("the gateway background allowlist", () => {
  function gatewayWith(toolNames: readonly string[]) {
    const execute = vi.fn(async () => ({ data: { source: "calendar", items: [] } }));
    const module: MossModuleManifest = {
      id: "calendar",
      name: "Calendar",
      version: "1.0.0",
      publisher: "moss",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: toolNames.map((name) => ({
        name,
        description: "Read",
        permissionId: "calendar.view",
        risk: "read" as const,
        authorizeBackgroundRead: async () => true,
        execute
      }))
    };
    const gateway = new AssistantToolGateway({
      confirmTimeoutMs: 0,
      resolveActiveModules: async () => [module],
      repository: {} as never,
      runner: {
        withDataContext: async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never)
      } as never,
      tokens: {} as never,
      confirmations: {} as never,
      notifier: { emit: vi.fn() },
      provenance: { isTainted: async () => false, recordAdmission: vi.fn() }
    });
    return { gateway, execute };
  }

  it.each(Object.values(HEARTBEAT_SOURCE_READ_TOOLS))("runs %s", async (operation) => {
    const f = gatewayWith([operation]);
    expect(
      await f.gateway.runBackgroundReadForActor("owner", { operation, input: {}, runId: "run" })
    ).toMatchObject({ ok: true });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a read tool that declares the hook but is not on the list", async () => {
    const f = gatewayWith(["calendar.listVisibleEvents", "tasks.list"]);
    for (const operation of ["calendar.listVisibleEvents", "tasks.list"])
      expect(
        await f.gateway.runBackgroundReadForActor("owner", { operation, input: {}, runId: "run" })
      ).toMatchObject({ ok: false });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
