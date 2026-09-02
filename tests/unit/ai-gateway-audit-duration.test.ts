import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { ModuleAssistantToolManifest, MossModuleManifest, ToolResult } from "@moss/module-sdk";

function manifestWithTool(
  toolOverrides: Partial<ModuleAssistantToolManifest> & {
    execute: ModuleAssistantToolManifest["execute"];
  }
): MossModuleManifest {
  return {
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: [
      {
        name: "acme.write",
        description: "Write",
        permissionId: "acme.write",
        risk: "write",
        ...toolOverrides
      }
    ]
  };
}

async function runYoloAndCaptureAudit(
  toolOverrides: Partial<ModuleAssistantToolManifest> & {
    execute: ModuleAssistantToolManifest["execute"];
  }
): Promise<{ outcome: string; durationMs: number | null }> {
  const audits: { outcome: string; durationMs: number | null }[] = [];
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [manifestWithTool(toolOverrides)],
    repository: {
      insertActionAuditLog: async (
        _db: unknown,
        input: { outcome: string; duration_ms?: never; durationMs: number | null }
      ) => {
        audits.push({ outcome: input.outcome, durationMs: input.durationMs });
      }
    } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never,
    tokens,
    confirmations,
    notifier: { emit: () => {} },
    confirmTimeoutMs: 50,
    yoloMode: async () => true
  });
  const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });
  await gateway.callTool(token, "acme.write", {});
  await vi.waitFor(() => expect(audits).toHaveLength(1));
  return audits[0]!;
}

describe("gateway audit duration + trusted auditOutcome (#2175 Task 7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a positive duration for a normal successful call", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const value = now;
      now += 42;
      return value;
    });

    const audit = await runYoloAndCaptureAudit({
      execute: async (): Promise<ToolResult> => ({ data: { written: true } })
    });

    expect(audit.outcome).toBe("success");
    expect(audit.durationMs).toBe(42);
  });

  it("ignores auditOutcome from a non-trusted (external) tool and records a plain success", async () => {
    // isExternal left unset (not === false) — the trust check must only honour auditOutcome for
    // a registry-marked built-in tool, so an external tool cannot claim "suppressed" to hide a
    // real call behind a softer audit outcome.
    const audit = await runYoloAndCaptureAudit({
      execute: async (): Promise<ToolResult> => ({
        data: { written: true },
        auditOutcome: "suppressed"
      })
    });

    expect(audit.outcome).toBe("success");
  });
});
