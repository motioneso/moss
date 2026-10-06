import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";

/**
 * #2984 R2.3, spec 8.3: a connected tool the owner's sort marks safe runs outside YOLO with no
 * card. Anything else asks: no mark, a failing check, Sensitive, a first-party tool, or a
 * per-call confirmation override. YOLO never consults the mark.
 */

type Risk = "write" | "outbound" | "destructive";

interface Setup {
  readonly risk: Risk;
  readonly yolo?: boolean;
  readonly isExternal?: boolean;
  readonly safe?: boolean | "throws";
  readonly override?: boolean;
}

const SCOPED_DB = { scoped: true };

const build = (setup: Setup) => {
  const handler = vi.fn(async () => ({ data: { done: true } }));
  const runsWithoutAsking = vi.fn(async (_db: unknown) => {
    if (setup.safe === "throws") throw new Error("row unreadable");
    return setup.safe === true;
  });
  const tool = {
    name: "conn.tool",
    description: "Connected tool",
    permissionId: "integrations.tool",
    risk: setup.risk,
    executionPolicy: "auto" as const,
    isExternal: setup.isExternal ?? true,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    execute: handler,
    runsWithoutAsking,
    ...(setup.override === undefined ? {} : { requiresConfirmation: async () => setup.override })
  } as unknown as ModuleAssistantToolManifest;
  const module: MossModuleManifest = {
    id: "integrations",
    name: "Integrations",
    version: "1.0.0",
    publisher: "Jarv1s",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  };
  const emitted: Array<{ kind: string }> = [];
  const created: unknown[] = [];
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    // This fixture exercises ordinary policy on an explicitly clean conversation.
    provenance: { isTainted: async () => false, recordAdmission: async () => {} },
    resolveActiveModules: async () => [module],
    repository: {
      createPendingAssistantAction: async (_db: unknown, input: unknown) => {
        created.push(input);
        return { id: "action-1" };
      },
      insertActionAuditLog: async () => undefined
    } as never,
    runner: {
      withDataContext: async (_a: unknown, work: (db: unknown) => Promise<unknown>) =>
        work(SCOPED_DB)
    } as never,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: (_id, record) => emitted.push(record as { kind: string }) },
    confirmTimeoutMs: 1000,
    yoloMode: async () => setup.yolo === true,
    actionPolicy: () => ({
      getFamilyTier: async () => null,
      getFamilyManifest: async () => null
    })
  });
  const token = tokens.mint({
    threadId: "clean-thread",
    actorUserId: "u1",
    chatSessionId: "s1",
    allowedToolNames: null
  });
  return { gateway, token, handler, runsWithoutAsking, emitted, created };
};

describe("sorted-safe connected tools outside YOLO", () => {
  it.each(["write", "outbound"] as const)(
    "a marked %s connected tool runs with no card",
    async (risk) => {
      const dry = build({ risk, safe: true });
      expect(
        await dry.gateway.callToolForGate(dry.token, "conn.tool", { name: "x" }, "dry-run")
      ).toEqual({ kind: "would_run", approvalMode: "auto" });

      const live = build({ risk, safe: true });
      const outcome = await live.gateway.callToolForGate(
        live.token,
        "conn.tool",
        { name: "x" },
        "execute"
      );
      expect(outcome.kind).toBe("executed");
      expect(live.handler).toHaveBeenCalledTimes(1);
      expect(live.runsWithoutAsking).toHaveBeenCalledWith(SCOPED_DB, expect.anything());
      expect(live.emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
      expect(live.created).toHaveLength(0);
    }
  );

  const askCases: Array<[string, Setup]> = [
    ["not marked", { risk: "outbound", safe: false }],
    ["the check throws", { risk: "outbound", safe: "throws" }],
    ["Sensitive, even when marked", { risk: "destructive", safe: true }],
    ["first-party outbound, even when marked", { risk: "outbound", isExternal: false, safe: true }],
    ["marked, with a confirmation override", { risk: "write", safe: true, override: true }]
  ];

  it.each(askCases)("asks when %s", async (_label, setup) => {
    const { gateway, token, handler, emitted, created } = build(setup);
    for (const mode of ["execute", "dry-run"] as const) {
      const outcome = await gateway.callToolForGate(token, "conn.tool", { name: "x" }, mode);
      expect(outcome).toEqual({ kind: "declined", reason: "would_confirm" });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("never asks a Sensitive or first-party tool for the mark", async () => {
    for (const setup of [
      { risk: "destructive", safe: true },
      { risk: "outbound", isExternal: false, safe: true }
    ] as const) {
      const { gateway, token, runsWithoutAsking } = build(setup);
      await gateway.callToolForGate(token, "conn.tool", { name: "x" }, "dry-run");
      expect(runsWithoutAsking).not.toHaveBeenCalled();
    }
  });

  it("YOLO routing never reads the mark and is unchanged by it", async () => {
    for (const safe of [true, false] as const) {
      const { gateway, token, runsWithoutAsking } = build({ risk: "outbound", yolo: true, safe });
      expect(await gateway.callToolForGate(token, "conn.tool", { name: "x" }, "dry-run")).toEqual({
        kind: "would_run",
        approvalMode: "yolo"
      });
      expect(runsWithoutAsking).not.toHaveBeenCalled();
    }
    const sensitive = build({ risk: "destructive", yolo: true, safe: true });
    expect(
      await sensitive.gateway.callToolForGate(
        sensitive.token,
        "conn.tool",
        { name: "x" },
        "dry-run"
      )
    ).toEqual({ kind: "declined", reason: "would_confirm" });
  });
});
