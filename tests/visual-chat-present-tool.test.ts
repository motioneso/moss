import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { ConversationProvenancePort } from "@moss/ai";
import type { ToolContext } from "@moss/module-sdk";
import { listAssistantToolsFromManifests } from "../packages/ai/src/assistant-tools.js";
import { chatModuleManifest } from "../packages/chat/src/manifest.js";
import { buildChatGatewayDependencies } from "../packages/chat/src/gateway-services.js";
import { chatPresentExecute } from "../packages/chat/src/visual/present-tool.js";
import { CONTEXT_ADMISSION_UNAVAILABLE } from "../packages/ai/src/gateway/content-admission.js";
import {
  PRESENTATION_UNAVAILABLE,
  VisualPresentationService
} from "../packages/chat/src/visual/presentation-service.js";

const identity = { actorUserId: "actor-a", threadId: "thread-a", turnId: "turn-a" };
const ctx: ToolContext = { ...identity, chatSessionId: "actor-a:chat", requestId: "request-a" };
const data = { projects: "garden, reading, music", hours: 6, availableHours: 6 };
const retrievedAt = "2026-10-23T12:00:00.000Z";
const program = 'root = Reply([Section("Allocation", [Fact("REF", "hours")])]);';
function proposal(ref: string, field = "hours") {
  return {
    catalogVersion: "moss.user-data.1",
    blocks: [
      {
        kind: "composition",
        snapshotRefs: [ref],
        program: program.replace("REF", ref).replace("hours", field)
      }
    ]
  };
}
function open(service = new VisualPresentationService()) {
  const turn = service.begin(ctx.chatSessionId, identity);
  const registered = turn.registerUserData(data, retrievedAt);
  if (!registered.ok) throw new Error(registered.code);
  return { service, turn, ref: registered.ref };
}

function gateway(service?: VisualPresentationService) {
  const recordAdmission = vi.fn<ConversationProvenancePort["recordAdmission"]>(async () => {});
  const tokens = new SessionTokenRegistry();
  tokens.setCurrentTurnId(ctx.chatSessionId, identity.turnId);
  const token = tokens.mint({
    actorUserId: identity.actorUserId,
    chatSessionId: ctx.chatSessionId,
    threadId: identity.threadId,
    allowedToolNames: new Set(["chat.present"])
  });
  const runner = {
    rootDb: {} as never,
    withDataContext: vi.fn(async (_access: unknown, fn: (db: never) => unknown) => fn({} as never))
  };
  const deps = buildChatGatewayDependencies({
    resolveActiveModules: async () => [chatModuleManifest],
    repository: {} as never,
    runner: runner as never,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: vi.fn() },
    collaborators: {},
    conversationProvenance: { isTainted: async () => false, recordAdmission },
    visualPresentation: service
  });
  return { deps, tokens, token, recordAdmission, gateway: new AssistantToolGateway(deps) };
}

describe("internal chat.present", () => {
  it("is discovered through the existing manifest catalog as read-only", () => {
    expect(listAssistantToolsFromManifests([chatModuleManifest])).toContainEqual(
      expect.objectContaining({ name: "chat.present", risk: "read", permissionId: "chat.view" })
    );
  });

  it("finalizes a novel composition from host-labeled user data without a domain template", () => {
    const { service, turn, ref } = open();
    const result = service.present(ctx, proposal(ref));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.reply.blocks[0]?.kind).toBe("composition");
    expect(result.reply.snapshots[0]).toMatchObject({
      ref,
      origin: "user",
      source: { id: "user-supplied", label: "Your data" },
      fields: data
    });
    expect(result.reply.fallbackText).toContain('"availableHours":6');
    expect(turn.reply).toBe(result.reply);
  });

  it.each([
    { actorUserId: "other" },
    { threadId: "other" },
    { turnId: "other" },
    { chatSessionId: "other" },
    { turnId: undefined },
    { threadId: undefined }
  ])("refuses foreign or missing host context %j without consuming the attempt", (change) => {
    const { service, ref } = open();
    expect(service.present({ ...ctx, ...change }, proposal(ref))).toEqual({
      ok: false,
      code: "unavailable",
      fallbackText: PRESENTATION_UNAVAILABLE
    });
    expect(service.present(ctx, proposal(ref)).ok).toBe(true);
  });

  it.each([null, { ...proposal("vs_forged"), actorUserId: "other" }, proposal("vs_forged")])(
    "uses host prose for an invalid proposal and permits no second attempt (%j)",
    (invalid) => {
      const { service, turn, ref } = open();
      expect(service.present(ctx, invalid)).toMatchObject({
        ok: false,
        fallbackText: expect.stringContaining("Your data")
      });
      expect(service.present(ctx, proposal(ref))).toMatchObject({
        ok: false,
        code: "already_presented"
      });
      expect(turn.reply).toBeUndefined();
    }
  );

  it.each(["close", "discard"] as const)("refuses after %s and drops pending output", (end) => {
    const { service, turn, ref } = open();
    expect(service.present(ctx, proposal(ref)).ok).toBe(true);
    turn[end]();
    expect(service.present(ctx, proposal(ref))).toMatchObject({ ok: false, code: "unavailable" });
    expect(turn.reply).toBeUndefined();
    expect(turn.registry.state).toBe(end === "close" ? "closed" : "discarded");
  });

  it("discards replaced turns and an old release cannot remove the next binding", () => {
    const { service, turn, ref } = open();
    const nextIdentity = { ...identity, turnId: "turn-b", threadId: "thread-b" };
    const next = service.begin(ctx.chatSessionId, nextIdentity);
    service.release(ctx.chatSessionId, turn);
    expect(turn.registry.state).toBe("discarded");
    expect(service.present(ctx, proposal(ref)).ok).toBe(false);
    const registered = next.registerUserData({ next: true }, retrievedAt);
    if (!registered.ok) throw new Error(registered.code);
    expect(service.present({ ...ctx, ...nextIdentity }, proposal(registered.ref, "next")).ok).toBe(
      true
    );
  });

  it("bounds user data and does not silently truncate oversized fallback facts", () => {
    const service = new VisualPresentationService();
    const turn = service.begin(ctx.chatSessionId, identity);
    expect(turn.registerUserData({ text: "x".repeat(501) }, retrievedAt).ok).toBe(false);
    const fields = { rows: Array.from({ length: 10 }, () => "x".repeat(450)) };
    const registered = turn.registerUserData(fields, retrievedAt);
    if (!registered.ok) throw new Error(registered.code);
    const result = service.present(ctx, proposal(registered.ref));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fallbackText).toContain("too long");
  });

  it("returns text only through the actual tool, never its raw program or snapshots", async () => {
    const { service, ref } = open();
    const result = await chatPresentExecute(null, { proposal: proposal(ref) }, ctx, {
      visualPresentation: service
    });
    expect(result.data).toEqual({
      status: "accepted",
      fallbackText: expect.stringContaining("Your data")
    });
    expect(JSON.stringify(result)).not.toContain(program);
    expect(JSON.stringify(result)).not.toContain("snapshotRefs");
    const missing = await chatPresentExecute(null, { proposal: null }, ctx);
    expect(missing.data).toMatchObject({ status: "text_fallback" });
  });

  it("stays hidden without internal read services and cannot use a write registry", async () => {
    const { deps, gateway: gw } = gateway();
    expect(await gw.listToolsForActor(identity.actorUserId)).not.toContainEqual(
      expect.objectContaining({ name: "chat.present" })
    );
    const writeOnly = new AssistantToolGateway({
      ...deps,
      toolServices: { visualPresentation: new VisualPresentationService() }
    });
    expect(await writeOnly.listToolsForActor(identity.actorUserId)).not.toContainEqual(
      expect.objectContaining({ name: "chat.present" })
    );
  });

  it("runs the registered tool through the gateway using host identity", async () => {
    const { service, turn, ref } = open();
    const { gateway: gw, token, recordAdmission } = gateway(service);
    const response = await gw.callTool(token, "chat.present", { proposal: proposal(ref) });
    expect(response).toMatchObject({
      ok: true,
      structuredData: {
        status: "accepted",
        fallbackText: expect.stringContaining("Your data")
      }
    });
    expect(turn.reply?.snapshots[0]?.ref).toBe(ref);
    expect(recordAdmission).toHaveBeenCalledExactlyOnceWith(
      identity.actorUserId,
      identity.threadId,
      "tool_external_content"
    );
    expect(response.ok && response.data).toMatchObject({
      text: expect.stringContaining('<tool_result source="chat.present">')
    });
    expect(JSON.stringify(response)).not.toContain(program);
  });

  it("withholds supplied fallback text when outside-content admission fails", async () => {
    const { service, ref } = open();
    const { gateway: gw, token, recordAdmission } = gateway(service);
    recordAdmission.mockRejectedValue(new Error("private admission storage failure"));
    const response = await gw.callTool(token, "chat.present", { proposal: proposal(ref) });
    expect(recordAdmission).toHaveBeenCalledOnce();
    expect(response).toEqual({ ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE });
    expect(JSON.stringify(response)).not.toContain("Your data");
    expect(JSON.stringify(response)).not.toContain("private admission storage failure");
  });

  it("returns an ordinary tool fallback for malformed proposals, without throwing a correction", async () => {
    const { service } = open();
    const { gateway: gw, token } = gateway(service);
    expect(
      await gw.callTool(token, "chat.present", { proposal: { program: "Query(secret)" } })
    ).toMatchObject({
      ok: true,
      structuredData: {
        status: "text_fallback",
        fallbackText: expect.stringContaining("Your data")
      }
    });
  });

  it("captures the host turn before awaited preparation, refusing a delayed call after replacement", async () => {
    const { service } = open();
    const { deps, tokens, token } = gateway(service);
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const gw = new AssistantToolGateway({
      ...deps,
      resolveLocale: async () => {
        entered();
        await paused;
        return null;
      }
    });
    const call = gw.callTool(token, "chat.present", {
      proposal: {
        catalogVersion: "moss.user-data.1",
        blocks: [{ kind: "composition", snapshotRefs: [], program }]
      }
    });
    await ready;
    const next = service.begin(ctx.chatSessionId, { ...identity, turnId: "turn-b" });
    next.registerUserData({ next: true }, retrievedAt);
    tokens.setCurrentTurnId(ctx.chatSessionId, "turn-b");
    resume();
    expect(await call).toMatchObject({
      ok: true,
      structuredData: { status: "text_fallback", fallbackText: PRESENTATION_UNAVAILABLE }
    });
  });
});
