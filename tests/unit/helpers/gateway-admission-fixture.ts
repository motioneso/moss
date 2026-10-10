import { expect, vi } from "vitest";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type AssistantToolGatewayDependencies,
  type ConversationProvenancePort,
  type GatewaySessionRecord,
  type PerCallResolution
} from "@moss/ai";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";

export function admissionTool(
  name: string,
  overrides: Partial<ModuleAssistantToolManifest> = {}
): ModuleAssistantToolManifest {
  return {
    name,
    description: `Fixed description for ${name}`,
    permissionId: "example.use",
    actionFamilyId: "change",
    risk: "read",
    ...(overrides.risk && overrides.risk !== "read"
      ? {
          actionLabel: "Apply fixture action",
          approvalContent: "user_authored" as const,
          approvalPresentation: async (_db: unknown, input: Record<string, unknown>) => ({
            target: "Fixture target",
            fields: Object.entries(input).map(([label, value]) => ({
              label,
              value: JSON.stringify(value)
            }))
          })
        }
      : {}),
    content: "user_authored",
    isExternal: false,
    executionPolicy: "auto",
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ data: { value: "tool result" } })),
    ...overrides
  };
}

/**
 * A write no user setting trusts: an owned connected tool that sends data out. It runs in a
 * clean chat under fixture YOLO and asks once the chat holds outside content (#3338).
 */
export function untrustedWrite(name = "connected.send"): ModuleAssistantToolManifest {
  return admissionTool(name, {
    risk: "outbound",
    isExternal: true,
    descriptorOwnerUserId: "actor-a"
  });
}

export function admissionModule(tools: readonly ModuleAssistantToolManifest[]): MossModuleManifest {
  return {
    id: "example",
    name: "Example",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: tools
  };
}

export function resolvedCall(
  overrides: Partial<Extract<PerCallResolution, { kind: "proceed" }>> = {}
): Extract<PerCallResolution, { kind: "proceed" }> {
  return {
    kind: "proceed",
    risk: "write",
    externalContent: false,
    forceConfirm: false,
    confirmWhenTainted: false,
    summary: "Change the requested app setting",
    details: { presentation: "human", target: "Setting", fields: [] },
    affectsModules: ["settings"],
    ...overrides
  };
}

/** In-memory port models ordering only; durable storage has its own reservation tests. */
export function admissionFixture(
  tools: readonly ModuleAssistantToolManifest[],
  options: {
    threadId?: string | null;
    deps?: Partial<AssistantToolGatewayDependencies>;
  } = {}
) {
  const state = { tainted: false, held: false };
  const events: string[] = [];
  const recordAdmission = vi.fn<ConversationProvenancePort["recordAdmission"]>(
    async (actor, thread, path) => {
      if (actor !== "actor-a" || thread !== "thread-a" || state.held) {
        throw new Error("private admission storage failure");
      }
      events.push(`admit:${path}`);
      state.tainted = true;
    }
  );
  const runAutomaticImpl: NonNullable<ConversationProvenancePort["runAutomatic"]> = async (
    actor,
    thread,
    callback
  ) => {
    if (actor !== "actor-a" || thread !== "thread-a" || state.held || state.tainted) {
      return { kind: "confirm" };
    }
    events.push("claim");
    state.held = true;
    try {
      return { kind: "ran", value: await callback() };
    } finally {
      state.held = false;
      events.push("release");
    }
  };
  const provenance: ConversationProvenancePort = {
    isTainted: vi.fn(async () => state.tainted),
    recordAdmission,
    runAutomatic: runAutomaticImpl
  };
  const runAutomatic = vi.spyOn(provenance, "runAutomatic");
  const records: GatewaySessionRecord[] = [];
  const createPending = vi.fn(async () => ({ id: "action-1" }));
  const audit = vi.fn(async () => undefined);
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const deps: AssistantToolGatewayDependencies = {
    resolveActiveModules: async () => [admissionModule(tools)],
    runner: {
      withDataContext: async (_access: unknown, callback: (db: unknown) => unknown) => callback({})
    } as never,
    repository: {
      createPendingAssistantAction: createPending,
      insertActionAuditLog: audit,
      resolveAssistantAction: vi.fn(
        async (_db: unknown, id: string, input: { status: string }) => ({
          id,
          status: input.status
        })
      ),
      expireAssistantAction: vi.fn(async () => ({ id: "action-1", status: "timed_out" }))
    } as never,
    tokens,
    confirmations,
    notifier: { emit: (_id, record) => records.push(record) },
    confirmTimeoutMs: 500,
    logger: { error: vi.fn() },
    provenance,
    yoloMode: async () => true,
    actionPolicy: () => ({
      getFamilyTier: async () => "trusted_auto",
      getFamilyManifest: async () => ({
        id: "change",
        label: "Change",
        description: "Change settings",
        defaultTier: "ask_each_time",
        allowedTiers: ["ask_each_time", "trusted_auto"]
      })
    }),
    ...options.deps
  };
  const gateway = new AssistantToolGateway(deps);
  const token = tokens.mint({
    actorUserId: "actor-a",
    threadId: options.threadId === undefined ? "thread-a" : options.threadId,
    chatSessionId: "actor-a:chat",
    allowedToolNames: null
  });
  return {
    gateway,
    token,
    tokens,
    confirmations,
    provenance,
    recordAdmission,
    runAutomatic,
    createPending,
    audit,
    records,
    state,
    events,
    deps
  };
}

export async function rejectAdmissionCard(
  h: ReturnType<typeof admissionFixture>,
  pending: Promise<unknown>
): Promise<void> {
  await vi.waitFor(() => expect(h.confirmations.isAwaiting("action-1")).toBe(true), {
    interval: 1
  });
  await vi.waitFor(
    () => expect(h.records.some((record) => record.kind === "action_request")).toBe(true),
    { interval: 1 }
  );
  h.confirmations.resolve("action-1", "rejected");
  await pending;
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
