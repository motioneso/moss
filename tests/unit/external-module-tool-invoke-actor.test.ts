// #3723 T11: a page call reaches the real external tool binding, and the worker sees the session
// user even when the page sends its own actor id in the input, plus that user's saved zone.
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it, vi } from "vitest";

import type * as ModuleRegistryNodeModule from "@moss/module-registry/node";

const invoke = vi.fn(async (..._args: unknown[]) => ({ data: { ok: true } }));

vi.mock("@moss/settings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readActorLocale: async () => ({ timezone: "Pacific/Auckland" })
}));

vi.mock("@moss/module-registry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof ModuleRegistryNodeModule>();
  return {
    ...actual,
    ExternalModuleWorkerRuntime: class {
      invoke = invoke;
    },
    createExternalModuleRpcHandler: () => ({})
  };
});

const { createExternalModuleTools } = await import("../../apps/api/src/external-module-tools.js");
const { registerModuleToolInvokeRoute } =
  await import("../../apps/api/src/external-module-tool-invoke.js");

const ORIGIN = "http://moss.test";

const discovery = {
  id: "meals",
  dir: "/modules/meals",
  manifest: {
    schemaVersion: 1,
    id: "meals",
    name: "Meals",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    assistantTools: [
      {
        name: "meals.tickLine",
        permissionId: "meals.write",
        description: "Tick a shopping line.",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: { lineId: { type: "string" }, actorUserId: { type: "string" } },
          required: ["lineId"]
        },
        handler: "meals.tickLine"
      }
    ]
  },
  manifestHash: "sha256:meals",
  packageHash: "sha256:meals"
} as never;

const noopRunner = {
  withDataContext: async <T>(_access: unknown, fn: (db: unknown) => Promise<T> | T): Promise<T> =>
    fn({} as never)
} as never;

describe("module page calls reach the worker as the session user", () => {
  it("overrides an actor id the page put in the input", async () => {
    const { getManifests } = createExternalModuleTools({
      discoveries: () => [discovery],
      workerDataContext: noopRunner,
      appDataContext: noopRunner,
      settingsRepository: { getUserById: async () => null, listUsers: async () => [] } as never,
      logger: { warn: () => undefined }
    });
    const server = Fastify();
    await server.register(rateLimit, { global: false });
    registerModuleToolInvokeRoute(server, {
      auth: {
        resolveAccessContext: async () => ({ actorUserId: "session-user", requestId: "req-1" }),
        trustedOrigins: [ORIGIN]
      },
      resolveActiveModules: async () => getManifests(),
      dataContext: noopRunner,
      recordActivity: async () => undefined
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/modules/meals/tools/meals.tickLine/invoke",
      headers: { origin: ORIGIN },
      payload: { input: { lineId: "line-1", actorUserId: "someone-else" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ invocation: { status: "succeeded", result: { ok: true } } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[2]).toEqual({ lineId: "line-1", actorUserId: "session-user" });
    expect(invoke.mock.calls[0]?.[4]).toMatchObject({ localTimezone: "Pacific/Auckland" });
    await server.close();
  });
});
