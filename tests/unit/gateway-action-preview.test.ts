import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { ActionRequestPreview, MossModuleManifest } from "@moss/module-sdk";

/**
 * T7 — gateway threads a tool's async `preview` hook into the `action_request` emit ONLY.
 * The persisted action row's `inputSummary` must stay key-names-only (metadata-only
 * persistence); an unavailable preview must never create a blind fresh card.
 */
describe("gateway action_request preview threading", () => {
  const preview: ActionRequestPreview = {
    to: "alice@example.test",
    subject: "Re: lunch",
    body: "Sounds great — see you at noon."
  };

  const moduleWith = (
    tool: MossModuleManifest["assistantTools"] extends readonly (infer T)[] ? T : never
  ): MossModuleManifest => ({
    id: "email",
    name: "Email",
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
      provenance: { isTainted: async () => true, recordAdmission: async () => undefined },
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
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({
      actorUserId: "u1",
      chatSessionId: "s1",
      threadId: "thread",
      allowedToolNames: null
    });
    return { gateway, token, confirmations };
  };

  const draftTool = (previewHook: unknown) => ({
    name: "email.draftReply",
    actionLabel: "Draft email reply",
    description: "Draft a reply.",
    permissionId: "email.write",
    risk: "destructive" as const,
    inputSchema: {
      type: "object",
      required: ["cacheMessageId", "body"],
      properties: { cacheMessageId: { type: "string" }, body: { type: "string" } }
    },
    execute: async () => ({ data: { ok: true } }),
    preview: previewHook
  });

  it("includes the tool's preview in the action_request emit", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(draftTool(async () => preview) as never);
    const { gateway, token, confirmations } = buildGateway(module, capture);

    const pending = gateway.callTool(token, "email.draftReply", {
      cacheMessageId: "m1",
      body: "Sounds great — see you at noon."
    });

    await vi.waitFor(() =>
      expect(capture.emitted.some((r) => (r as { kind: string }).kind === "action_request")).toBe(
        true
      )
    );
    const request = capture.emitted.find(
      (r) => (r as { kind: string }).kind === "action_request"
    ) as { preview?: ActionRequestPreview };
    expect(request.preview).toEqual(preview);

    // Persisted row carries only key names — never the composed body.
    expect(capture.created[0]).toMatchObject({
      inputSummary: expect.objectContaining({ inputKeys: expect.arrayContaining(["body"]) })
    });
    const persistedJson = JSON.stringify(capture.created[0]);
    expect(persistedJson).not.toContain("Sounds great");

    confirmations.resolve("action-1", "confirmed");
    await pending;
  });

  it("refuses before a pending row when a preview hook fails", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(
      draftTool(async () => {
        throw new Error("db exploded with a SECRET");
      }) as never
    );
    const { gateway, token, confirmations } = buildGateway(module, capture);
    const result = await gateway.callTool(token, "email.draftReply", {
      cacheMessageId: "m1",
      body: "hello"
    });
    expect(result).toEqual({
      ok: false,
      error: "The app could not prepare this action. Try again or use its app screen."
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(capture.emitted).toEqual([]);
    expect(capture.created).toEqual([]);
    expect(confirmations.isAwaiting("action-1")).toBe(false);
  });

  it("does not create a blind fresh card when no presentation exists", async () => {
    const capture = { emitted: [] as unknown[], created: [] as unknown[] };
    const module = moduleWith(draftTool(undefined) as never);
    const { gateway, token, confirmations } = buildGateway(module, capture);
    const result = await gateway.callTool(token, "email.draftReply", {
      cacheMessageId: "m1",
      body: "hello"
    });
    expect(result).toMatchObject({
      ok: false,
      denied: true,
      reason: expect.stringContaining("approval_unavailable")
    });
    expect(capture.emitted).toEqual([]);
    expect(capture.created).toEqual([]);
    expect(confirmations.isAwaiting("action-1")).toBe(false);
  });
});
