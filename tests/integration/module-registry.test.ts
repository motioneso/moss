import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { downloadExternalModuleRouteSchema } from "@moss/shared";
import type { QueueDefinition } from "@moss/jobs";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  assertModuleRegistryConsistency,
  getBuiltInModuleRegistrations,
  getExternalModuleDeletionTables,
  type BuiltInModuleRegistration
} from "@moss/module-registry";

function manifest(overrides: Partial<MossModuleManifest>): MossModuleManifest {
  return {
    id: "fixture",
    name: "Fixture",
    version: "0.0.0",
    publisher: "test",
    lifecycle: "required",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true },
    ...overrides
  };
}

function registration(
  manifestOverrides: Partial<MossModuleManifest>,
  queueDefinitions: readonly QueueDefinition[] = []
): BuiltInModuleRegistration {
  return {
    manifest: manifest(manifestOverrides),
    sqlMigrationDirectories: [],
    queueDefinitions
  };
}

describe("assertModuleRegistryConsistency", () => {
  it("accepts every built-in module registration", () => {
    expect(() => assertModuleRegistryConsistency(getBuiltInModuleRegistrations())).not.toThrow();
  });

  it("rejects duplicate module ids", () => {
    expect(() =>
      assertModuleRegistryConsistency([
        registration({ id: "tasks", name: "Tasks" }),
        registration({ id: "tasks", name: "Tasks Copy" })
      ])
    ).toThrow(/duplicate module id "tasks"/i);
  });

  it("rejects duplicate queue names, including foundation queue names", () => {
    expect(() =>
      assertModuleRegistryConsistency([
        registration({ id: "probe-owner" }, [{ name: "rls-probe" }])
      ])
    ).toThrow(/duplicate queue name "rls-probe"/i);

    expect(() =>
      assertModuleRegistryConsistency([
        registration({ id: "one" }, [{ name: "module.shared" }]),
        registration({ id: "two" }, [{ name: "module.shared" }])
      ])
    ).toThrow(/duplicate queue name "module.shared"/i);
  });

  it("rejects duplicate route method and path pairs", () => {
    expect(() =>
      assertModuleRegistryConsistency([
        registration({
          id: "one",
          routes: [{ method: "GET", path: "/api/collide" }]
        }),
        registration({
          id: "two",
          routes: [{ method: "GET", path: "/api/collide" }]
        })
      ])
    ).toThrow(/duplicate route "GET \/api\/collide"/i);
  });

  it("rejects duplicate owned tables", () => {
    // Both fixtures declare a satisfying dataLifecycle so the #801 parity check (below) does
    // not preempt this duplicate-table assertion — the first module in registration order
    // would otherwise fail that check first (it also has an owned table).
    const satisfyingLifecycle = {
      exportSections: [],
      deletion: { strategy: "cascade" as const, tables: [{ table: "app.shared" }] }
    };
    expect(() =>
      assertModuleRegistryConsistency([
        registration({
          id: "one",
          database: { migrations: [], ownedTables: ["app.shared"] },
          dataLifecycle: satisfyingLifecycle
        }),
        registration({
          id: "two",
          database: { migrations: [], ownedTables: ["app.shared"] },
          dataLifecycle: satisfyingLifecycle
        })
      ])
    ).toThrow(/duplicate owned table "app.shared"/i);
  });

  // #801 Phase A: dataLifecycle parity assertion.
  describe("dataLifecycle parity (#801 Phase A)", () => {
    it("RED: rejects a module with owned tables, no dataLifecycle, not on the allowlist", () => {
      expect(() =>
        assertModuleRegistryConsistency([
          registration({
            id: "unmigrated-fixture",
            database: { migrations: [], ownedTables: ["app.unmigrated_fixture"] }
          })
        ])
      ).toThrow(
        /module "unmigrated-fixture" has owned tables but declares no datalifecycle.*not.*lifecycle_migration_pending allowlist/i
      );
    });

    it("GREEN: accepts the same shape when the module id is on the allowlist", () => {
      // "tasks" is a real LIFECYCLE_MIGRATION_PENDING entry (Phase B, not yet migrated) —
      // reusing it here (rather than a synthetic id) proves the allowlist itself, not just
      // the membership-check mechanics.
      expect(() =>
        assertModuleRegistryConsistency([
          registration({
            id: "tasks",
            database: { migrations: [], ownedTables: ["app.tasks_fixture"] }
          })
        ])
      ).not.toThrow();
    });

    it("rejects a dataLifecycle declaration that omits exportSections on a module with owned tables", () => {
      expect(() =>
        assertModuleRegistryConsistency([
          registration({
            id: "no-export-sections-fixture",
            database: { migrations: [], ownedTables: ["app.fixture_table"] },
            dataLifecycle: {
              deletion: { strategy: "cascade", tables: [{ table: "app.fixture_table" }] }
            }
          })
        ])
      ).toThrow(/declares datalifecycle with owned tables but omits exportsections/i);
    });

    it("RED: rejects cascade deletion.tables missing an owned table (parity check)", () => {
      expect(() =>
        assertModuleRegistryConsistency([
          registration({
            id: "partial-deletion-fixture",
            database: {
              migrations: [],
              ownedTables: ["app.fixture_a", "app.fixture_b"]
            },
            dataLifecycle: {
              exportSections: [],
              deletion: { strategy: "cascade", tables: [{ table: "app.fixture_a" }] }
            }
          })
        ])
      ).toThrow(/dataLifecycle.deletion.tables is missing owned table\(s\): app.fixture_b/);
    });

    it("GREEN: accepts a fully-declared dataLifecycle covering every owned table", () => {
      expect(() =>
        assertModuleRegistryConsistency([
          registration({
            id: "fully-migrated-fixture",
            database: {
              migrations: [],
              ownedTables: ["app.fixture_a", "app.fixture_b"]
            },
            dataLifecycle: {
              exportSections: [],
              deletion: {
                strategy: "cascade",
                tables: [{ table: "app.fixture_a" }, { table: "app.fixture_b" }]
              }
            }
          })
        ])
      ).not.toThrow();
    });
  });
});

describe("getExternalModuleDeletionTables (#914)", () => {
  it("resolves owned tables from an installed external module's manifest, same shape as built-ins", () => {
    const externalManifest = manifest({
      id: "acme-widgets",
      database: { migrations: [], ownedTables: ["app.acme_widgets"] },
      dataLifecycle: {
        exportSections: [],
        deletion: {
          strategy: "cascade",
          tables: [{ table: "app.acme_widgets", countPredicate: "owner_user_id = $1::uuid" }]
        }
      }
    });

    expect(getExternalModuleDeletionTables([externalManifest])).toEqual([
      { table: "app.acme_widgets", countPredicate: "owner_user_id = $1::uuid" }
    ]);
  });

  it("applies the default count predicate when a table omits one", () => {
    const externalManifest = manifest({
      id: "acme-widgets",
      database: { migrations: [], ownedTables: ["app.acme_widgets"] },
      dataLifecycle: {
        exportSections: [],
        deletion: { strategy: "cascade", tables: [{ table: "app.acme_widgets" }] }
      }
    });

    expect(getExternalModuleDeletionTables([externalManifest])).toEqual([
      { table: "app.acme_widgets", countPredicate: "owner_user_id = $1::uuid" }
    ]);
  });

  it("derives coverage from ownedTables alone — no dataLifecycle declaration required (spec D6: external modules carry no module code)", () => {
    const externalManifest = manifest({
      id: "acme-widgets",
      database: { migrations: [], ownedTables: ["app.acme_widgets", "app.acme_gadgets"] }
    });

    expect(getExternalModuleDeletionTables([externalManifest])).toEqual([
      { table: "app.acme_widgets", countPredicate: "owner_user_id = $1::uuid" },
      { table: "app.acme_gadgets", countPredicate: "owner_user_id = $1::uuid" }
    ]);
  });
});

// #1319 phase 3: the blocked-install refusal travels over the wire intact.
// Fastify serialises every response through fast-json-stringify against the route's
// response schema, and that serialiser SILENTLY DROPS any property the schema does not
// declare. The catalog digest is the whole point of this 409 — without it the screen has
// nothing to offer the admin to accept — so it gets its own wire-level test rather than
// relying on the handler's return value.
describe("download refusal response schema (#1319)", () => {
  async function refusalServer(
    body: Record<string, unknown>
  ): Promise<{ statusCode: number; json: Record<string, unknown> }> {
    const app = Fastify();
    app.post(
      "/api/admin/external-modules/:id/download",
      { schema: downloadExternalModuleRouteSchema },
      async (_request, reply) => reply.code(409).send(body)
    );
    try {
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/external-modules/acme-widgets/download",
        headers: { "content-type": "application/json" },
        payload: {}
      });
      return { statusCode: res.statusCode, json: res.json() };
    } finally {
      await app.close();
    }
  }

  it("keeps the failure code and the catalog digest on the unverified-catalog 409", async () => {
    const digest = "b".repeat(64);
    const res = await refusalServer({
      error:
        "Moss could not confirm this module list came from us, so it will not install from it.",
      code: "index-unverified",
      catalogDigestSha256: digest
    });
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({
      error:
        "Moss could not confirm this module list came from us, so it will not install from it.",
      code: "index-unverified",
      catalogDigestSha256: digest
    });
  });

  it("still serialises the message-only 409s (distribution disabled, purge pending)", async () => {
    for (const message of [
      "External modules are not enabled on this instance",
      "A data purge is pending for this module — cancel it first"
    ]) {
      const res = await refusalServer({ error: message });
      expect(res.statusCode).toBe(409);
      // Exactly the message — the optional catalog fields must not be invented for a
      // refusal that has no catalog behind it.
      expect(res.json).toEqual({ error: message });
    }
  });
});
