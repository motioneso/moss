// #1725: the two endpoints behind an installed module's settings page.
//
// The interesting behaviour is all refusal: a module may only write switches its own
// manifest declares, only booleans, and only for modules the actor actually has installed.
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
