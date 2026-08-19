import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { MossModuleManifest, ModuleAssistantActionFamilyManifest } from "@moss/module-sdk";

/**
 * Phase 1b — gateway.ts's computeConfirmOverride resolves a tool's async requiresConfirmation
 * hook BEFORE resolvePolicy runs, and must fail closed: a throwing/timing-out hook forces
 * "confirm", it never falls through to auto-run. Unlike ToolPreview (safe to skip on throw),
 * this hook gates whether a write actually executes unattended.
 */
describe("gateway computeConfirmOverride", () => {
  const familyManifest: ModuleAssistantActionFamilyManifest = {
    id: "mock_family",
    label: "Mock Family",
    description: "Mock Family Description",
    defaultTier: "ask_each_time",
    allowedTiers: ["ask_each_time", "trusted_auto"]
  };

  const moduleWith = (
    tool: MossModuleManifest["assistantTools"] extends readonly (infer T)[] ? T : never
  ): MossModuleManifest => ({
    id: "mock_module",
    name: "Mock Module",
    version: "1.0.0",
    publisher: "Jarv1s",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  });

  const buildGateway = (
    module: MossModuleManifest,
    capture: { emitted: unknown[]; created: unknown[] }
  ) => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [module],
      repository: {
        createPendingAssistantAction: async (_db: unknown, input: unknown) => {
          capture.created.push(input);
          return { id: "action-1" };
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => capture.emitted.push(record) },
      confirmTimeoutMs: 1000,
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => familyManifest
      })
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    return { gateway, token, confirmations };
  };

  const autoTool = (requiresConfirmation: unknown) => ({
    name: "mock.write",
    description: "Mock write tool that would otherwise auto-run under trusted_auto.",
    permissionId: "mock.write",
    actionFamilyId: "mock_family",
    risk: "write" as const,
    executionPolicy: "auto" as const,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ data: { ok: true } }),
    requiresConfirmation
  });

  it("auto-runs when the hook resolves false, under a trusted_auto family", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(autoTool(async () => false) as never);
    const { gateway, token } = buildGateway(module, capture);

    const result = await gateway.callTool(token, "mock.write", {});

    expect(result.ok).toBe(true);
    expect(capture.emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(
      false
    );
  });

  it("forces confirm when the hook resolves true, even under trusted_auto", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(autoTool(async () => true) as never);
    const { gateway, token, confirmations } = buildGateway(module, capture);

    const pending = gateway.callTool(token, "mock.write", {});

    await vi.waitFor(() =>
      expect(capture.emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(
        true
      )
    );
    confirmations.resolve("action-1", "confirmed");
    await pending;
  });

  it("fails closed to confirm when the hook throws", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(
      autoTool(async () => {
        throw new Error("db exploded with a SECRET");
      }) as never
    );
    const { gateway, token, confirmations } = buildGateway(module, capture);

    const pending = gateway.callTool(token, "mock.write", {});

    await vi.waitFor(() =>
      expect(capture.emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(
        true
      )
    );
    // The thrown message never rides the emit — same sanitization guarantee as preview.
    expect(JSON.stringify(capture.emitted)).not.toContain("SECRET");
    confirmations.resolve("action-1", "confirmed");
    await pending;
  });
});
