// #1890, QA round 1 gap 3: the "external modules are switched off on this instance" branch of
// the throw-a-draft-away route. The real composition root hardcodes `enabled: true`
// (apps/api/src/server.ts), so this branch can never fire in the integration suite — the only
// way to pin it is to register the module routes on a bare Fastify instance with a composition
// that has no external-module support wired.
//
// Two things are pinned here, and both matter:
//   1. feature off => 409, and the delete is never attempted;
//   2. admin authorization still runs FIRST, so a non-admin gets 403 rather than the 409 —
//      otherwise the feature-off answer would leak instance configuration to any signed-in user.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import { registerModuleRoutes } from "../../packages/settings/src/routes-modules.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";

interface Options {
  readonly isAdmin: boolean;
}

function buildServer(options: Options) {
  const deleteAttempts: string[] = [];
  const server = Fastify({ logger: false });

  // A scoped-database stand-in that records any attempt to reach the database at all. If the
  // 409 ever moved after the delete, this would catch it.
  const scopedDb = {
    db: {
      deleteFrom: (table: string) => {
        deleteAttempts.push(table);
        throw new Error("the delete must never be reached when the feature is off");
      }
    },
    [dataContextBrand]: true
  } as unknown as DataContextDb;

  registerModuleRoutes(server, {
    dependencies: {
      resolveAccessContext: async (): Promise<AccessContext> => ({
        actorUserId: ACTOR,
        requestId: "req-1"
      }),
      dataContext: {
        withDataContext: async <T>(
          _accessContext: AccessContext,
          work: (db: DataContextDb) => Promise<T>
        ) => work(scopedDb)
      },
      listModuleManifests: () => [],
      // No `externalModules` key at all: this composition has no external-module support.
      moduleDistribution: undefined
    } as never,
    repository: {
      externalModuleAuditWriter: () => async () => {}
    } as never,
    assertAdminUser: async () => {
      if (!options.isAdmin) throw new HttpError(403, "Admin access required");
      return {} as never;
    },
    requireRequestId: () => "req-1"
  });

  return { server, deleteAttempts };
}

describe("throwing a draft away when external modules are switched off (#1890)", () => {
  it("answers 409 and never attempts the delete", async () => {
    const { server, deleteAttempts } = buildServer({ isAdmin: true });
    await server.ready();

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/some-draft/draft"
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not enabled on this instance");
    expect(deleteAttempts).toEqual([]);
    await server.close();
  });

  it("still answers 403 to a non-admin, so the feature-off state is not leaked", async () => {
    const { server, deleteAttempts } = buildServer({ isAdmin: false });
    await server.ready();

    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/some-draft/draft"
    });

    expect(res.statusCode).toBe(403);
    expect(deleteAttempts).toEqual([]);
    await server.close();
  });
});
