import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type AccessContext, type MossDatabase } from "@moss/db";
import {
  classifierPreparationView,
  createIntegrationsCipher,
  createResolverCache,
  effectiveClassifierTools,
  INTEGRATION_CLASSIFIER_MAX_ENTRIES,
  IntegrationsRepository,
  registerIntegrationsRoutes,
  toolDefinitionFingerprint,
  type ConnectionRow,
  type ResolverCache
} from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const repository = new IntegrationsRepository();

const TURN_ON: IntegrationToolDescriptor = {
  name: "turn_on",
  description: "Turn a light on",
  group: "lights",
  inputSchema: { type: "object", properties: { name: { type: "string" } } }
};

function context(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `req:classifier-settings:${actorUserId}` };
}

function reviewFor(
  tool: IntegrationToolDescriptor,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    optIn: true,
    reviewedRisk: "write",
    description: "Turn one light on",
    arguments: {},
    replyTemplate: "Turned it on.",
    reviewedFingerprint: toolDefinitionFingerprint(tool),
    ...overrides
  };
}

describe("integrations classifier settings storage, opt-in and invalidation (#2884)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  async function createConnection(
    actorUserId: string,
    name: string,
    tools: readonly IntegrationToolDescriptor[] = [TURN_ON]
  ): Promise<ConnectionRow> {
    return dataContext.withDataContext(context(actorUserId), async (scopedDb) => {
      const created = await repository.createConnection(scopedDb, {
        name,
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: null,
        credentialPlacement: null
      });
      await repository.saveDiscovery(scopedDb, created.id, [...tools], null);
      return (await repository.getConnection(scopedDb, created.id))!;
    });
  }

  function load(actorUserId: string, id: string): Promise<ConnectionRow | null> {
    return dataContext.withDataContext(context(actorUserId), (scopedDb) =>
      repository.getConnection(scopedDb, id)
    );
  }

  it("defaults off and keeps a connection owner-only, administrators included", async () => {
    const conn = await createConnection(ids.userA, "Owner A Default");
    expect(conn.classifierEnabled).toBe(false);
    expect(conn.classifierPreparation.entries).toEqual({});

    expect(await load(ids.userB, conn.id)).toBeNull();
    // An instance admin is a distinct actor, never a bypass.
    expect(await load(ids.adminUser, conn.id)).toBeNull();
  });

  it("saves a reviewed entry, bumps its version, and toggles the connection switch", async () => {
    const conn = await createConnection(ids.userA, "Owner A Round Trip");

    const first = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    expect(first.status).toBe("saved");
    if (first.status !== "saved") return;
    expect(first.connection.classifierPreparation.entries["turn_on"]?.preparationVersion).toBe(1);

    const second = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "read",
        description: "Report light state",
        arguments: {},
        replyTemplate: "It is on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    expect(second.status).toBe("saved");
    if (second.status !== "saved") return;
    expect(second.connection.classifierPreparation.entries["turn_on"]?.preparationVersion).toBe(2);

    const enabled = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { classifierEnabled: true })
    );
    expect(enabled?.classifierEnabled).toBe(true);
    if (!enabled) return;

    const eligible = effectiveClassifierTools(enabled);
    expect(eligible.map((tool) => tool.tool.name)).toEqual(["turn_on"]);
    expect(eligible[0]?.risk).toBe("read");
    expect(enabled.classifierPreparation.entries["turn_on"]?.optIn).toBe(true);
  });

  it("refuses a save whose fingerprint no longer matches the discovered tool", async () => {
    const conn = await createConnection(ids.userA, "Owner A Stale Save");
    const result = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: "sha256:superseded"
      })
    );
    expect(result).toEqual({ status: "conflict", reason: "stale" });

    const after = await load(ids.userA, conn.id);
    expect(after?.classifierPreparation.entries).toEqual({});
  });

  it("refuses a save for a tool that is not discovered", async () => {
    const conn = await createConnection(ids.userA, "Owner A Unknown Tool");
    const result = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "does_not_exist", {
        optIn: true,
        reviewedRisk: "write",
        description: "Nope",
        arguments: {},
        replyTemplate: "Nope.",
        reviewedFingerprint: "sha256:whatever"
      })
    );
    expect(result).toEqual({ status: "conflict", reason: "unknown_tool" });
  });

  it("does not let another owner or an admin write a forged connection id", async () => {
    const conn = await createConnection(ids.userA, "Owner A Forged");
    for (const actor of [ids.userB, ids.adminUser]) {
      const result = await dataContext.withDataContext(context(actor), (scopedDb) =>
        repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
          optIn: true,
          reviewedRisk: "write",
          description: "Injected",
          arguments: {},
          replyTemplate: "Injected.",
          reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
        })
      );
      expect(result).toEqual({ status: "not_found" });
    }
    expect((await load(ids.userA, conn.id))?.classifierPreparation.entries).toEqual({});
  });

  it("marks a saved review stale and drops eligibility when the definition changes", async () => {
    const conn = await createConnection(ids.userA, "Owner A Drift");
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { classifierEnabled: true })
    );

    const drifted = { ...TURN_ON, description: "Turn a light on, now with a warning" };
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveDiscovery(scopedDb, conn.id, [drifted], null)
    );

    const row = (await load(ids.userA, conn.id))!;
    expect(classifierPreparationView(row).map((entry) => entry.state)).toEqual(["stale"]);
    expect(effectiveClassifierTools(row)).toEqual([]);
  });

  it("drops eligibility after a failed discovery even though the old tools remain", async () => {
    const conn = await createConnection(ids.userA, "Owner A Discovery Failure");
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { classifierEnabled: true })
    );
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveDiscovery(scopedDb, conn.id, null, "fetch failed")
    );

    const row = (await load(ids.userA, conn.id))!;
    expect(row.discoveredTools).toHaveLength(1);
    expect(effectiveClassifierTools(row)).toEqual([]);
  });

  it("does not make a tool classifier-eligible while it is switched off for ordinary chat", async () => {
    const conn = await createConnection(ids.userA, "Owner A Chat Off");
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { classifierEnabled: true })
    );
    expect(effectiveClassifierTools((await load(ids.userA, conn.id))!)).toHaveLength(1);

    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { mutedTools: ["turn_on"] })
    );
    expect(effectiveClassifierTools((await load(ids.userA, conn.id))!)).toEqual([]);

    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.updateConnection(scopedDb, conn.id, { mutedTools: [] })
    );
    expect(effectiveClassifierTools((await load(ids.userA, conn.id))!)).toHaveLength(1);
  });

  it("keeps both reviews when two saves start at the same moment", async () => {
    const turnOff: IntegrationToolDescriptor = { ...TURN_ON, name: "turn_off" };
    const conn = await createConnection(ids.userA, "Owner A Concurrent Saves", [TURN_ON, turnOff]);

    // Hold the row so both saves finish their read (and block on their write) before either can
    // commit — the exact window two tabs hit. Without the per-key write, the later save would
    // publish a whole map built from its own stale read and drop the other review.
    const locker = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM app.integration_connections WHERE id = $1 FOR UPDATE", [
        conn.id
      ]);

      const save = (target: IntegrationToolDescriptor) =>
        dataContext.withDataContext(context(ids.userA), (scopedDb) =>
          repository.saveClassifierToolReview(scopedDb, conn.id, target.name, {
            optIn: true,
            reviewedRisk: "write",
            description: "Reviewed",
            arguments: {},
            replyTemplate: "Done.",
            reviewedFingerprint: toolDefinitionFingerprint(target)
          })
        );
      const pending = Promise.all([save(TURN_ON), save(turnOff)]);

      // Let both saves read the map and reach their blocked write before releasing the row.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await locker.query("COMMIT");

      const [first, second] = await pending;
      expect(first.status).toBe("saved");
      expect(second.status).toBe("saved");
    } finally {
      await locker.end();
    }

    const row = (await load(ids.userA, conn.id))!;
    expect(Object.keys(row.classifierPreparation.entries).sort()).toEqual(["turn_off", "turn_on"]);
  });

  async function seedPreparation(id: string, value: unknown): Promise<void> {
    const admin = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await admin.connect();
    try {
      await admin.query(
        "UPDATE app.integration_connections SET classifier_preparation = $2::jsonb WHERE id = $1",
        [id, JSON.stringify(value)]
      );
    } finally {
      await admin.end();
    }
  }

  /** Run `saves` while a bootstrap session holds the row, so every save queues on it first. */
  async function withRowHeld<T>(id: string, saves: () => Promise<T>): Promise<T> {
    const locker = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM app.integration_connections WHERE id = $1 FOR UPDATE", [
        id
      ]);
      const pending = saves();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await locker.query("COMMIT");
      return await pending;
    } finally {
      await locker.end();
    }
  }

  function saveReviewed(id: string, tool: IntegrationToolDescriptor) {
    return dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, id, tool.name, {
        optIn: true,
        reviewedRisk: "write",
        description: "Reviewed",
        arguments: {},
        replyTemplate: "Done.",
        reviewedFingerprint: toolDefinitionFingerprint(tool)
      })
    );
  }

  it.each([
    ["entries is an array", { version: 1, entries: [] }],
    ["entries is a string", { version: 1, entries: "x" }],
    ["the version is unknown", { version: 99, entries: { turn_off: {} } }]
  ])("starts a clean list when %s", async (_label, damaged) => {
    const conn = await createConnection(ids.userA, `Owner A Damaged ${_label}`);
    await seedPreparation(conn.id, damaged);

    const result = await saveReviewed(conn.id, TURN_ON);
    expect(result.status).toBe("saved");

    const row = (await load(ids.userA, conn.id))!;
    expect(Object.keys(row.classifierPreparation.entries)).toEqual(["turn_on"]);
    expect(row.classifierPreparation.entries["turn_on"]?.preparationVersion).toBe(1);
  });

  it("gives two saves of the same tool at the same moment distinct versions", async () => {
    const conn = await createConnection(ids.userA, "Owner A Concurrent Versions");

    const results = await withRowHeld(conn.id, () =>
      Promise.all([saveReviewed(conn.id, TURN_ON), saveReviewed(conn.id, TURN_ON)])
    );

    const versions = results
      .map((result) =>
        result.status === "saved"
          ? result.connection.classifierPreparation.entries["turn_on"]?.preparationVersion
          : undefined
      )
      .sort();
    expect(versions).toEqual([1, 2]);
    const row = (await load(ids.userA, conn.id))!;
    expect(row.classifierPreparation.entries["turn_on"]?.preparationVersion).toBe(2);
  });

  it("holds the saved-review cap when two new reviews land at the same moment", async () => {
    const first: IntegrationToolDescriptor = { ...TURN_ON, name: "cap_first" };
    const second: IntegrationToolDescriptor = { ...TURN_ON, name: "cap_second" };
    const conn = await createConnection(ids.userA, "Owner A Concurrent Cap", [first, second]);

    const filler = {
      optIn: false,
      reviewedRisk: "read",
      description: "Filler",
      arguments: {},
      replyTemplate: "Done.",
      definitionFingerprint: "filler",
      reviewedAt: new Date().toISOString(),
      preparationVersion: 1
    };
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < INTEGRATION_CLASSIFIER_MAX_ENTRIES - 1; i += 1) {
      entries[`filler_${i}`] = filler;
    }
    await seedPreparation(conn.id, { version: 1, entries });

    const results = await withRowHeld(conn.id, () =>
      Promise.all([saveReviewed(conn.id, first), saveReviewed(conn.id, second)])
    );

    expect(results.map((result) => result.status).sort()).toEqual(["saved", "too_many"]);
    const row = (await load(ids.userA, conn.id))!;
    expect(Object.keys(row.classifierPreparation.entries)).toHaveLength(
      INTEGRATION_CLASSIFIER_MAX_ENTRIES
    );
  });

  it("cascades prepared text away when the connection is deleted", async () => {
    const conn = await createConnection(ids.userA, "Owner A Cascade");
    await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.saveClassifierToolReview(scopedDb, conn.id, "turn_on", {
        optIn: true,
        reviewedRisk: "write",
        description: "Turn one light on",
        arguments: {},
        replyTemplate: "Turned it on.",
        reviewedFingerprint: toolDefinitionFingerprint(TURN_ON)
      })
    );
    const deleted = await dataContext.withDataContext(context(ids.userA), (scopedDb) =>
      repository.deleteConnection(scopedDb, conn.id)
    );
    expect(deleted).toBe(true);
    expect(await load(ids.userA, conn.id)).toBeNull();
  });

  describe("routes", () => {
    function buildApp(actorUserId: string, cache: ResolverCache) {
      const app = Fastify();
      registerIntegrationsRoutes(app, {
        resolveAccessContext: async () => context(actorUserId),
        dataContext,
        cipher: createIntegrationsCipher(),
        resolverCache: cache
      });
      return app;
    }

    it("saves, reads, removes a review and drops the resolver cache after each mutation", async () => {
      const cache = createResolverCache();
      const app = buildApp(ids.userA, cache);
      try {
        const conn = await createConnection(ids.userA, "Owner A Routes");
        cache.set(ids.userA, []);
        expect(cache.get(ids.userA)).toEqual([]);

        const saved = await app.inject({
          method: "PUT",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`,
          payload: reviewFor(TURN_ON)
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().classifierPreparation).toHaveLength(1);
        expect(cache.get(ids.userA)).toBeUndefined();

        const detail = await app.inject({ method: "GET", url: `/api/integrations/${conn.id}` });
        expect(detail.json().classifierPreparation[0].state).toBe("current");

        cache.set(ids.userA, []);
        const enabled = await app.inject({
          method: "PATCH",
          url: `/api/integrations/${conn.id}`,
          payload: { classifierEnabled: true }
        });
        expect(enabled.statusCode).toBe(200);
        expect(enabled.json().classifierEnabled).toBe(true);
        expect(cache.get(ids.userA)).toBeUndefined();

        cache.set(ids.userA, []);
        const removed = await app.inject({
          method: "DELETE",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().classifierPreparation).toEqual([]);
        expect(cache.get(ids.userA)).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("returns 409 for a stale save and 400 for a malformed body", async () => {
      const app = buildApp(ids.userA, createResolverCache());
      try {
        const conn = await createConnection(ids.userA, "Owner A Route Errors");
        const stale = await app.inject({
          method: "PUT",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`,
          payload: reviewFor(TURN_ON, { reviewedFingerprint: "sha256:superseded" })
        });
        expect(stale.statusCode).toBe(409);

        const malformed = await app.inject({
          method: "PUT",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`,
          payload: reviewFor(TURN_ON, { reviewedRisk: "harmless" })
        });
        expect(malformed.statusCode).toBe(400);

        const otherOwner = buildApp(ids.userB, createResolverCache());
        const forged = await otherOwner.inject({
          method: "PUT",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`,
          payload: reviewFor(TURN_ON)
        });
        expect(forged.statusCode).toBe(404);
        await otherOwner.close();
      } finally {
        await app.close();
      }
    });

    it("does not let another user or an admin delete the owner's review", async () => {
      const owner = buildApp(ids.userA, createResolverCache());
      const other = buildApp(ids.userB, createResolverCache());
      const admin = buildApp(ids.adminUser, createResolverCache());
      try {
        const conn = await createConnection(ids.userA, "Owner A Delete Route");
        const saved = await owner.inject({
          method: "PUT",
          url: `/api/integrations/${conn.id}/classifier/tools/turn_on`,
          payload: reviewFor(TURN_ON)
        });
        expect(saved.statusCode).toBe(200);

        for (const intruder of [other, admin]) {
          const res = await intruder.inject({
            method: "DELETE",
            url: `/api/integrations/${conn.id}/classifier/tools/turn_on`
          });
          expect(res.statusCode).toBe(404);
        }

        const stillThere = await owner.inject({
          method: "GET",
          url: `/api/integrations/${conn.id}`
        });
        expect(stillThere.json().classifierPreparation).toHaveLength(1);
      } finally {
        await owner.close();
        await other.close();
        await admin.close();
      }
    });
  });
});
