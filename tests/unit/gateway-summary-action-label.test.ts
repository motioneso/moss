import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { MossModuleManifest } from "@moss/module-sdk";

/**
 * #1254 — approval-card summary priority chain: tool.summarize?.() ?? tool.actionLabel ??
 * tool.name. A module tool can never supply `summarize` (JSON manifest), so `actionLabel` is
 * the human-authored label a module gets to show instead of its raw tool name.
 */
describe("gateway summaryFor() actionLabel priority", () => {
  const moduleWith = (
    tool: MossModuleManifest["assistantTools"] extends readonly (infer T)[] ? T : never
  ): MossModuleManifest => ({
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  });

  const buildGateway = (module: MossModuleManifest, emitted: unknown[]) => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [module],
      repository: {
        createPendingAssistantAction: async () => ({ id: "action-1" })
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    return { gateway, token, confirmations };
  };

  const baseTool = (overrides: Record<string, unknown>) => ({
    name: "acme.write",
    description: "acme.write (1 field(s))",
    permissionId: "acme.write",
    risk: "write" as const,
    execute: async () => ({ data: { ok: true } }),
    ...overrides
  });

  const emitSummary = async (tool: unknown) => {
    const emitted: unknown[] = [];
    const module = moduleWith(tool as never);
    const { gateway, token, confirmations } = buildGateway(module, emitted);
    const pending = gateway.callTool(token, "acme.write", { value: 1 });
    await vi.waitFor(() =>
      expect(emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(true)
    );
    const request = emitted.find((r) => (r as { kind: string }).kind === "action_request") as {
      summary: string;
    };
    confirmations.resolve("action-1", "confirmed");
    await pending;
    return request.summary;
  };

  it("uses actionLabel over description when the tool declares no summarize", async () => {
    const summary = await emitSummary(baseTool({ actionLabel: "Send the calendar invite" }));
    expect(summary).toBe("Send the calendar invite");
  });

  it("falls back to tool name when actionLabel is undeclared", async () => {
    const summary = await emitSummary(baseTool({}));
    expect(summary).toBe("acme.write");
  });

  it("summarize still wins over actionLabel when both are declared", async () => {
    const summary = await emitSummary(
      baseTool({
        actionLabel: "static label",
        summarize: () => "computed summary"
      })
    );
    expect(summary).toBe("computed summary");
  });
});
