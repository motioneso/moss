import { describe, expect, it, vi } from "vitest";
import type { AssistantToolGateway } from "@moss/ai";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";

const seams = vi.hoisted(() => ({ registerAiRoutes: vi.fn() }));
vi.mock("@moss/ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerAiRoutes: seams.registerAiRoutes
}));

import { getBuiltInModuleRegistrations } from "../../packages/module-registry/src/index.js";

function register(
  input: {
    getActionRequestPresentationFn?: () =>
      | AssistantToolGateway["getActionRequestPresentation"]
      | undefined;
    getRecoverActionRequestsFn?: () => ((actorUserId: string) => Promise<void>) | undefined;
  } = {}
): AiRoutesDependencies {
  const registration = getBuiltInModuleRegistrations().find((entry) => entry.manifest.id === "ai")!;
  registration.registerRoutes!({} as never, {
    rootDb: {} as never,
    boss: {} as never,
    mcpServerUrl: "http://localhost/api/mcp",
    dataContext: {} as never,
    resolveAccessContext: async () => ({ actorUserId: "user-a" }),
    listConfiguredAuthProviders: () => [],
    listModuleManifests: () => [],
    resolveActiveModules: async () => [],
    ...input
  });
  return seams.registerAiRoutes.mock.calls.at(-1)![1] as AiRoutesDependencies;
}

describe("assistant action hydration composition", () => {
  it("fails closed until the local chat gateway is adopted", async () => {
    const dependencies = register();

    expect(dependencies.getActionRequestPresentation?.("owner-a", "request-a")).toBeUndefined();
    await expect(dependencies.recoverActionRequests?.("user-a")).resolves.toBeUndefined();
  });

  it("reads live per-server callbacks at call time without crossing server bindings", async () => {
    const live: {
      presentation?: AssistantToolGateway["getActionRequestPresentation"];
      recover?: (actorUserId: string) => Promise<void>;
    } = {};
    const disclosure = {
      kind: "action_request" as const,
      actionRequestId: "request-a",
      toolName: "notes.write_note",
      summary: "Save note",
      outsideContentNotice: false
    };
    const first = register({
      getActionRequestPresentationFn: () => live.presentation,
      getRecoverActionRequestsFn: () => live.recover
    });
    const otherRecover = vi.fn(async () => {});
    const second = register({
      getActionRequestPresentationFn: () => (owner, id) =>
        owner === "owner-b" && id === "request-b" ? disclosure : undefined,
      getRecoverActionRequestsFn: () => otherRecover
    });

    expect(first.getActionRequestPresentation?.("owner-a", "request-a")).toBeUndefined();
    live.presentation = (owner, id) =>
      owner === "owner-a" && id === "request-a" ? disclosure : undefined;
    const firstRecover = vi.fn(async () => {});
    live.recover = firstRecover;

    expect(first.getActionRequestPresentation?.("owner-a", "request-a")).toEqual(disclosure);
    expect(first.getActionRequestPresentation?.("owner-b", "request-b")).toBeUndefined();
    expect(second.getActionRequestPresentation?.("owner-a", "request-a")).toBeUndefined();
    expect(second.getActionRequestPresentation?.("owner-b", "request-b")).toEqual(disclosure);
    await first.recoverActionRequests?.("owner-a");
    expect(firstRecover).toHaveBeenCalledExactlyOnceWith("owner-a");
    expect(otherRecover).not.toHaveBeenCalled();
    await second.recoverActionRequests?.("owner-b");
    expect(otherRecover).toHaveBeenCalledExactlyOnceWith("owner-b");
  });
});
