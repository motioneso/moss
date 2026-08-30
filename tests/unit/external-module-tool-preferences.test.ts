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

import type * as ModuleRegistryModule from "@moss/module-registry";
import type * as ModuleRegistryNodeModule from "@moss/module-registry/node";

const resolveModulePreferences = vi.fn(async () => ({ aiEstimates: false, calorieTarget: 2200 }));

vi.mock("@moss/module-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof ModuleRegistryModule>();
  return { ...actual, resolveModulePreferences };
});

// Typed with a rest parameter rather than no parameters: the assertion below reads the fifth
// argument out of `invoke.mock.calls`, and a zero-argument mock gives that array an empty tuple
// type, so indexing it is a compile error even though the call really does carry the argument.
const invoke = vi.fn(async (..._args: unknown[]) => ({ data: { ok: true } }));

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
      {
        key: "calorieTarget",
        label: "Calories",
        type: "integer",
        min: 500,
        max: 10000,
        default: null
      }
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
    const { getManifests } = createExternalModuleTools({
      discoveries: () => [discovery],
      workerDataContext: noopRunner,
      appDataContext: noopRunner,
      settingsRepository: { getUserById: async () => null } as never,
      logger: { warn: () => undefined }
    });

    const execute = getManifests()[0]?.assistantTools?.[0]?.execute;
    expect(execute).toBeDefined();
    await execute!({} as never, { localDate: "2026-08-20" }, {
      actorUserId: "user-1",
      requestId: "req-1"
    } as never);

    expect(resolveModulePreferences).toHaveBeenCalledTimes(1);
    const options = invoke.mock.calls[0]?.[4] as { preferences?: unknown } | undefined;
    expect(options?.preferences).toEqual({ aiEstimates: false, calorieTarget: 2200 });
  });

  // #1789: the same class of defect as the preferences one above, and asserted the same way —
  // about the ARGUMENT, not about a module's reaction to it. The host resolves the actor's
  // timezone onto ToolContext for every tool call, but nothing carried it across the module
  // worker boundary, so a module filing anything under a calendar day had to trust whatever
  // zone the model wrote into the tool input, and fell back to UTC when it wrote none.
  it("passes the actor's timezone through to the module runtime", async () => {
    const { getManifests } = createExternalModuleTools({
      discoveries: () => [discovery],
      workerDataContext: noopRunner,
      appDataContext: noopRunner,
      settingsRepository: { getUserById: async () => null } as never,
      logger: { warn: () => undefined }
    });

    await getManifests()[0]!.assistantTools![0]!.execute!({} as never, {}, {
      actorUserId: "user-1",
      requestId: "req-1",
      localTimezone: "America/Chicago"
    } as never);

    const options = invoke.mock.calls[0]?.[4] as { localTimezone?: unknown } | undefined;
    expect(options?.localTimezone).toBe("America/Chicago");
  });

  it("omits the timezone rather than inventing one when the host has no locale", async () => {
    const { getManifests } = createExternalModuleTools({
      discoveries: () => [discovery],
      workerDataContext: noopRunner,
      appDataContext: noopRunner,
      settingsRepository: { getUserById: async () => null } as never,
      logger: { warn: () => undefined }
    });

    await getManifests()[0]!.assistantTools![0]!.execute!({} as never, {}, {
      actorUserId: "user-1",
      requestId: "req-1"
    } as never);

    // Absent, not "UTC". A module has to be able to tell "the host does not know" from "the
    // host says UTC" — the first is a reason to fall back to the model's guess, the second
    // is not.
    const options = invoke.mock.calls[0]?.[4] as Record<string, unknown> | undefined;
    expect(options && "localTimezone" in options).toBe(false);
  });
});
