import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type {
  ModuleAssistantActionFamilyManifest,
  ModuleAssistantToolManifest,
  MossActionPermissionTier,
  MossModuleManifest
} from "@moss/module-sdk";

/**
 * The classifier gate's call path: a call that would need approval must decline with zero cards
 * and zero handler calls, and a dry run must evaluate the same decision with no side effects.
 */

const family: ModuleAssistantActionFamilyManifest = {
  id: "fam",
  label: "Family",
  description: "Family",
  defaultTier: "ask_each_time",
  allowedTiers: ["ask_each_time", "trusted_auto"]
};

type Risk = "read" | "write" | "outbound" | "destructive";

interface Setup {
  readonly risk: Risk;
  readonly yolo: boolean;
  readonly tier: MossActionPermissionTier | null;
  readonly override?: boolean;
  readonly output?: Record<string, unknown>;
  readonly throws?: boolean;
  readonly allowlist?: ReadonlySet<string> | null;
  readonly familyId?: string;
  /** Whether the family manifest allows trusted_auto (what unattended mode reads). */
  readonly manifestTrusts?: boolean;
}

const build = (initial: Setup) => {
  const setup: { -readonly [K in keyof Setup]: Setup[K] } = { ...initial };
  const handler = vi.fn(async () => {
    if (setup.throws) throw new Error("boom");
    return { data: setup.output ?? { done: true } };
  });
  const tool = {
    name: "mock.tool",
    description: "Mock tool",
    permissionId: "mock.tool",
    ...(setup.familyId === undefined ? { actionFamilyId: "fam" } : {}),
    risk: setup.risk,
    executionPolicy: "auto" as const,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    execute: handler,
    ...(setup.override === undefined ? {} : { requiresConfirmation: async () => setup.override })
  } as unknown as ModuleAssistantToolManifest;
  const module: MossModuleManifest = {
    id: "mock_module",
    name: "Mock Module",
    version: "1.0.0",
    publisher: "Jarv1s",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  };
  const audits = vi.fn(async (_db: unknown, _record: Record<string, unknown>) => undefined);
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
      insertActionAuditLog: audits
    } as never,
    runner: {
      withDataContext: async (_a: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: (_id, record) => emitted.push(record as { kind: string }) },
    confirmTimeoutMs: 1000,
    yoloMode: async () => setup.yolo,
    actionPolicy: () => ({
      getFamilyTier: async () => setup.tier,
      getFamilyManifest: async () =>
        setup.manifestTrusts === false ? { ...family, allowedTiers: ["ask_each_time"] } : family
    })
  });
  const token = tokens.mint({
    threadId: "clean-thread",
    actorUserId: "u1",
    chatSessionId: "s1",
    allowedToolNames: setup.allowlist === undefined ? null : new Set(setup.allowlist ?? [])
  });
  return { gateway, token, handler, emitted, created, audits, tokens, state: setup };
};

const risks: Risk[] = ["read", "write", "outbound", "destructive"];

describe("callToolForGate: would-confirm declines with no side effects", () => {
  // Cases where the existing rules would raise a card.
  const confirmCases: Array<[string, Setup]> = [];
  for (const risk of risks) {
    if (risk === "read") continue;
    for (const yolo of [false, true]) {
      confirmCases.push([
        `${risk}, yolo=${yolo}, untrusted family`,
        { risk, yolo, tier: null, manifestTrusts: false }
      ]);
      confirmCases.push([
        `${risk}, yolo=${yolo}, trusted family but per-call override`,
        { risk, yolo, tier: "trusted_auto", override: true }
      ]);
    }
  }
  for (const risk of ["outbound", "destructive"] as const) {
    confirmCases.push([
      `${risk}, trusted family, still needs approval`,
      { risk, yolo: false, tier: "trusted_auto" }
    ]);
  }
  confirmCases.push([
    "write, normal mode, no family",
    { risk: "write", yolo: false, tier: null, familyId: "" }
  ]);

  it.each(confirmCases)("%s", async (_label, setup) => {
    const { gateway, token, handler, emitted, created } = build(setup);
    for (const mode of ["execute", "dry-run"] as const) {
      const outcome = await gateway.callToolForGate(token, "mock.tool", { name: "x" }, mode);
      expect(outcome).toEqual({ kind: "declined", reason: "would_confirm" });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

describe("callToolForGate: runs without approval", () => {
  const runCases: Array<[string, Setup, "yolo" | "auto"]> = [
    ["read, normal mode", { risk: "read", yolo: false, tier: null }, "auto"],
    ["read, yolo", { risk: "read", yolo: true, tier: null }, "auto"],
    [
      "write, trusted family, normal mode",
      { risk: "write", yolo: false, tier: "trusted_auto" },
      "auto"
    ],
    ["write, trusted family, yolo", { risk: "write", yolo: true, tier: "trusted_auto" }, "yolo"]
  ];

  it.each(runCases)("%s", async (_label, setup, approvalMode) => {
    const dry = build(setup);
    expect(
      await dry.gateway.callToolForGate(dry.token, "mock.tool", { name: "x" }, "dry-run")
    ).toEqual({ kind: "would_run", approvalMode });
    expect(dry.handler).not.toHaveBeenCalled();
    expect(dry.emitted).toHaveLength(0);

    const live = build(setup);
    const outcome = await live.gateway.callToolForGate(
      live.token,
      "mock.tool",
      { name: "x" },
      "execute"
    );
    expect(outcome.kind).toBe("executed");
    expect(live.handler).toHaveBeenCalledTimes(1);
    expect(live.emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
  });
});

describe("callToolForGate: dispatch checks", () => {
  const trustedWrite: Setup = { risk: "write", yolo: true, tier: "trusted_auto" };

  it("dry run does not consume the unattended-run allowance", async () => {
    const { gateway, token, handler } = build(trustedWrite);
    for (let i = 0; i < 50; i += 1) {
      expect(
        (await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "dry-run")).kind
      ).toBe("would_run");
    }
    const outcome = await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "execute");
    expect(outcome.kind).toBe("executed");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("declines once the allowance is spent, in both modes, with no handler call", async () => {
    const { gateway, token, handler, emitted } = build(trustedWrite);
    let executed = 0;
    let declined = 0;
    for (let i = 0; i < 30; i += 1) {
      const outcome = await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "execute");
      if (outcome.kind === "executed") executed += 1;
      else {
        expect(outcome).toEqual({ kind: "declined", reason: "rate_limited" });
        declined += 1;
      }
    }
    expect(executed).toBeGreaterThan(0);
    expect(declined).toBeGreaterThan(0);
    expect(handler).toHaveBeenCalledTimes(executed);
    expect(emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
    expect(await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "dry-run")).toEqual({
      kind: "declined",
      reason: "rate_limited"
    });
  });

  it("dry run writes no audit record, while a real run writes exactly one", async () => {
    const { gateway, token, audits } = build(trustedWrite);
    for (let i = 0; i < 5; i += 1) {
      await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "dry-run");
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(audits).not.toHaveBeenCalled();

    await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "execute");
    await vi.waitFor(() => expect(audits).toHaveBeenCalledTimes(1));
    expect(audits.mock.calls[0]![1]).toMatchObject({
      ownerUserId: "u1",
      toolName: "mock.tool",
      actionKind: "write",
      approvalMode: "yolo",
      outcome: "success",
      sourceSurface: "chat"
    });
  });

  it("normal mode at the rate limit declines with no card and no run, while callTool asks", async () => {
    const normalWrite: Setup = { risk: "write", yolo: false, tier: "trusted_auto" };
    const { gateway, token, handler, emitted, created } = build(normalWrite);
    let executed = 0;
    for (let i = 0; i < 30; i += 1) {
      const outcome = await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "execute");
      if (outcome.kind === "executed") executed += 1;
      else expect(outcome).toEqual({ kind: "declined", reason: "rate_limited" });
    }
    expect(executed).toBeGreaterThan(0);
    expect(executed).toBeLessThan(30);
    expect(handler).toHaveBeenCalledTimes(executed);
    expect(await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "dry-run")).toEqual({
      kind: "declined",
      reason: "rate_limited"
    });
    expect(handler).toHaveBeenCalledTimes(executed);
    expect(emitted.filter((r) => r.kind === "action_request")).toHaveLength(0);
    expect(created).toHaveLength(0);

    // The ordinary call at the same limit still asks for approval.
    void gateway.callTool(token, "mock.tool", { name: "x" });
    await vi.waitFor(() => expect(emitted.some((r) => r.kind === "action_request")).toBe(true));
    expect(created).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(executed);
  });

  it("re-checks policy at dispatch: a prior dry run is not authorization", async () => {
    const { gateway, token, handler, state } = build(trustedWrite);
    expect(await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "dry-run")).toEqual({
      kind: "would_run",
      approvalMode: "yolo"
    });
    // The family stops allowing unattended runs between the dry run and the real call.
    state.manifestTrusts = false;
    expect(await gateway.callToolForGate(token, "mock.tool", { name: "x" }, "execute")).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("declines a removed tool, a tool outside the allowlist, invalid input and a bad token", async () => {
    const { gateway, token } = build(trustedWrite);
    expect(await gateway.callToolForGate(token, "mock.gone", {}, "execute")).toEqual({
      kind: "declined",
      reason: "not_available"
    });
    expect(await gateway.callToolForGate(token, "mock.tool", { name: 5 }, "execute")).toEqual({
      kind: "declined",
      reason: "invalid_input"
    });
    expect(await gateway.callToolForGate(token, "mock.tool", {}, "dry-run")).toEqual({
      kind: "declined",
      reason: "invalid_input"
    });
    const restricted = build({ ...trustedWrite, allowlist: new Set(["other.tool"]) });
    expect(
      await restricted.gateway.callToolForGate(
        restricted.token,
        "mock.tool",
        { name: "x" },
        "execute"
      )
    ).toEqual({ kind: "declined", reason: "not_in_allowlist" });
    expect(restricted.handler).not.toHaveBeenCalled();
    await expect(
      gateway.callToolForGate("not-a-token", "mock.tool", { name: "x" }, "execute")
    ).rejects.toThrow();
  });

  it("reports a module-reported error and a thrown handler truthfully", async () => {
    const reported = build({ ...trustedWrite, output: { status: "error" } });
    const a = await reported.gateway.callToolForGate(
      reported.token,
      "mock.tool",
      { name: "x" },
      "execute"
    );
    expect(a).toMatchObject({ kind: "executed", outcome: "module_reported_error" });
    expect((a as { response: { ok: boolean } }).response.ok).toBe(true);

    const thrown = build({ ...trustedWrite, throws: true });
    const b = await thrown.gateway.callToolForGate(
      thrown.token,
      "mock.tool",
      { name: "x" },
      "execute"
    );
    expect(b).toMatchObject({ kind: "executed", outcome: "handler_error" });

    const fine = build(trustedWrite);
    expect(
      await fine.gateway.callToolForGate(fine.token, "mock.tool", { name: "x" }, "execute")
    ).toMatchObject({ kind: "executed", outcome: "success" });
  });

  it("default callTool still raises a card for the same would-confirm call", async () => {
    const { gateway, token, emitted } = build({ risk: "write", yolo: false, tier: null });
    void gateway.callTool(token, "mock.tool", { name: "x" });
    await vi.waitFor(() => expect(emitted.some((r) => r.kind === "action_request")).toBe(true));
  });
});
