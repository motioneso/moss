import { describe, expect, it, vi } from "vitest";

import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolExecute
} from "@moss/module-sdk";

import { ConfirmationRegistry } from "./confirmation-registry.js";
import { AssistantToolGateway, type AssistantToolGatewayDependencies } from "./gateway.js";
import { SessionTokenRegistry } from "./session-tokens.js";
import type {
  GatewaySessionRecord,
  PerCallResolution,
  PerCallResolver,
  PerCallServices
} from "./types.js";

const proceed = (
  fields: Partial<Extract<PerCallResolution, { kind: "proceed" }>> = {}
): PerCallResolution => ({
  kind: "proceed",
  risk: "write",
  externalContent: false,
  forceConfirm: false,
  confirmWhenTainted: false,
  summary: "Change Ocean theme",
  details: { target: "Ocean", fields: [{ label: "Name", value: "Ocean" }] },
  affectsModules: ["settings"],
  ...fields
});

function build(
  options: {
    resolution?: PerCallResolution;
    tool?: Partial<ModuleAssistantToolManifest>;
    deps?: Partial<AssistantToolGatewayDependencies>;
  } = {}
) {
  const order: string[] = [];
  const handler = vi.fn<ToolExecute>(async () => {
    order.push("handler");
    return { data: { ok: true, text: "result" } };
  });
  const resolver = vi.fn<PerCallResolver>(async () => {
    order.push("resolver");
    return options.resolution ?? proceed();
  });
  const tool: ModuleAssistantToolManifest = {
    name: "app.callAction",
    description: "Call an app route",
    permissionId: "settings.write",
    risk: "write",
    isExternal: false,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, body: { type: "object" } }
    },
    execute: handler,
    ...options.tool
  };
  const module: MossModuleManifest = {
    id: "settings",
    name: "Settings",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "required",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  };
  const records: GatewaySessionRecord[] = [];
  const createPending = vi.fn(async () => {
    order.push("pending");
    return { id: "action-1" };
  });
  const audit = vi.fn(async () => undefined);
  const yoloMode = vi.fn(async () => {
    order.push("policy");
    return true;
  });
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    // This fixture exercises ordinary policy on an explicitly clean conversation.
    provenance: {
      isTainted: async () => false,
      recordAdmission: async () => {},
      runAutomatic: async (_actor, _thread, execute) => ({ kind: "ran", value: await execute() })
    },
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
    yoloMode,
    perCallResolvers: { "app.callAction": resolver },
    ...options.deps
  });
  const token = tokens.mint({
    threadId: "clean-thread",
    actorUserId: "u1",
    chatSessionId: "s1",
    allowedToolNames: null
  });
  return {
    gateway,
    token,
    confirmations,
    handler,
    resolver,
    records,
    createPending,
    audit,
    yoloMode,
    order
  };
}

async function approve(harness: ReturnType<typeof build>) {
  await vi.waitFor(() => expect(harness.createPending).toHaveBeenCalledOnce());
  harness.confirmations.resolve("action-1", "confirmed");
}

const input = { path: "/api/settings/themes/ocean", body: { name: "Ocean" } };

describe("per-call policy", () => {
  it("validates before resolving and refuses before policy or execution", async () => {
    const h = build({ resolution: { kind: "refuse", reason: "consent_off" } });
    expect(await h.gateway.callTool(h.token, "app.callAction", {})).toMatchObject({ ok: false });
    expect(h.resolver).not.toHaveBeenCalled();
    expect(await h.gateway.callTool(h.token, "app.callAction", input)).toEqual({
      ok: false,
      denied: true,
      reason: "consent_off"
    });
    expect(h.yoloMode).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("fails closed and does not expose resolver exceptions", async () => {
    const h = build({
      deps: {
        perCallResolvers: {
          "app.callAction": async () => {
            throw new Error("SECRET");
          }
        }
      }
    });
    const result = await h.gateway.callTool(h.token, "app.callAction", input);
    expect(result).toEqual({ ok: false, denied: true, reason: "not_ready" });
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.yoloMode).not.toHaveBeenCalled();
  });

  it("uses destructive risk for YOLO, pending storage and audit, with exact card details", async () => {
    const h = build({ resolution: proceed({ risk: "destructive" }) });
    const pending = h.gateway.callTool(h.token, "app.callAction", input);
    await approve(h);
    expect(await pending).toMatchObject({ ok: true });
    expect(h.createPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ risk: "destructive" })
    );
    expect(h.records[0]).toMatchObject({
      kind: "action_request",
      summary: "Change Ocean theme",
      outsideContentNotice: false,
      details: { target: "Ocean", fields: [{ label: "Name", value: "Ocean" }] }
    });
    expect(h.records[1]).toMatchObject({
      kind: "action_result",
      summary: "Change Ocean theme",
      affectsModules: ["settings"]
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionKind: "destructive", approvalMode: "confirmed" })
    );
    expect(h.order).toEqual(["resolver", "policy", "pending", "handler"]);
  });

  it.each([false, true])("resolved reads skip rate limits and auditing (YOLO=%s)", async (yolo) => {
    const h = build({
      resolution: proceed({ risk: "read" }),
      deps: { yoloMode: async () => yolo }
    });
    for (let i = 0; i < 30; i += 1) {
      expect(await h.gateway.callTool(h.token, "app.callAction", input)).toMatchObject({
        ok: true
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(30);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.records).toEqual([]);
  });

  it.each([false, true])(
    "resolved writes run without a mutable family but remain rate limited (YOLO=%s)",
    async (yolo) => {
      const h = build({ deps: { yoloMode: async () => yolo } });
      expect(await h.gateway.callTool(h.token, "app.callAction", input)).toMatchObject({
        ok: true
      });
      expect(h.createPending).not.toHaveBeenCalled();
      expect(h.records[0]).toMatchObject({ kind: "action_result", affectsModules: ["settings"] });
      expect(h.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actionKind: "write" })
      );
      for (let i = 0; i < 30; i += 1) {
        await h.gateway.callToolForGate(h.token, "app.callAction", input, "execute");
      }
      expect(h.handler.mock.calls.length).toBeLessThan(30);
      expect(await h.gateway.callToolForGate(h.token, "app.callAction", input, "dry-run")).toEqual({
        kind: "declined",
        reason: "rate_limited"
      });
    }
  );

  it("honors forceConfirm even for a read and never audits a read", async () => {
    const h = build({ resolution: proceed({ risk: "read", forceConfirm: true }) });
    const pending = h.gateway.callTool(h.token, "app.callAction", input);
    await approve(h);
    expect(await pending).toMatchObject({ ok: true });
    expect(h.createPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ risk: "read" })
    );
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.records[1]).not.toHaveProperty("affectsModules");
  });

  it("uses effective content wrapping and read trust boundary", async () => {
    const boundary = vi.fn(async ({ execute }: { execute: () => Promise<unknown> }) => execute());
    const h = build({
      resolution: proceed({ risk: "read", externalContent: true }),
      deps: { readToolTrustBoundary: boundary as never }
    });
    const result = await h.gateway.callTool(h.token, "app.callAction", input);
    expect(boundary).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain("<tool_result source=");
  });

  it("does not report refresh modules for module-reported or thrown errors", async () => {
    for (const execute of [
      async () => ({ data: { ok: false } }),
      async () => {
        throw new Error("failed");
      }
    ]) {
      const h = build({ tool: { execute }, deps: { logger: { error: vi.fn() } } });
      await h.gateway.callTool(h.token, "app.callAction", input);
      expect(h.records[0]).toMatchObject({ kind: "action_result", outcome: "error" });
      expect(h.records[0]).not.toHaveProperty("affectsModules");
    }
  });

  it("snapshots input and resolution before approval so caller or resolver cannot retarget", async () => {
    const mutable = { path: input.path, body: { name: "Ocean" } };
    const resolution = proceed({ risk: "destructive" });
    const h = build({ resolution });
    const pending = h.gateway.callTool(h.token, "app.callAction", mutable);
    await vi.waitFor(() => expect(h.createPending).toHaveBeenCalledOnce());
    mutable.path = "/api/settings/themes/other";
    mutable.body.name = "Other";
    if (resolution.kind === "proceed")
      Object.assign(resolution, {
        risk: "read",
        summary: "Change another theme",
        affectsModules: ["other"]
      });
    h.confirmations.resolve("action-1", "confirmed");
    await pending;
    expect(h.handler).toHaveBeenCalledWith(
      expect.anything(),
      input,
      expect.anything(),
      expect.anything()
    );
    const resolvedInput = h.resolver.mock.calls[0]?.[0];
    expect(Object.isFrozen(resolvedInput)).toBe(true);
    expect(Object.isFrozen((resolvedInput as Record<string, unknown>).body)).toBe(true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionKind: "destructive" })
    );
    expect(h.records[1]).toHaveProperty("affectsModules", ["settings"]);
    expect(h.records[1]).toHaveProperty("summary", "Change Ocean theme");
  });

  it.each(["rejected", "timeout", "cancelled"] as const)(
    "preserves the resolved title on %s without executing or retrying",
    async (resolution) => {
      const h = build({ resolution: proceed({ risk: "destructive" }) });
      const pending = h.gateway.callTool(h.token, "app.callAction", input);
      await vi.waitFor(() => expect(h.records[0]?.kind).toBe("action_request"));
      if (resolution !== "timeout") h.confirmations.resolve("action-1", resolution);
      expect(await pending).toMatchObject({ ok: false, denied: true });
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.records[1]).toMatchObject({
        kind: "action_result",
        actionRequestId: "action-1",
        summary: "Change Ocean theme",
        outcome: "denied",
        decidedBy: resolution === "rejected" ? "person" : resolution
      });
      expect(h.records[1]).not.toHaveProperty("affectsModules");
    }
  );

  it("retains the resolved title and actual error after a person approved", async () => {
    const execute = vi.fn<ToolExecute>(async () => {
      throw new Error("handler failed");
    });
    const h = build({
      resolution: proceed({ risk: "destructive" }),
      tool: { execute },
      deps: { logger: { error: vi.fn() } }
    });
    const pending = h.gateway.callTool(h.token, "app.callAction", input);
    await approve(h);
    expect(await pending).toMatchObject({ ok: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(h.records[1]).toMatchObject({
      kind: "action_result",
      summary: "Change Ocean theme",
      decidedBy: "person",
      outcome: "error"
    });
    expect(h.records[1]).not.toHaveProperty("affectsModules");
  });
});

describe("other gateway entry points", () => {
  it("the classifier gate resolves in execute and dry-run and never raises a destructive card", async () => {
    const h = build({ resolution: proceed({ risk: "destructive" }) });
    for (const mode of ["execute", "dry-run"] as const) {
      expect(await h.gateway.callToolForGate(h.token, "app.callAction", input, mode)).toEqual({
        kind: "declined",
        reason: "would_confirm"
      });
    }
    expect(h.resolver).toHaveBeenCalledTimes(2);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("the classifier gate reads neither consume rate allowance nor audit", async () => {
    const h = build({ resolution: proceed({ risk: "read" }) });
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await h.gateway.callToolForGate(h.token, "app.callAction", input, "execute")).kind
      ).toBe("executed");
    }
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.records).toEqual([]);
  });

  it("cross-tool reads resolve effective risk and wrapping", async () => {
    const h = build({ resolution: proceed({ risk: "read", externalContent: true }) });
    const result = await h.gateway.runReadToolForActor("u1", "app.callAction", input);
    expect(result.ok).toBe(true);
    expect(h.resolver).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain("<tool_result source=");
  });

  it.each([
    proceed({ risk: "write" }),
    proceed({ risk: "read", forceConfirm: true }),
    { kind: "refuse", reason: "blocked" } as const
  ])(
    "cross-tool reads refuse writes, forced confirmation and resolver refusal",
    async (resolution) => {
      const h = build({ resolution, tool: { risk: "read" } });
      expect((await h.gateway.runReadToolForActor("u1", "app.callAction", input)).ok).toBe(false);
      expect(h.handler).not.toHaveBeenCalled();
    }
  );
});

describe("bound capabilities and policy callbacks", () => {
  it("resolved reads use only informational services when no call binding is required", async () => {
    const readServices = { catalog: {} };
    const h = build({
      resolution: proceed({ risk: "read" }),
      deps: { toolServices: { arbitraryWrite: {} }, readToolServices: readServices }
    });
    await h.gateway.callTool(h.token, "app.callAction", input);
    expect(h.handler).toHaveBeenCalledWith(
      expect.anything(),
      input,
      expect.anything(),
      readServices
    );
  });

  it("binds only after consent and validation, passing immutable input and resolution", async () => {
    const bound = { call: vi.fn() };
    const rawWrite = { call: vi.fn() };
    const services = vi.fn<PerCallServices>(() => ({ appActions: bound, undeclared: rawWrite }));
    const h = build({
      resolution: proceed({ risk: "read" }),
      tool: { requiresServices: ["appActions"] },
      deps: {
        toolServices: { appActions: rawWrite },
        perCallServices: { "app.callAction": services }
      }
    });
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(true);
    expect(h.handler).toHaveBeenCalledWith(expect.anything(), input, expect.anything(), {
      appActions: bound
    });
    expect(services).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ actorUserId: "u1" }),
      expect.objectContaining({ risk: "read" })
    );
    const args = services.mock.calls[0] as unknown[] | undefined;
    expect(args?.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(rawWrite.call).not.toHaveBeenCalled();

    const refused = build({
      resolution: { kind: "refuse", reason: "blocked", category: "secrets" },
      deps: { perCallServices: { "app.callAction": services } }
    });
    await refused.gateway.callTool(refused.token, "app.callAction", input);
    expect(services).toHaveBeenCalledOnce();
  });

  it("refuses a dynamically read tool's write service without an explicit call binding", async () => {
    const h = build({
      resolution: proceed({ risk: "read" }),
      tool: { requiresServices: ["appActions"] },
      deps: { toolServices: { appActions: { call: vi.fn() } } }
    });
    expect(await h.gateway.callTool(h.token, "app.callAction", input)).toEqual({
      ok: false,
      denied: true,
      reason: "not_ready"
    });
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("keeps a read manifest that declares write services unavailable", async () => {
    const h = build({
      resolution: proceed({ risk: "write" }),
      tool: { risk: "read", requiresServices: ["appActions"] },
      deps: { toolServices: { appActions: {} } }
    });
    expect(await h.gateway.listToolsForActor("u1")).toEqual([]);
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(false);
    expect(h.resolver).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("fails closed if capability construction throws or omits a declared service", async () => {
    for (const factory of [
      () => {
        throw new Error("SECRET");
      },
      () => ({})
    ]) {
      const h = build({
        resolution: proceed({ risk: "read" }),
        tool: { requiresServices: ["appActions"] },
        deps: { toolServices: { appActions: {} }, perCallServices: { "app.callAction": factory } }
      });
      expect(await h.gateway.callTool(h.token, "app.callAction", input)).toEqual({
        ok: false,
        denied: true,
        reason: "not_ready"
      });
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.yoloMode).not.toHaveBeenCalled();
    }
  });

  it("resolves before legacy confirmation hooks and still honors their override", async () => {
    const confirmation = vi.fn(async () => true);
    const h = build({ tool: { requiresConfirmation: confirmation } });
    const pending = h.gateway.callTool(h.token, "app.callAction", input);
    await approve(h);
    await pending;
    expect(h.resolver.mock.invocationCallOrder[0]).toBeLessThan(
      confirmation.mock.invocationCallOrder[0]!
    );
    expect(confirmation.mock.invocationCallOrder[0]).toBeLessThan(
      h.yoloMode.mock.invocationCallOrder[0]!
    );
    expect(h.records[0]).toMatchObject({ kind: "action_request" });
  });

  it.each(["read", "destructive"] as const)(
    "uses effective %s risk when considering sorted-safe hooks",
    async (risk) => {
      const runsWithoutAsking = vi.fn(async () => true);
      const h = build({
        resolution: proceed({ risk }),
        tool: { isExternal: true, runsWithoutAsking },
        deps: { yoloMode: async () => false }
      });
      if (risk === "destructive") {
        const pending = h.gateway.callTool(h.token, "app.callAction", input);
        await approve(h);
        await pending;
      } else {
        await h.gateway.callTool(h.token, "app.callAction", input);
      }
      expect(runsWithoutAsking).not.toHaveBeenCalled();
    }
  );

  it("does not add refresh modules for a successful envelope that reports no write", async () => {
    const h = build({
      tool: { execute: async () => ({ data: { ok: true }, auditOutcome: "refused" }) }
    });
    await h.gateway.callTool(h.token, "app.callAction", input);
    expect(h.records[0]).not.toHaveProperty("affectsModules");
  });
});

describe("read-service declarations", () => {
  it("lists a read catalog tool only from the read registry and dispatches its declared subset", async () => {
    const appCatalog = { findAction: vi.fn() };
    const h = build({
      tool: { risk: "read", requiresServices: ["appCatalog"] },
      deps: {
        perCallResolvers: {},
        readToolServices: { appCatalog, unrelatedRead: {} },
        toolServices: { appCatalog: { write: vi.fn() } }
      }
    });
    expect(await h.gateway.listToolsForActor("u1")).toMatchObject([
      { name: "app.callAction", risk: "read" }
    ]);
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(true);
    expect(h.handler).toHaveBeenCalledWith(expect.anything(), input, expect.anything(), {
      appCatalog
    });
  });

  it("hides a read tool when one of its required read keys is missing", async () => {
    const h = build({
      tool: { risk: "read", requiresServices: ["appCatalog", "missingRead"] },
      deps: { perCallResolvers: {}, readToolServices: { appCatalog: {} } }
    });
    expect(await h.gateway.listToolsForActor("u1")).toEqual([]);
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("never satisfies a read declaration from the write-only registry", async () => {
    const h = build({
      tool: { risk: "read", requiresServices: ["appCatalog"] },
      deps: { perCallResolvers: {}, toolServices: { appCatalog: { write: vi.fn() } } }
    });
    expect(await h.gateway.listToolsForActor("u1")).toEqual([]);
    expect((await h.gateway.runReadToolForActor("u1", "app.callAction", input)).ok).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
  });
});

describe("composition-owned per-call execution", () => {
  it("runs a bound transport without holding a gateway DB scope", async () => {
    let activeScopes = 0;
    const runner = {
      withDataContext: async <T>(
        _access: unknown,
        work: (db: unknown) => Promise<T>
      ): Promise<T> => {
        if (activeScopes !== 0) throw new Error("nested transaction would exhaust a pool of one");
        activeScopes += 1;
        try {
          return await work({});
        } finally {
          activeScopes -= 1;
        }
      }
    };
    const transport = vi.fn(async () => {
      expect(activeScopes).toBe(0);
      return runner.withDataContext({}, async () => ({ data: { ok: true } }));
    });
    const h = build({
      resolution: proceed({ risk: "read" }),
      tool: { requiresServices: ["appActions"] },
      deps: {
        runner: runner as never,
        toolServices: { appActions: {} },
        perCallServices: { "app.callAction": () => ({ appActions: {} }) },
        perCallExecutors: { "app.callAction": transport }
      }
    });
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(true);
    expect(transport).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ actorUserId: "u1" }),
      expect.objectContaining({ kind: "proceed", risk: "read" }),
      { appActions: {} }
    );
    expect(h.handler).not.toHaveBeenCalled();
  });

  it.each(["missing resolver", "missing binding", "refused"])(
    "cannot use composition execution with %s",
    async (missing) => {
      const execute = vi.fn(async () => ({ data: { ok: true } }));
      const h = build({
        resolution: missing === "refused" ? { kind: "refuse", reason: "blocked" } : proceed(),
        deps: {
          ...(missing === "missing resolver" ? { perCallResolvers: {} } : {}),
          ...(missing !== "missing binding"
            ? { perCallServices: { "app.callAction": () => ({}) } }
            : {}),
          perCallExecutors: { "app.callAction": execute }
        }
      });
      expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it("ordinary read handlers and their trust boundary still execute inside the scoped runner", async () => {
    const scopedDb = {};
    let active = false;
    const execute = vi.fn(async (db: unknown) => {
      expect(active).toBe(true);
      expect(db).toBe(scopedDb);
      return { data: { ok: true } };
    });
    const boundary = vi.fn(async (args: { scopedDb: unknown; execute: () => Promise<unknown> }) => {
      expect(active).toBe(true);
      expect(args.scopedDb).toBe(scopedDb);
      return args.execute();
    });
    const h = build({
      tool: { risk: "read", execute },
      deps: {
        perCallResolvers: {},
        runner: {
          withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => {
            active = true;
            try {
              return await work(scopedDb);
            } finally {
              active = false;
            }
          }
        } as never,
        readToolTrustBoundary: boundary as never
      }
    });
    expect((await h.gateway.callTool(h.token, "app.callAction", input)).ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(boundary).toHaveBeenCalledOnce();
  });
});

describe("bound execution retains gateway outcomes", () => {
  it("waits for destructive approval before invoking the composition executor", async () => {
    const execute = vi.fn(async () => ({ data: { ok: true } }));
    const h = build({
      resolution: proceed({ risk: "destructive" }),
      deps: {
        perCallServices: { "app.callAction": () => ({}) },
        perCallExecutors: { "app.callAction": execute }
      }
    });
    const pending = h.gateway.callTool(h.token, "app.callAction", input);
    await vi.waitFor(() => expect(h.createPending).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
    h.confirmations.resolve("action-1", "confirmed");
    expect((await pending).ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.records[1]).toMatchObject({ kind: "action_result", affectsModules: ["settings"] });
  });

  it("still sanitizes errors thrown by a composition executor", async () => {
    const h = build({
      deps: {
        perCallServices: { "app.callAction": () => ({}) },
        perCallExecutors: {
          "app.callAction": async () => {
            throw new Error("SECRET");
          }
        },
        logger: { error: vi.fn() }
      }
    });
    expect(await h.gateway.callTool(h.token, "app.callAction", input)).toEqual({
      ok: false,
      error: "Tool app.callAction failed"
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", errorClass: "handler_error" })
    );
    expect(h.records[0]).not.toHaveProperty("affectsModules");
  });

  it("still caps and wraps outside content returned by a composition executor", async () => {
    const h = build({
      resolution: proceed({ risk: "read", externalContent: true }),
      deps: {
        perCallServices: { "app.callAction": () => ({}) },
        perCallExecutors: { "app.callAction": async () => ({ data: { text: "x".repeat(30_000) } }) }
      }
    });
    const result = await h.gateway.callTool(h.token, "app.callAction", input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a successful read");
    expect(JSON.stringify(result.data)).toContain("<tool_result source=");
    expect(JSON.stringify(result.data)).toContain("[truncated tool result]");
    expect(JSON.stringify(result.data).length).toBeLessThan(17_000);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
