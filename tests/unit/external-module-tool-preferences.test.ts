// Regression test for the synchronous assistant-tool path dropping module preferences.
//
// The queued path (apps/worker/src/external-module-invoke.ts) has always resolved the actor's
// preferences and handed them to the runtime. The API's assistant-tool path did not, so a module
// invoked through a tool saw an empty preference set and fell back to its manifest defaults —
// every switch and number the user saved in Settings was silently ignored on that path. Found on
// a live instance: turning Food's AI estimates off and setting a calorie target changed nothing
// the Food page rendered.
//
// The assertion is deliberately about the ARGUMENT, not about any module's behaviour: the defect
// was a missing argument, and a test that stubbed a module's reaction would pass against a
// hardcoded default.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveModulePreferences = vi.fn(async () => ({ aiEstimates: false, calorieTarget: 2200 }));

vi.mock("@moss/module-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moss/module-registry")>();
  return { ...actual, resolveModulePreferences };
});

const invoke = vi.fn(async () => ({ data: { ok: true } }));

vi.mock("@moss/module-registry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moss/module-registry/node")>();
  return {
    ...actual,
    ExternalModuleWorkerRuntime: class {
      invoke = invoke;
    },
    createExternalModuleRpcHandler: () => ({})
  };
});

const { createExternalModuleTools } = await import("../../apps/api/src/external-module-tools.js");

const discovery = {
  id: "demo",
  dir: "/modules/demo",
  manifest: {
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    preferences: [
      { key: "aiEstimates", label: "AI estimates", type: "boolean", default: true },
      { key: "calorieTarget", label: "Calories", type: "integer", min: 500, max: 10000, default: null }
    ],
    assistantTools: [
      {
        name: "demo.read",
        permissionId: "demo.read",
        description: "Read demo records.",
        risk: "read",
        inputSchema: { type: "object" },
        handler: "demo.read"
      }
    ]
  },
  manifestHash: "sha256:demo",
  packageHash: "sha256:demo"
} as never;

const noopRunner = {
  withDataContext: async <T>(_access: unknown, fn: (db: unknown) => Promise<T> | T): Promise<T> =>
    fn({} as never)
} as never;

describe("assistant-tool invocations carry the actor's module preferences", () => {
  beforeEach(() => {
    invoke.mockClear();
    resolveModulePreferences.mockClear();
  });

  it("passes the resolved preferences through to the module runtime", async () => {
    const { manifests } = createExternalModuleTools({
      discoveries: [discovery],
      workerDataContext: noopRunner,
      appDataContext: noopRunner,
      settingsRepository: { getUserById: async () => null } as never,
      logger: { warn: () => undefined }
    });

    const tool = manifests[0]?.assistantTools?.[0];
    expect(tool).toBeDefined();
    await tool!.execute({} as never, { localDate: "2026-08-20" }, {
      actorUserId: "user-1",
      requestId: "req-1"
    } as never);

    expect(resolveModulePreferences).toHaveBeenCalledTimes(1);
    const options = invoke.mock.calls[0]?.[4] as { preferences?: unknown } | undefined;
    expect(options?.preferences).toEqual({ aiEstimates: false, calorieTarget: 2200 });
  });
});
