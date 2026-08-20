// #1725: the two endpoints behind an installed module's settings page.
//
// The interesting behaviour is all refusal: a module may only write preferences its own
// manifest declares, only of the declared type and within the declared bounds (#1757), and
// only for modules the actor actually has installed.
// The fake database below is deliberately thin — these tests are about the route's
// decisions, and the storage layer's own behaviour is covered where it lives.
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import type { DataContextRunner } from "@moss/db";
import type { ReconciledExternalModule } from "@moss/module-registry";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { registerModulePreferenceRoutes } from "../../apps/api/src/module-preferences.js";

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type AnyFn = Function;

const access: AccessContext = { actorUserId: "11111111-1111-1111-1111-111111111111" };

function fakeModule(): ReconciledExternalModule {
  return {
    id: "food",
    preferences: [
      { key: "aiEstimates", label: "AI estimates", type: "boolean", default: true },
      { key: "weeklyDigest", label: "Weekly digest", type: "boolean", default: false }
    ]
  } as unknown as ReconciledExternalModule;
}

// Stands in for the one data context the route opens. `storedRows` is what a read sees;
// `writtenKeys` records what a write attempted, which is the only thing the route is
// responsible for getting right.
function fakeRunner(
  storedRows: ReadonlyArray<{ key: string; value_json: unknown }>,
  writtenKeys: string[]
): DataContextRunner {
  const db = {
    selectFrom: () => ({ select: () => ({ execute: async () => storedRows }) }),
    insertInto: () => ({
      values: (row: Record<string, unknown>) => {
        writtenKeys.push(String(row.key));
        return { onConflict: () => ({ execute: async () => undefined }) };
      }
    })
  };
  const scopedDb = { db, [dataContextBrand]: true } as unknown as DataContextDb;
  return {
    withDataContext: async (_ctx: AccessContext, work: (db: DataContextDb) => unknown) =>
      work(scopedDb)
  } as unknown as DataContextRunner;
}

function register(options: {
  readonly modules: readonly ReconciledExternalModule[];
  readonly storedRows?: ReadonlyArray<{ key: string; value_json: unknown }>;
  readonly writtenKeys?: string[];
}) {
  let getHandler: unknown;
  let patchHandler: unknown;
  const server = {
    get: vi.fn((_path: string, handler: unknown) => {
      getHandler = handler;
    }),
    patch: vi.fn((_path: string, _opts: unknown, handler: unknown) => {
      patchHandler = handler;
    })
  };

  registerModulePreferenceRoutes(server as unknown as FastifyInstance, {
    resolveAccessContext: async () => access,
    getActiveExternalModules: async () => options.modules,
    runner: fakeRunner(options.storedRows ?? [], options.writtenKeys ?? [])
  });

  return { getHandler, patchHandler };
}

function fakeReply() {
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn(() => reply)
  };
  return reply as unknown as FastifyReply & { code: ReturnType<typeof vi.fn> };
}

describe("module preference routes (#1725)", () => {
  it("resolves an unwritten switch to the manifest default", async () => {
    const { getHandler } = register({ modules: [fakeModule()] });
    const reply = fakeReply();

    const result = (await (getHandler as AnyFn)(
      { params: { moduleId: "food" } } as unknown as FastifyRequest,
      reply
    )) as { preferences: ReadonlyArray<{ key: string; value: boolean }> };

    // Nothing is written at install, so an absent row must read as the manifest's default
    // rather than as "off" — otherwise every module ships switched off on day one.
    expect(result.preferences).toEqual([
      expect.objectContaining({ key: "aiEstimates", value: true, default: true }),
      expect.objectContaining({ key: "weeklyDigest", value: false, default: false })
    ]);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns a stored switch in preference to the default", async () => {
    const { getHandler } = register({
      modules: [fakeModule()],
      storedRows: [{ key: "module:food:aiEstimates", value_json: false }]
    });

    const result = (await (getHandler as AnyFn)(
      { params: { moduleId: "food" } } as unknown as FastifyRequest,
      fakeReply()
    )) as { preferences: ReadonlyArray<{ key: string; value: boolean }> };

    expect(result.preferences[0]).toMatchObject({ key: "aiEstimates", value: false });
  });

  it("answers 404, not 403, for a module the actor has not installed", async () => {
    // Same answer for "no such module" and "not installed for you": /api/modules stays the
    // only endpoint that discloses which modules exist.
    const { getHandler, patchHandler } = register({ modules: [] });

    const getReply = fakeReply();
    await (getHandler as AnyFn)(
      { params: { moduleId: "food" } } as unknown as FastifyRequest,
      getReply
    );
    expect(getReply.code).toHaveBeenCalledWith(404);

    const patchReply = fakeReply();
    await (patchHandler as AnyFn)(
      { params: { moduleId: "food" }, body: { aiEstimates: false } } as unknown as FastifyRequest,
      patchReply
    );
    expect(patchReply.code).toHaveBeenCalledWith(404);
  });

  it("rejects a key the manifest does not declare", async () => {
    const writtenKeys: string[] = [];
    const { patchHandler } = register({ modules: [fakeModule()], writtenKeys });
    const reply = fakeReply();

    await (patchHandler as AnyFn)(
      { params: { moduleId: "food" }, body: { notDeclared: true } } as unknown as FastifyRequest,
      reply
    );

    // A 400 rather than a silent drop: a module update that removes a switch has to surface
    // in the settings pane, not look like a save that worked and did nothing.
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(writtenKeys).toEqual([]);
  });

  it("rejects a non-boolean value", async () => {
    const writtenKeys: string[] = [];
    const { patchHandler } = register({ modules: [fakeModule()], writtenKeys });
    const reply = fakeReply();

    await (patchHandler as AnyFn)(
      { params: { moduleId: "food" }, body: { aiEstimates: "yes" } } as unknown as FastifyRequest,
      reply
    );

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(writtenKeys).toEqual([]);
  });

  it("rejects an empty or non-object body", async () => {
    const { patchHandler } = register({ modules: [fakeModule()] });

    for (const body of [{}, [], null, "aiEstimates"]) {
      const reply = fakeReply();
      await (patchHandler as AnyFn)(
        { params: { moduleId: "food" }, body } as unknown as FastifyRequest,
        reply
      );
      expect(reply.code).toHaveBeenCalledWith(400);
    }
  });

  it("writes a declared switch under the module's own key namespace", async () => {
    const writtenKeys: string[] = [];
    const { patchHandler } = register({ modules: [fakeModule()], writtenKeys });
    const reply = fakeReply();

    await (patchHandler as AnyFn)(
      {
        params: { moduleId: "food" },
        body: { aiEstimates: false, weeklyDigest: true }
      } as unknown as FastifyRequest,
      reply
    );

    // Namespaced, so two modules declaring the same switch name cannot collide.
    expect(writtenKeys).toEqual(["module:food:aiEstimates", "module:food:weeklyDigest"]);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("rejects the whole batch if any one key is invalid", async () => {
    const writtenKeys: string[] = [];
    const { patchHandler } = register({ modules: [fakeModule()], writtenKeys });
    const reply = fakeReply();

    await (patchHandler as AnyFn)(
      {
        params: { moduleId: "food" },
        body: { aiEstimates: false, notDeclared: true }
      } as unknown as FastifyRequest,
      reply
    );

    // All-or-nothing: a half-applied save would leave the pane showing state the user never
    // chose, with no error to explain it.
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(writtenKeys).toEqual([]);
  });
});

// #1757: the same two endpoints, now carrying numbers. Bounds live in the manifest, so the
// browser control and the API check them independently — a request that skipped the UI entirely
// must still be refused.
describe("module preference routes, numbers (#1757)", () => {
  const numericModule = (): ReconciledExternalModule =>
    ({
      id: "food",
      preferences: [
        { key: "aiEstimates", label: "AI estimates", type: "boolean", default: true },
        {
          key: "calorieTarget",
          label: "Daily calorie target",
          type: "integer",
          min: 500,
          max: 10000,
          default: null
        },
        { key: "servings", label: "Default servings", type: "integer", min: 1, default: 1 }
      ]
    }) as unknown as ReconciledExternalModule;

  it("carries the declared bounds to the browser and resolves an unset target to null", async () => {
    const { getHandler } = register({ modules: [numericModule()] });

    const result = (await (getHandler as AnyFn)(
      { params: { moduleId: "food" } } as unknown as FastifyRequest,
      fakeReply()
    )) as { preferences: ReadonlyArray<Record<string, unknown>> };

    // The browser cannot read the manifest, so a dropped bound means a field with no limits.
    expect(result.preferences[1]).toMatchObject({
      key: "calorieTarget",
      type: "integer",
      min: 500,
      max: 10000,
      value: null
    });
    // A switch has no bounds, and null rather than an omitted field keeps the shape uniform.
    expect(result.preferences[0]).toMatchObject({ min: null, max: null });
  });

  it("keeps a stored null instead of falling back to the default", async () => {
    const { getHandler } = register({
      modules: [numericModule()],
      storedRows: [{ key: "module:food:servings", value_json: null }]
    });

    const result = (await (getHandler as AnyFn)(
      { params: { moduleId: "food" } } as unknown as FastifyRequest,
      fakeReply()
    )) as { preferences: ReadonlyArray<Record<string, unknown>> };

    // Null here is the user having cleared the field, not an absent row. Coalescing it back to
    // the default would silently restore a target they deliberately removed.
    expect(result.preferences[2]).toMatchObject({ key: "servings", value: null, default: 1 });
  });

  it("writes a number inside the declared bounds", async () => {
    const writtenKeys: string[] = [];
    const { patchHandler } = register({ modules: [numericModule()], writtenKeys });
    const reply = fakeReply();

    await (patchHandler as AnyFn)(
      {
        params: { moduleId: "food" },
        body: { calorieTarget: 2200 }
      } as unknown as FastifyRequest,
      reply
    );

    expect(writtenKeys).toEqual(["module:food:calorieTarget"]);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("refuses a number outside the bounds, or one that is not whole", async () => {
    for (const value of [499, 10001, 1500.5, "2000", true]) {
      const writtenKeys: string[] = [];
      const { patchHandler } = register({ modules: [numericModule()], writtenKeys });
      const reply = fakeReply();

      await (patchHandler as AnyFn)(
        {
          params: { moduleId: "food" },
          body: { calorieTarget: value }
        } as unknown as FastifyRequest,
        reply
      );

      expect(reply.code, `calorieTarget ${JSON.stringify(value)}`).toHaveBeenCalledWith(400);
      expect(writtenKeys).toEqual([]);
    }
  });

  it("accepts null only where the manifest declared unset as an end state", async () => {
    const clearable: string[] = [];
    const clear = register({ modules: [numericModule()], writtenKeys: clearable });
    const clearReply = fakeReply();
    await (clear.patchHandler as AnyFn)(
      { params: { moduleId: "food" }, body: { calorieTarget: null } } as unknown as FastifyRequest,
      clearReply
    );
    expect(clearable).toEqual(["module:food:calorieTarget"]);
    expect(clearReply.code).not.toHaveBeenCalled();

    // `servings` defaults to 1, which declares that it always holds a number. Clearing it would
    // leave the module reading a target it was told it would never see.
    const written: string[] = [];
    const keep = register({ modules: [numericModule()], writtenKeys: written });
    const keepReply = fakeReply();
    await (keep.patchHandler as AnyFn)(
      { params: { moduleId: "food" }, body: { servings: null } } as unknown as FastifyRequest,
      keepReply
    );
    expect(keepReply.code).toHaveBeenCalledWith(400);
    expect(written).toEqual([]);
  });

  it("refuses a boolean sent to a number and a number sent to a switch", async () => {
    for (const body of [{ calorieTarget: true }, { aiEstimates: 2000 }]) {
      const writtenKeys: string[] = [];
      const { patchHandler } = register({ modules: [numericModule()], writtenKeys });
      const reply = fakeReply();

      await (patchHandler as AnyFn)(
        { params: { moduleId: "food" }, body } as unknown as FastifyRequest,
        reply
      );

      expect(reply.code, JSON.stringify(body)).toHaveBeenCalledWith(400);
      expect(writtenKeys).toEqual([]);
    }
  });
});
