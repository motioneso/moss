import { describe, expect, it, vi } from "vitest";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  resolvePolicy,
  type AssistantToolGatewayDependencies,
  type ConversationProvenancePort,
  type GatewaySessionRecord,
  type PerCallResolution
} from "@moss/ai";
import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolExecute
} from "@moss/module-sdk";

import { isConversationTainted } from "../../packages/ai/src/gateway/conversation-policy.js";

const family = {
  id: "change",
  label: "Change",
  description: "Change settings",
  defaultTier: "ask_each_time" as const,
  allowedTiers: ["ask_each_time", "trusted_auto"] as const
};
const resolution = (confirmWhenTainted: boolean): PerCallResolution => ({
  kind: "proceed",
  risk: "read",
  externalContent: false,
  forceConfirm: false,
  confirmWhenTainted,
  summary: "Search outside the app",
  details: { presentation: "human", target: "Search", fields: [] },
  affectsModules: []
});

function build(
  options: {
    risk?: ModuleAssistantToolManifest["risk"];
    yolo?: boolean;
    tier?: "ask_each_time" | "trusted_auto";
    tainted?: boolean;
    threadId?: string | null;
    resolution?: PerCallResolution;
    tool?: Partial<ModuleAssistantToolManifest>;
    deps?: Partial<AssistantToolGatewayDependencies>;
  } = {}
) {
  const handler = vi.fn<ToolExecute>(async () => ({ data: { ok: true } }));
  const tool: ModuleAssistantToolManifest = {
    name: "example.change",
    actionLabel: "Change fixture setting",
    approvalContent: "user_authored",
    approvalPresentation: async () => ({ target: "Fixture setting", fields: [] }),
    description: "Change settings",
    permissionId: "example.change",
    actionFamilyId: family.id,
    risk: options.risk ?? "write",
    executionPolicy: "auto",
    isExternal: true,
    content: "user_authored",
    runsWithoutAsking: async () => true,
    inputSchema: { type: "object", properties: {} },
    execute: handler,
    ...options.tool
  };
  const module: MossModuleManifest = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  };
  const isTainted = vi.fn(async () => options.tainted ?? false);
  const provenance: ConversationProvenancePort = {
    isTainted,
    isMarked: async () => options.tainted ?? false,
    recordAdmission: vi.fn(),
    runAutomatic: async (_actor, _thread, callback) => ({ kind: "ran", value: await callback() })
  };
  const createPending = vi.fn(async () => ({ id: "action-1" }));
  const audit = vi.fn(async () => undefined);
  const records: GatewaySessionRecord[] = [];
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const yoloMode = vi.fn(async () => options.yolo ?? false);
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [module],
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => unknown) => work({})
    } as never,
    repository: {
      createPendingAssistantAction: createPending,
      insertActionAuditLog: audit
    } as never,
    tokens,
    confirmations,
    notifier: { emit: (_id, record) => records.push(record) },
    confirmTimeoutMs: 500,
    provenance,
    yoloMode,
    actionPolicy: () => ({
      getFamilyTier: async () => options.tier ?? "trusted_auto",
      getFamilyManifest: async () => family
    }),
    ...(options.resolution
      ? { perCallResolvers: { [tool.name]: async () => options.resolution! } }
      : {}),
    ...options.deps
  });
  const identity = {
    actorUserId: "actor-a",
    chatSessionId: "actor-a:chat",
    threadId: options.threadId === undefined ? "thread-a" : options.threadId,
    allowedToolNames: null
  };
  const token = tokens.mint(identity);
  return {
    gateway,
    token,
    tokens,
    identity,
    handler,
    createPending,
    audit,
    records,
    confirmations,
    isTainted,
    yoloMode,
    tool
  };
}

async function rejectPending(h: ReturnType<typeof build>, pending: Promise<unknown>) {
  await vi.waitFor(
    () => expect(h.records).toContainEqual(expect.objectContaining({ kind: "action_request" })),
    { interval: 1 }
  );
  expect(h.handler).not.toHaveBeenCalled();
  h.confirmations.resolve("action-1", "rejected");
  await pending;
  expect(h.handler).not.toHaveBeenCalled();
}

describe("conversation taint lookup", () => {
  it.each([undefined, ""])("fails closed without a bound thread (%s)", async (threadId) => {
    const isTainted = vi.fn(async () => false);
    expect(
      await isConversationTainted(
        { isTainted, recordAdmission: vi.fn() },
        { actorUserId: "actor-a", threadId }
      )
    ).toBe(true);
    expect(isTainted).not.toHaveBeenCalled();
  });

  it("fails closed without a port and on storage failure", async () => {
    const ctx = { actorUserId: "actor-a", threadId: "thread-a" };
    expect(await isConversationTainted(undefined, ctx)).toBe(true);
    expect(
      await isConversationTainted(
        {
          isTainted: async () => {
            throw new Error("private storage detail");
          },
          recordAdmission: vi.fn()
        },
        ctx
      )
    ).toBe(true);
  });

  it.each([true, false])(
    "reads the active actor and bound thread (tainted=%s)",
    async (tainted) => {
      const isTainted = vi.fn(async () => tainted);
      expect(
        await isConversationTainted(
          { isTainted, recordAdmission: vi.fn() },
          { actorUserId: "actor-a", threadId: "thread-a" }
        )
      ).toBe(tainted);
      expect(isTainted).toHaveBeenCalledExactlyOnceWith("actor-a", "thread-a");
    }
  );
});

describe("bound conversation policy at every gateway entry", () => {
  it("tainted writes ask when only Moss's own rating would run them", async () => {
    for (const risk of ["write", "outbound", "destructive"] as const) {
      const h = build({ tainted: true, tier: "ask_each_time", risk, tool: { isExternal: true } });
      await rejectPending(h, h.gateway.callTool(h.token, h.tool.name, {}));
      expect(h.isTainted).toHaveBeenLastCalledWith("actor-a", "thread-a");
    }
  });

  it.each([false, true])(
    "tainted writes the user trusted run without a clean claim (YOLO=%s)",
    async (yolo) => {
      const h = build({ tainted: true, yolo, tool: { isExternal: false } });
      expect(await h.gateway.callTool(h.token, h.tool.name, {})).toMatchObject({ ok: true });
      expect(h.handler).toHaveBeenCalledOnce();
      expect(h.createPending).not.toHaveBeenCalled();
      for (const risk of ["outbound", "destructive"] as const) {
        const held = build({ tainted: true, yolo, risk });
        await rejectPending(held, held.gateway.callTool(held.token, held.tool.name, {}));
      }
    }
  );

  it.each([false, true])("clean writes retain automatic execution (YOLO=%s)", async (yolo) => {
    const h = build({ yolo });
    expect(await h.gateway.callTool(h.token, h.tool.name, {})).toMatchObject({ ok: true });
    expect(h.handler).toHaveBeenCalledOnce();
    expect(h.handler.mock.calls[0]?.[2]).toMatchObject({
      actorUserId: "actor-a",
      threadId: "thread-a"
    });
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it.each(["dry-run", "execute"] as const)(
    "gate %s declines untrusted tainted non-reads without a card or side effect",
    async (mode) => {
      for (const yolo of [false, true])
        for (const risk of ["write", "outbound", "destructive"] as const) {
          const h = build({
            tainted: true,
            yolo: yolo && risk !== "write",
            tier: "ask_each_time",
            risk,
            tool: { isExternal: true }
          });
          expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, mode)).toEqual({
            kind: "declined",
            reason: "would_confirm"
          });
          expect(h.handler).not.toHaveBeenCalled();
          expect(h.createPending).not.toHaveBeenCalled();
          expect(h.audit).not.toHaveBeenCalled();
          expect(h.records).toEqual([]);
        }
    }
  );

  const failureCases = [
    ["missing thread", { threadId: null }],
    ["missing port", { deps: { provenance: undefined } }],
    [
      "storage failure",
      {
        deps: {
          provenance: {
            isTainted: async () => {
              throw new Error("private storage detail");
            },
            recordAdmission: vi.fn()
          }
        }
      }
    ]
  ] as const;
  it.each(failureCases)(
    "%s requires approval across ordinary and gate writes without the user's trust",
    async (_label, options) => {
      {
        const h = build({ ...options, tier: "ask_each_time" });
        for (const mode of ["dry-run", "execute"] as const)
          expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, mode)).toEqual({
            kind: "declined",
            reason: "would_confirm"
          });
        await rejectPending(h, h.gateway.callTool(h.token, h.tool.name, {}));
        expect(JSON.stringify(h.records)).not.toContain("private storage detail");
      }
    }
  );

  it.each(failureCases)(
    "declared user-authored reads remain available with %s",
    async (_label, options) => {
      const h = build({
        ...options,
        yolo: true,
        risk: "read",
        tool: { content: "user_authored", isExternal: false }
      });
      expect(await h.gateway.callTool(h.token, h.tool.name, {})).toMatchObject({ ok: true });
      expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, "dry-run")).toEqual({
        kind: "would_run",
        approvalMode: "auto"
      });
      expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, "execute")).toMatchObject({
        kind: "executed"
      });
      expect(await h.gateway.runReadToolForActor("actor-a", h.tool.name, {})).toMatchObject({
        ok: true
      });
      expect(h.handler).toHaveBeenCalledTimes(3);
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "outbound GET resolved as read requires confirmation only while tainted (tainted=%s)",
    async (tainted) => {
      const h = build({ tainted, yolo: true, resolution: resolution(true) });
      for (const mode of ["dry-run", "execute"] as const) {
        const outcome = await h.gateway.callToolForGate(h.token, h.tool.name, {}, mode);
        expect(outcome.kind).toBe(
          tainted ? "declined" : mode === "dry-run" ? "would_run" : "executed"
        );
        if (tainted) expect(outcome).toEqual({ kind: "declined", reason: "would_confirm" });
      }
      const pending = h.gateway.callTool(h.token, h.tool.name, {});
      if (tainted) await rejectPending(h, pending);
      else expect(await pending).toMatchObject({ ok: true });
    }
  );

  it("cross-tool reads have no bound thread and cannot bypass confirmWhenTainted", async () => {
    const h = build({ resolution: resolution(true) });
    expect(await h.gateway.runReadToolForActor("actor-a", h.tool.name, {})).toMatchObject({
      ok: false
    });
    expect(h.isTainted).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("rechecks taint at execution after a clean dry run", async () => {
    const h = build({ tier: "ask_each_time" });
    expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, "dry-run")).toEqual({
      kind: "would_run",
      approvalMode: "auto"
    });
    h.isTainted.mockResolvedValue(true);
    expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, "execute")).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("rechecks taint after asynchronous policy work", async () => {
    for (const entry of ["ordinary", "dry-run", "execute"] as const) {
      let tainted = false;
      const checked = vi.fn(async () => tainted);
      const h = build({
        tier: "ask_each_time",
        tool: {
          requiresConfirmation: async () => {
            tainted = true;
            return false;
          }
        },
        deps: { provenance: { isTainted: checked, recordAdmission: vi.fn() } }
      });
      if (entry === "ordinary")
        await rejectPending(h, h.gateway.callTool(h.token, h.tool.name, {}));
      else
        expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, entry)).toEqual({
          kind: "declined",
          reason: "would_confirm"
        });
      expect(h.handler).not.toHaveBeenCalled();
      expect(checked).toHaveBeenCalledTimes(entry === "ordinary" ? 2 : 1);
    }
  });

  it("keeps in-flight thread A bound when the current session resumes clean B", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.fn(
      async (_actor: string, thread: string | undefined) => thread !== "thread-b"
    );
    const h = build({
      tier: "ask_each_time",
      deps: {
        resolveLocalTimezone: async () => {
          await waiting;
          return null;
        },
        provenance: {
          isTainted: lookup,
          recordAdmission: vi.fn(),
          runAutomatic: async (_actor, _thread, callback) => ({
            kind: "ran",
            value: await callback()
          })
        }
      }
    });
    const pending = h.gateway.callTool(h.token, h.tool.name, {});
    h.identity.threadId = "thread-b";
    h.identity.actorUserId = "actor-b";
    const resumed = h.tokens.mint({
      actorUserId: "actor-a",
      chatSessionId: "actor-a:chat",
      threadId: "thread-b",
      allowedToolNames: null
    });
    release();
    await rejectPending(h, pending);
    expect(lookup).toHaveBeenNthCalledWith(1, "actor-a", "thread-a");
    expect(await h.gateway.callTool(resumed, h.tool.name, {})).toMatchObject({ ok: true });
    expect(lookup).toHaveBeenNthCalledWith(3, "actor-a", "thread-b");
    expect(h.handler).toHaveBeenCalledOnce();
  });
});

describe("policy confirmation floor", () => {
  const lookup = (tier: "ask_each_time" | "trusted_auto") => ({
    getFamilyTier: async () => tier,
    getFamilyManifest: async () => family
  });

  it.each(["write", "outbound", "destructive", "read"] as const)(
    "tainted %s defeats sorted-safe and resolved-call shortcuts",
    async (risk) => {
      const h = build({ risk });
      expect(
        await resolvePolicy(
          h.tool,
          "example",
          false,
          lookup("trusted_auto"),
          true,
          true,
          true,
          true
        )
      ).toBe("confirm");
      expect(
        await resolvePolicy(h.tool, "example", false, lookup("ask_each_time"), true, true, true)
      ).toBe(risk === "read" ? "run" : "confirm");
    }
  );

  it("tainted promoted family runs unless its per-call limit asks", async () => {
    const h = build({ tool: { isExternal: false } });
    expect(
      await resolvePolicy(h.tool, "example", false, lookup("trusted_auto"), false, false, true)
    ).toBe("run");
    expect(
      await resolvePolicy(h.tool, "example", true, lookup("trusted_auto"), false, false, true)
    ).toBe("confirm");
  });
});
