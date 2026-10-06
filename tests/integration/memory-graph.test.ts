import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import {
  createMemoryCandidateSignature,
  GraphMemoryRecallService,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  registerMemoryGraphRoutes,
  StubEmbeddingProvider,
  type MemoryFactPredicate
} from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const graphTables = [
  "memory_entities",
  "memory_facts",
  "memory_episodes",
  "memory_fact_sources",
  "memory_aliases",
  "memory_search_documents",
  "memory_legacy_fact_migrations",
  "memory_conflict_groups",
  "memory_candidates"
] as const;

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let migrationDb: Kysely<MossDatabase>;
let appDataContext: DataContextRunner;
let workerDataContext: DataContextRunner;
let graphServer: FastifyInstance;
let originalEmbedProvider: string | undefined;

beforeAll(async () => {
  originalEmbedProvider = process.env.JARVIS_EMBED_PROVIDER;
  process.env.JARVIS_EMBED_PROVIDER = "stub";
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  migrationDb = createDatabase({
    connectionString: connectionStrings.migration,
    maxConnections: 1
  });
  appDataContext = new DataContextRunner(appDb);
  workerDataContext = new DataContextRunner(workerDb);
  graphServer = Fastify();
  registerMemoryGraphRoutes(graphServer, {
    dataContext: appDataContext,
    resolveAccessContext
  });
  await graphServer.ready();
});

afterAll(async () => {
  await graphServer?.close();
  await appDb?.destroy();
  await workerDb?.destroy();
  await migrationDb?.destroy();
  if (originalEmbedProvider === undefined) {
    delete process.env.JARVIS_EMBED_PROVIDER;
  } else {
    process.env.JARVIS_EMBED_PROVIDER = originalEmbedProvider;
  }
});

describe("memory graph schema and RLS", () => {
  it("creates owner-scoped FORCE RLS tables for app and worker roles", async () => {
    const tables = await sql<{ table_name: string; force_rls: boolean }>`
      SELECT c.relname AS table_name, c.relforcerowsecurity AS force_rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relname = ANY(${graphTables}::text[])
      ORDER BY c.relname
    `.execute(migrationDb);

    expect(tables.rows.map((r) => r.table_name)).toEqual([...graphTables].sort());
    expect(tables.rows.every((r) => r.force_rls)).toBe(true);

    const policies = await sql<{ table_name: string; role_name: string }>`
      SELECT c.relname AS table_name, g.rolname AS role_name
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      CROSS JOIN LATERAL unnest(p.polroles) AS role_oid(oid)
      JOIN pg_roles g ON g.oid = role_oid.oid
      WHERE c.relname = ANY(${graphTables}::text[])
      ORDER BY c.relname, g.rolname
    `.execute(migrationDb);

    for (const table of graphTables) {
      const roles = policies.rows.filter((r) => r.table_name === table).map((r) => r.role_name);
      expect(roles).toContain("jarvis_app_runtime");
      expect(roles).toContain("jarvis_worker_runtime");
    }

    const factColumns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = 'memory_facts'
      ORDER BY column_name
    `.execute(migrationDb);
    expect(factColumns.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining([
        "record_kind",
        "stale_at",
        "superseded_by_fact_id",
        "conflict_group_id",
        "last_confirmed_at"
      ])
    );
  });

  it("prevents cross-user reads and writes through app and worker roles", async () => {
    await expectGraphIsolation(appDataContext, "app");
    await expectGraphIsolation(workerDataContext, "worker");
  });
});

describe("MemoryGraphRepository", () => {
  const repo = new MemoryGraphRepository();

  it("creates one self entity per owner and survives repeated calls", async () => {
    const selfA = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:self-a" },
      (db) => repo.ensureSelfEntity(db, ids.userA)
    );
    const selfB = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:self-b" },
      (db) => repo.ensureSelfEntity(db, ids.userA)
    );

    expect(selfB.id).toBe(selfA.id);
    expect(selfA.kind).toBe("self");
    expect(selfA.name).toBe("Self");
  });

  it("creates source-backed facts, aliases, and search documents", async () => {
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:repo" },
      async (db) => {
        const project = await repo.createEntity(db, ids.userA, {
          kind: "project",
          name: "House project",
          summary: "Kitchen remodel",
          importance: 0.7,
          pinned: false
        });
        const alias = await repo.addAlias(db, ids.userA, project.id, "remodel", false);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: project.id,
          predicate: "has_constraint" satisfies MemoryFactPredicate,
          objectText: "budget ceiling is 50k",
          confidence: 0.9,
          provenance: "confirmed",
          importance: 0.8,
          pinned: true,
          source: {
            sourceKind: "manual",
            sourceRef: "manual:test",
            sourceLabel: "Manual test",
            excerpt: "Budget ceiling is 50k"
          }
        });

        const docs = await repo.listSearchDocumentsForOwner(db, ids.userA);
        expect(alias.normalizedAlias).toBe("remodel");
        expect(fact.sources).toHaveLength(1);
        expect(fact).toMatchObject({
          recordKind: "constraint",
          confidenceTier: "confirmed",
          status: "active",
          staleAt: null,
          supersededByFactId: null,
          conflictGroupId: null
        });
        expect(docs.map((d) => `${d.targetKind}:${d.targetId}`)).toContain(`entity:${project.id}`);
        expect(docs.map((d) => `${d.targetKind}:${d.targetId}`)).toContain(`fact:${fact.id}`);
      }
    );
  });

  it("confirms, stales, rejects, and corrects facts with search document updates", async () => {
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:status-flows" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `status flow ${randomUUID()}`,
          confidence: 0.62,
          provenance: "inferred",
          source: { sourceKind: "manual", sourceRef: "manual:status", excerpt: "status flow" }
        });

        const confirmed = await repo.confirmFact(db, ids.userA, fact.id);
        expect(confirmed).toMatchObject({
          confidenceTier: "confirmed",
          provenance: "confirmed",
          status: "active"
        });
        expect(confirmed?.confidence).toBeGreaterThanOrEqual(0.9);

        const stale = await repo.markFactStale(db, ids.userA, fact.id);
        expect(stale?.status).toBe("stale");
        expect(stale?.staleAt).toBeInstanceOf(Date);
        let docs = await repo.listSearchDocumentsForOwner(db, ids.userA);
        expect(docs.find((d) => d.targetId === fact.id)?.status).toBe("active");

        const rejected = await repo.patchFactStatus(db, ids.userA, fact.id, {
          status: "rejected"
        });
        expect(rejected?.status).toBe("rejected");
        docs = await repo.listSearchDocumentsForOwner(db, ids.userA);
        expect(docs.find((d) => d.targetId === fact.id)?.status).toBe("inactive");

        const corrected = await repo.correctFact(db, ids.userA, {
          targetFactId: fact.id,
          replacementText: "replacement status flow"
        });
        expect(corrected).toMatchObject({
          objectText: "replacement status flow",
          status: "active",
          provenance: "confirmed"
        });
      }
    );
  });

  it("rejects generic status changes for conflict groups and resolves by confirm", async () => {
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:conflict-resolution" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const first = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "prefers",
          objectText: `conflict first ${randomUUID()}`,
          confidence: 0.7,
          provenance: "inferred",
          source: { sourceKind: "manual", sourceRef: "manual:conflict-1", excerpt: "first" }
        });
        const second = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "prefers",
          objectText: `conflict second ${randomUUID()}`,
          confidence: 0.8,
          provenance: "volunteered",
          source: { sourceKind: "manual", sourceRef: "manual:conflict-2", excerpt: "second" }
        });
        const group = await sql<{ id: string }>`
          INSERT INTO app.memory_conflict_groups (owner_user_id)
          VALUES (${ids.userA}::uuid)
          RETURNING id
        `.execute(db.db);
        const groupId = group.rows[0]?.id ?? "";
        await sql`
          UPDATE app.memory_facts
          SET status = 'conflicting', conflict_group_id = ${groupId}::uuid
          WHERE owner_user_id = ${ids.userA}::uuid
            AND id IN (${first.id}::uuid, ${second.id}::uuid)
        `.execute(db.db);

        await expect(
          repo.patchFactStatus(db, ids.userA, first.id, { status: "rejected" })
        ).rejects.toThrow(/confirm or correct/);

        const confirmed = await repo.confirmFact(db, ids.userA, first.id);
        const sibling = await serviceFact(db, second.id);
        const resolved = await sql<{ status: string }>`
          SELECT status
          FROM app.memory_conflict_groups
          WHERE owner_user_id = ${ids.userA}::uuid
            AND id = ${groupId}::uuid
        `.execute(db.db);

        expect(confirmed).toMatchObject({ status: "active", conflictGroupId: null });
        expect(sibling).toMatchObject({ status: "superseded", superseded_by_fact_id: first.id });
        expect(resolved.rows[0]?.status).toBe("resolved");
      }
    );
  });
});

describe("MemoryCandidatesRepository", () => {
  const repo = new MemoryCandidatesRepository();

  it("dedupes candidates by owner-scoped signature and preserves resolved status", async () => {
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-candidates:repo" },
      async (db) => {
        const signature = createMemoryCandidateSignature({
          kind: "fact",
          action: "create",
          fact: {
            subject: "Jarvis",
            predicate: "related_to",
            objectText: "memory distillation"
          }
        });
        const first = await repo.insertPending(db, ids.userA, {
          episodeId: null,
          kind: "fact",
          action: "create",
          payloadJson: { kind: "fact", action: "create" },
          candidateSignature: signature,
          confidence: 0.6,
          importance: 0.5,
          provenance: "inferred"
        });

        await repo.markRejected(db, ids.userA, first.id, "review rejected");

        const second = await repo.insertPending(db, ids.userA, {
          episodeId: null,
          kind: "fact",
          action: "create",
          payloadJson: { kind: "fact", action: "create" },
          candidateSignature: signature,
          confidence: 0.9,
          importance: 0.9,
          provenance: "volunteered"
        });

        expect(second.id).toBe(first.id);
        expect(second.status).toBe("rejected");
        expect(await repo.listPending(db, ids.userA, 10)).toEqual([]);
      }
    );
  });

  it("keeps same candidate signature isolated per owner", async () => {
    const signature = createMemoryCandidateSignature({
      kind: "fact",
      action: "create",
      fact: { subject: "Jarvis", predicate: "related_to", objectText: "owner scoped" }
    });

    const a = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-candidates:owner-a" },
      (db) =>
        repo.insertPending(db, ids.userA, {
          episodeId: null,
          kind: "fact",
          action: "create",
          payloadJson: { owner: "a" },
          candidateSignature: signature,
          confidence: 0.6,
          importance: 0.5,
          provenance: "inferred"
        })
    );
    const b = await appDataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "memory-candidates:owner-b" },
      (db) =>
        repo.insertPending(db, ids.userB, {
          episodeId: null,
          kind: "fact",
          action: "create",
          payloadJson: { owner: "b" },
          candidateSignature: signature,
          confidence: 0.6,
          importance: 0.5,
          provenance: "inferred"
        })
    );

    expect(b.id).not.toBe(a.id);
  });
});

describe("GraphMemoryRecallService", () => {
  it("recalls ranked, active, source-backed memory for a query", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider());

    const result = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:recall" },
      async (db) => {
        const written = await service.remember(db, ids.userA, {
          predicate: "prefers",
          objectText: `concise mobile responses ${randomUUID()}`,
          confidence: 0.95,
          provenance: "confirmed",
          importance: 0.9,
          pinned: true,
          source: {
            sourceKind: "manual",
            sourceRef: "manual:recall-test",
            sourceLabel: "Manual memory",
            excerpt: "Ben prefers concise mobile responses."
          }
        });
        await service.remember(db, ids.userA, {
          predicate: "related_to",
          objectText: "low priority unrelated fact",
          confidence: 0.4,
          provenance: "inferred",
          importance: 0.1,
          source: {
            sourceKind: "manual",
            sourceRef: "manual:noise",
            excerpt: "Noise"
          }
        });
        return { written, recalled: await service.recall(db, ids.userA, "mobile responses") };
      }
    );

    expect(result.recalled.items[0]).toMatchObject({
      kind: "fact",
      id: result.written.fact.id,
      provenance: "confirmed",
      confidence: 0.95
    });
    expect(result.recalled.items[0]?.sources.length).toBeGreaterThan(0);
  });

  it("does not recall another user's graph memory", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider());
    const privateText = `User B graph memory ${randomUUID()}`;

    await appDataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "memory-graph:recall-user-b" },
      (db) =>
        service.remember(db, ids.userB, {
          predicate: "related_to",
          objectText: privateText,
          confidence: 0.9,
          provenance: "confirmed",
          importance: 0.9,
          source: { sourceKind: "manual", sourceRef: "manual:user-b-private", excerpt: privateText }
        })
    );

    const recalledAsA = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:passive-isolation" },
      (db) => service.recall(db, ids.userA, privateText, { limit: 8 })
    );

    expect(recalledAsA.items.some((item) => item.text.includes(privateText))).toBe(false);
  });

  it("returns capped core memory and excludes superseded facts", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider());

    const result = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:core" },
      async (db) => {
        const write = await service.remember(db, ids.userA, {
          predicate: "has_goal",
          objectText: `goal ${randomUUID()}`,
          confidence: 0.9,
          provenance: "confirmed",
          importance: 0.9,
          pinned: true,
          source: { sourceKind: "manual", sourceRef: "manual:core", excerpt: "Core goal" }
        });
        await service.supersede(db, ids.userA, { factId: write.fact.id });
        return { supersededId: write.fact.id, core: await service.core(db, ids.userA) };
      }
    );

    expect(result.core.items.map((item) => item.id)).not.toContain(result.supersededId);
    expect(result.core.items.length).toBeLessThanOrEqual(20);
  });

  it("excludes stale and low-confidence recall by default unless explicitly included", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider());
    const token = `recall gates ${randomUUID()}`;

    const result = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:gates" },
      async (db) => {
        const active = await service.remember(db, ids.userA, {
          predicate: "related_to",
          objectText: `${token} active`,
          confidence: 0.8,
          provenance: "volunteered",
          source: { sourceKind: "manual", sourceRef: "manual:active", excerpt: "active" }
        });
        const weak = await service.remember(db, ids.userA, {
          predicate: "related_to",
          objectText: `weak unrelated ${randomUUID()}`,
          confidence: 0.4,
          provenance: "inferred",
          source: { sourceKind: "manual", sourceRef: "manual:weak", excerpt: "weak" }
        });
        const stale = await service.remember(db, ids.userA, {
          predicate: "related_to",
          objectText: `${token} stale`,
          confidence: 0.8,
          provenance: "volunteered",
          source: { sourceKind: "manual", sourceRef: "manual:stale", excerpt: "stale" }
        });
        await new MemoryGraphRepository().markFactStale(db, ids.userA, stale.fact.id);
        return {
          activeId: active.fact.id,
          weakId: weak.fact.id,
          staleId: stale.fact.id,
          normal: await service.recall(db, ids.userA, token, { limit: 10 }),
          low: await service.recall(db, ids.userA, token, {
            limit: 10,
            includeStale: true,
            includeLowConfidence: true
          }),
          withStale: await service.recall(db, ids.userA, token, { limit: 10, includeStale: true })
        };
      }
    );

    expect(result.normal.items.map((item) => item.id)).toContain(result.activeId);
    expect(result.normal.items.map((item) => item.id)).not.toContain(result.weakId);
    expect(result.normal.items.map((item) => item.id)).not.toContain(result.staleId);
    expect(result.low.items.map((item) => item.id)).toContain(result.weakId);
    expect(result.withStale.items.map((item) => item.id)).toContain(result.staleId);
  });
});

describe("memory graph API routes", () => {
  it("creates, recalls, pins, supersedes, and forgets owned graph facts", async () => {
    const entity = await graphServer.inject({
      method: "POST",
      url: "/api/memory/graph/entities",
      headers: userAHeaders(),
      payload: {
        kind: "project",
        name: "Route project",
        summary: "Route test memory",
        importance: 0.7,
        pinned: false
      }
    });
    expect(entity.statusCode).toBe(200);
    const entityId = entity.json<{ entity: { id: string } }>().entity.id;

    const fact = await graphServer.inject({
      method: "POST",
      url: "/api/memory/graph/facts",
      headers: userAHeaders(),
      payload: {
        subjectEntityId: entityId,
        predicate: "prefers",
        objectText: `route mobile responses ${randomUUID()}`,
        confidence: 0.92,
        provenance: "confirmed",
        importance: 0.8,
        source: {
          sourceKind: "manual",
          sourceRef: "manual:route-test",
          excerpt: "Route memory excerpt"
        }
      }
    });
    expect(fact.statusCode).toBe(200);
    const factId = fact.json<{ fact: { id: string } }>().fact.id;

    const recall = await graphServer.inject({
      method: "GET",
      url: "/api/memory/graph/recall?q=mobile%20responses",
      headers: userAHeaders()
    });
    expect(recall.statusCode).toBe(200);
    expect(recall.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toContain(
      factId
    );

    const core = await graphServer.inject({
      method: "GET",
      url: "/api/memory/graph/core",
      headers: userAHeaders()
    });
    expect(core.statusCode).toBe(200);
    expect(core.json<{ items: unknown[] }>().items.length).toBeLessThanOrEqual(20);

    const pin = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/pin`,
      headers: userAHeaders(),
      payload: { pinned: true }
    });
    expect(pin.statusCode).toBe(204);

    const confirm = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/confirm`,
      headers: userAHeaders(),
      payload: {}
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json<{ fact: { confidence: number; confidenceTier: string } }>().fact).toEqual(
      expect.objectContaining({ confidenceTier: "confirmed" })
    );

    const stale = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/mark-stale`,
      headers: userAHeaders(),
      payload: {}
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json<{ fact: { status: string } }>().fact.status).toBe("stale");

    const status = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/status`,
      headers: userAHeaders(),
      payload: { status: "active" }
    });
    expect(status.statusCode).toBe(200);

    const correction = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/correct`,
      headers: userAHeaders(),
      payload: { replacementText: "corrected route mobile responses" }
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json<{ fact: { objectText: string } }>().fact.objectText).toBe(
      "corrected route mobile responses"
    );

    const supersede = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${factId}/supersede`,
      headers: userAHeaders(),
      payload: {}
    });
    expect(supersede.statusCode).toBe(204);

    const afterSupersede = await graphServer.inject({
      method: "GET",
      url: "/api/memory/graph/recall?q=mobile%20responses",
      headers: userAHeaders()
    });
    expect(
      afterSupersede.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)
    ).not.toContain(factId);
  });

  it("does not let user A forget user B graph memory", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider());
    const write = await appDataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "memory-graph:user-b-route" },
      (db) =>
        service.remember(db, ids.userB, {
          predicate: "related_to",
          objectText: "User B graph memory",
          confidence: 0.9,
          provenance: "confirmed",
          importance: 0.8,
          source: { sourceKind: "manual", sourceRef: "manual:user-b", excerpt: "Private B" }
        })
    );

    const res = await graphServer.inject({
      method: "DELETE",
      url: `/api/memory/graph/facts/${write.fact.id}`,
      headers: userAHeaders()
    });

    expect(res.statusCode).toBe(404);
  });
});

async function expectGraphIsolation(
  dataContext: DataContextRunner,
  roleLabel: string
): Promise<void> {
  await seedOtherUserGraph();

  await dataContext.withDataContext(
    { actorUserId: ids.userA, requestId: `memory-graph-rls:${roleLabel}` },
    async (scopedDb) => {
      const userAEntityId = await insertEntity(scopedDb, ids.userA, `${roleLabel} user A`);
      const own = await sql<{ id: string }>`
        SELECT id FROM app.memory_entities WHERE id = ${userAEntityId}::uuid
      `.execute(scopedDb.db);
      expect(own.rows).toEqual([{ id: userAEntityId }]);

      const other = await sql<{ id: string }>`
        SELECT id
        FROM app.memory_entities
        WHERE owner_user_id = ${ids.userB}::uuid
      `.execute(scopedDb.db);
      expect(other.rows).toEqual([]);

      await expect(insertEntity(scopedDb, ids.userB, `${roleLabel} wrong owner`)).rejects.toThrow(
        /row-level security|violates row-level security|permission denied/i
      );
    }
  );
}

describe("transaction atomicity (#554)", () => {
  const repo = new MemoryGraphRepository();

  it("rolls back confirmFact writes when the withDataContext callback throws", async () => {
    let factId!: string;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:confirmFact:setup" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `atomicity-confirm-${randomUUID()}`,
          confidence: 0.5,
          provenance: "volunteered",
          source: {
            sourceKind: "manual",
            sourceRef: "manual:atomicity-confirm",
            excerpt: "atomicity"
          }
        });
        factId = fact.id;
      }
    );

    await expect(
      appDataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "atomicity:confirmFact:fail" },
        async (db) => {
          await repo.confirmFact(db, ids.userA, factId);
          throw new Error("simulated mid-operation failure");
        }
      )
    ).rejects.toThrow("simulated mid-operation failure");

    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:confirmFact:check" },
      async (db) => {
        const result = await sql<{ provenance: string }>`
          SELECT provenance FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${factId}::uuid
        `.execute(db.db);
        return result.rows[0];
      }
    );
    expect(check?.provenance).toBe("volunteered");
  });

  it("rolls back correctFact writes when the withDataContext callback throws", async () => {
    let factId!: string;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:correctFact:setup" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `atomicity-correct-original-${randomUUID()}`,
          confidence: 0.5,
          provenance: "volunteered",
          source: {
            sourceKind: "manual",
            sourceRef: "manual:atomicity-correct",
            excerpt: "atomicity"
          }
        });
        factId = fact.id;
      }
    );

    await expect(
      appDataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "atomicity:correctFact:fail" },
        async (db) => {
          await repo.correctFact(db, ids.userA, {
            targetFactId: factId,
            replacementText: "atomicity-correct-replacement"
          });
          throw new Error("simulated mid-operation failure");
        }
      )
    ).rejects.toThrow("simulated mid-operation failure");

    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:correctFact:check" },
      async (db) => {
        const result = await sql<{ status: string; object_text: string }>`
          SELECT status, object_text FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid
            AND object_text LIKE 'atomicity-correct-%'
        `.execute(db.db);
        return result.rows;
      }
    );
    expect(check).toHaveLength(1);
    expect(check[0]?.status).toBe("active");
    expect(check[0]?.object_text).toMatch(/original/);
  });

  it("rolls back patchFactStatus writes when the withDataContext callback throws", async () => {
    let factId!: string;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:patchStatus:setup" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `atomicity-patch-status-${randomUUID()}`,
          confidence: 0.5,
          provenance: "volunteered",
          source: {
            sourceKind: "manual",
            sourceRef: "manual:atomicity-patch",
            excerpt: "atomicity"
          }
        });
        factId = fact.id;
      }
    );

    await expect(
      appDataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "atomicity:patchStatus:fail" },
        async (db) => {
          await repo.patchFactStatus(db, ids.userA, factId, { status: "stale" });
          throw new Error("simulated mid-operation failure");
        }
      )
    ).rejects.toThrow("simulated mid-operation failure");

    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "atomicity:patchStatus:check" },
      async (db) => {
        const result = await sql<{ status: string }>`
          SELECT status FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${factId}::uuid
        `.execute(db.db);
        return result.rows[0];
      }
    );
    expect(check?.status).toBe("active");
  });
});

describe("patchFactStatus superseded guard (#555)", () => {
  const repo = new MemoryGraphRepository();

  it("rejects reactivation of a superseded fact with 400", async () => {
    let originalFactId!: string;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "555:setup" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `superseded-guard-${randomUUID()}`,
          confidence: 0.5,
          provenance: "volunteered",
          source: { sourceKind: "manual", sourceRef: "manual:555", excerpt: "555 guard" }
        });
        originalFactId = fact.id;
        await repo.correctFact(db, ids.userA, {
          targetFactId: originalFactId,
          replacementText: "replacement for superseded guard"
        });
      }
    );

    const response = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${originalFactId}/status`,
      headers: { authorization: "Bearer user-a" },
      payload: { status: "active" }
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: string };
    expect(body.error).toMatch(/superseded/i);
  });

  it("still allows patching non-active statuses on a superseded fact", async () => {
    let originalFactId!: string;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "555:allow-stale-setup" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const fact = await repo.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: `superseded-allow-stale-${randomUUID()}`,
          confidence: 0.5,
          provenance: "volunteered",
          source: { sourceKind: "manual", sourceRef: "manual:555-stale", excerpt: "555 stale" }
        });
        originalFactId = fact.id;
        await repo.correctFact(db, ids.userA, {
          targetFactId: originalFactId,
          replacementText: "replacement for stale allow"
        });
      }
    );

    const response = await graphServer.inject({
      method: "POST",
      url: `/api/memory/graph/facts/${originalFactId}/status`,
      headers: { authorization: "Bearer user-a" },
      payload: { status: "rejected" }
    });

    expect(response.statusCode).toBe(200);
  });
});

async function resolveAccessContext(request: FastifyRequest) {
  const auth = request.headers.authorization;
  if (auth === "Bearer user-a") return { actorUserId: ids.userA, requestId: "memory-graph-api" };
  if (auth === "Bearer user-b") return { actorUserId: ids.userB, requestId: "memory-graph-api" };
  throw new Error("Unauthorized");
}

function userAHeaders() {
  return { authorization: "Bearer user-a" };
}

async function insertEntity(
  scopedDb: DataContextDb,
  ownerUserId: string,
  name: string
): Promise<string> {
  const inserted = await sql<{ id: string }>`
    INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
    VALUES (${ownerUserId}::uuid, 'project', ${name}, 'test summary')
    RETURNING id
  `.execute(scopedDb.db);

  return inserted.rows[0]?.id ?? "";
}

async function serviceFact(scopedDb: DataContextDb, factId: string) {
  const result = await sql<{ status: string; superseded_by_fact_id: string | null }>`
    SELECT status, superseded_by_fact_id::text
    FROM app.memory_facts
    WHERE owner_user_id = ${ids.userA}::uuid
      AND id = ${factId}::uuid
  `.execute(scopedDb.db);
  return result.rows[0];
}

async function seedOtherUserGraph(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `
        INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
        VALUES ($1, 'project', 'User B private graph memory', 'private')
        ON CONFLICT DO NOTHING
      `,
      [ids.userB]
    );
  } finally {
    await client.end();
  }
}
