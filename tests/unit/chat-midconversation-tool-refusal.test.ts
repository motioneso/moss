import { describe, expect, it, vi } from "vitest";
import type { DataContextRunner } from "@moss/db";
import type { MossModuleManifest, ModuleAssistantToolManifest } from "@moss/module-sdk";

import { ConfirmationRegistry } from "../../packages/ai/src/gateway/confirmation-registry.js";
import { AssistantToolGateway } from "../../packages/ai/src/gateway/gateway.js";
import { SessionTokenRegistry } from "../../packages/ai/src/gateway/session-tokens.js";
import type { AiRepository } from "../../packages/ai/src/repository.js";

/**
 * #2942 — a chat session keeps the tool list it started with. These tests pin
 * both mid-conversation directions at the gateway, the single chokepoint every
 * tool call passes through:
 * - a tool switched off mid-conversation is refused when the chat calls it;
 * - a tool added mid-conversation is refused with a start-a-new-chat hint.
 */
function toolManifest(name: string, execute: () => never) {
  return {
    name,
    description: `${name} tool`,
    permissionId: `${name}.permission`,
    risk: "read",
    execute
  } as unknown as ModuleAssistantToolManifest;
}

function moduleWithTools(tools: readonly ModuleAssistantToolManifest[]): MossModuleManifest {
  return {
    id: "test-module",
    name: "Test module",
    assistantTools: tools
  } as unknown as MossModuleManifest;
}

function buildGateway(resolveActiveModules: () => Promise<readonly MossModuleManifest[]>) {
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules,
    repository: {} as AiRepository,
    runner: {} as unknown as DataContextRunner,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: () => {} },
    confirmTimeoutMs: 1000
  });
  return { gateway, tokens };
}

describe("mid-conversation tool changes (#2942)", () => {
  it("refuses a tool switched off after the session started, without running it", async () => {
    const execute = vi.fn((): never => {
      throw new Error("must not run");
    });
    let activeModules: readonly MossModuleManifest[] = [
      moduleWithTools([toolManifest("test.read", execute)])
    ];
    const { gateway, tokens } = buildGateway(async () => activeModules);

    // The session starts while the tool is on, capturing it in the allowlist —
    // the same shape routes.ts mints at engine launch.
    const token = tokens.mint({
      actorUserId: "actor-1",
      chatSessionId: "session-1",
      allowedToolNames: new Set(["test.read"])
    });

    // The tool is switched off mid-conversation.
    activeModules = [];

    const response = await gateway.callTool(token, "test.read", {});
    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("Tool not available")
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await gateway.listToolsForActor("actor-1")).toEqual([]);
  });

  it("tells the person to start a new chat for a tool added after the session started", async () => {
    const execute = vi.fn((): never => {
      throw new Error("must not run");
    });
    let activeModules: readonly MossModuleManifest[] = [];
    const { gateway, tokens } = buildGateway(async () => activeModules);

    // The session starts with no tools; an integration is connected
    // mid-conversation and its tool appears in fresh listings.
    const token = tokens.mint({
      actorUserId: "actor-1",
      chatSessionId: "session-1",
      allowedToolNames: new Set<string>()
    });
    activeModules = [moduleWithTools([toolManifest("test.new", execute)])];
    expect(await gateway.listToolsForActor("actor-1")).toHaveLength(1);

    const response = await gateway.callTool(token, "test.new", {});
    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining("Start a new chat")
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
