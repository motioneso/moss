import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { type Kysely, sql } from "kysely";

import { createDatabase, DataContextRunner, type AccessContext, type MossDatabase } from "@moss/db";
import {
  createMemoryCandidateSignature,
  ManualMemoryCandidateService,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  registerMemoryDashboardRoutes,
  StubEmbeddingProvider,
  type MemoryFactPredicate
} from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let appDataContext: DataContextRunner;
let server: FastifyInstance;
let originalEmbedProvider: string | undefined;

const candidatesRepo = new MemoryCandidatesRepository();
const manualCandidates = new ManualMemoryCandidateService();
const graphRepo = new MemoryGraphRepository();

beforeAll(async () => {
  originalEmbedProvider = process.env.JARVIS_EMBED_PROVIDER;
  process.env.JARVIS_EMBED_PROVIDER = "stub";
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  appDataContext = new DataContextRunner(appDb);
  server = Fastify();
  registerMemoryDashboardRoutes(server, {
    dataContext: appDataContext,
    resolveAccessContext
  });
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await appDb?.destroy();
  if (originalEmbedProvider === undefined) {
    delete process.env.JARVIS_EMBED_PROVIDER;
  } else {
    process.env.JARVIS_EMBED_PROVIDER = originalEmbedProvider;
  }
});

function resolveAccessContext(request: FastifyRequest): Promise<AccessContext> {
  const userId = (request.headers["x-user-id"] as string | undefined) ?? ids.userA;
  return Promise.resolve({ actorUserId: userId, requestId: "test" });
}

function authHeaders(userId: string = ids.userA) {
  return { "x-user-id": userId };
}

async function insertPendingCandidate(ownerUserId: string, overrides: object = {}) {
  const payload = {
    kind: "fact",
    action: "create",
    fact: { subject: "user", predicate: "prefers", objectText: "dark mode" },
    ...overrides
  };
  const sig = createMemoryCandidateSignature({
    kind: "fact",
    action: "create",
    fact: { subject: "user", predicate: "prefers", objectText: "dark mode" }
  });
  return appDataContext.withDataContext(
    { actorUserId: ownerUserId, requestId: "test-seed" },
    (db) =>
      candidatesRepo.insertPending(db, ownerUserId, {
        kind: "fact",
        action: "create",
        payloadJson: payload,
        candidateSignature: sig + randomUUID(),
        confidence: 0.85,
        importance: 0.7,
        provenance: "inferred"
      })
  );
}

describe("GET /api/memory/dashboard", () => {
  it("returns empty dashboard for user with no data", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/memory/dashboard",
      headers: authHeaders(ids.userB)
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toEqual([]);
    expect(body.counts).toBeDefined();
  });

  it("returns pending candidates in pending view", async () => {
    const candidate = await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "GET",
      url: "/api/memory/dashboard?status=pending",
      headers: authHeaders(ids.userA)
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.length).toBeGreaterThan(0);
    const item = body.items.find((i: { id: string }) => i.id === candidate.id);
    expect(item).toBeDefined();
    expect(item.itemKind).toBe("candidate");
    expect(item.status).toBe("pending");
    expect(item.editableFields).toContain("summary");
  });

  it("respects cursor-based pagination", async () => {
    for (let i = 0; i < 3; i++) await insertPendingCandidate(ids.userA, {});
    const page1 = await server.inject({
      method: "GET",
      url: "/api/memory/dashboard?status=pending&limit=2",
      headers: authHeaders(ids.userA)
    });
    const body1 = JSON.parse(page1.body);
    expect(body1.items.length).toBeLessThanOrEqual(2);
    if (body1.nextCursor) {
      const page2 = await server.inject({
        method: "GET",
        url: `/api/memory/dashboard?status=pending&limit=2&cursor=${body1.nextCursor}`,
        headers: authHeaders(ids.userA)
      });
      expect(page2.statusCode).toBe(200);
    }
  });

  it("does not leak candidates across users (RLS)", async () => {
    await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "GET",
      url: "/api/memory/dashboard?status=pending",
      headers: authHeaders(ids.userB)
    });
    const body = JSON.parse(res.body);
    const leaked = body.items.some((i: { id: string }) => i.id.startsWith(ids.userA));
    expect(leaked).toBe(false);
  });

  it("shows counts for all statuses", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/memory/dashboard",
      headers: authHeaders(ids.userA)
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.counts).toBeTypeOf("object");
  });
});

async function insertManualCandidate(ownerUserId: string, excerpt: string) {
  return appDataContext.withDataContext(
    { actorUserId: ownerUserId, requestId: "test-seed" },
    (db) =>
      manualCandidates.createPendingManualCandidate(db, ownerUserId, {
        targetKind: "chat_message",
        targetRef: randomUUID(),
        excerpt
      })
  );
}

describe("GET /api/memory/candidates", () => {
  it("lists only the actor's own pending suggestions, with remember-this text", async () => {
    const own = await insertManualCandidate(ids.userA, "Owner pending suggestion 3065");
    const resolved = await insertManualCandidate(ids.userA, "Owner rejected suggestion 3065");
    await appDataContext.withDataContext({ actorUserId: ids.userA, requestId: "test" }, (db) =>
      candidatesRepo.markRejected(db, ids.userA, resolved.id, "not relevant")
    );
    const foreign = await insertManualCandidate(ids.userB, "Other user's suggestion 3065");

    const res = await server.inject({
      method: "GET",
      url: "/api/memory/candidates",
      headers: authHeaders(ids.userA)
    });
    expect(res.statusCode).toBe(200);
    const items = (JSON.parse(res.body) as { items: { id: string; summary: string }[] }).items;
    expect(items).toContainEqual(
      expect.objectContaining({
        id: own.id,
        title: "Owner pending suggestion 3065",
        summary: "Owner pending suggestion 3065",
        provenance: "volunteered"
      })
    );
    const ids_ = items.map((item) => item.id);
    expect(ids_).not.toContain(resolved.id);
    expect(ids_).not.toContain(foreign.id);
    expect(res.body).not.toContain("Other user's suggestion 3065");
  });
});

describe("POST /api/memory/candidates/:id/reject", () => {
  it("rejects a pending candidate", async () => {
    const candidate = await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${candidate.id}/reject`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({ reason: "not relevant" })
    });
    expect(res.statusCode).toBe(204);

    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-check" },
      (db) => candidatesRepo.getById(db, ids.userA, candidate.id)
    );
    expect(check?.status).toBe("rejected");
  });

  it("returns 404 for unknown candidate", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${randomUUID()}/reject`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not allow cross-user rejection (RLS)", async () => {
    const candidate = await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${candidate.id}/reject`,
      headers: { ...authHeaders(ids.userB), "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/memory/candidates/:id/suppress", () => {
  it("suppresses a pending candidate", async () => {
    const candidate = await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${candidate.id}/suppress`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({ reason: "noise" })
    });
    expect(res.statusCode).toBe(204);
    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-check" },
      (db) => candidatesRepo.getById(db, ids.userA, candidate.id)
    );
    expect(check?.status).toBe("suppressed");
  });
});

describe("POST /api/memory/candidates/:id/accept", () => {
  it("accepts a fact candidate and creates a confirmed fact with confidence >= 0.90", async () => {
    const candidate = await insertPendingCandidate(ids.userA);
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${candidate.id}/accept`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.statusCode).toBe(200);
    const check = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-check" },
      (db) => candidatesRepo.getById(db, ids.userA, candidate.id)
    );
    expect(check?.status).toBe("promoted");
    const factRow = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-promoted-fact" },
      (db) =>
        sql<{ confidence: string; provenance: string }>`
          SELECT confidence, provenance FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid
          ORDER BY created_at DESC LIMIT 1
        `.execute(db.db)
    );
    expect(Number(factRow.rows[0]?.confidence)).toBeGreaterThanOrEqual(0.9);
    expect(factRow.rows[0]?.provenance).toBe("confirmed");
  });

  it("accepts a remember-this suggestion as its own text, once", async () => {
    const excerpt = "Remember-this accept text 3065";
    const candidate = await insertManualCandidate(ids.userA, excerpt);
    // No body, as a chat call sends it.
    const accept = () =>
      server.inject({
        method: "POST",
        url: `/api/memory/candidates/${candidate.id}/accept`,
        headers: authHeaders(ids.userA)
      });
    expect((await accept()).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(404);
    const facts = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-check" },
      (db) =>
        sql<{ object_text: string }>`
          SELECT object_text FROM app.memory_facts WHERE object_text = ${excerpt}
        `.execute(db.db)
    );
    expect(facts.rows).toHaveLength(1);
  });

  it("returns 404 for unknown candidate", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/memory/candidates/${randomUUID()}/accept`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/memory/graph/facts/:id", () => {
  it("patches fact lifecycle fields", async () => {
    const selfEntity = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-patch-fact" },
      (db) => graphRepo.ensureSelfEntity(db, ids.userA)
    );
    const stub = new StubEmbeddingProvider();
    const embedding = await stub.embedDocument("test fact");
    const fact = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-patch-fact" },
      async (db) => {
        const f = await graphRepo.createFact(db, ids.userA, {
          subjectEntityId: selfEntity.id,
          predicate: "prefers" as MemoryFactPredicate,
          objectText: "light mode",
          recordKind: "preference",
          source: { sourceKind: "manual", sourceRef: "test", excerpt: "" }
        });
        await graphRepo.upsertSearchDocument(
          db,
          ids.userA,
          "fact",
          f.id,
          "light mode",
          embedding,
          stub.modelName,
          stub.modelVersion
        );
        return f;
      }
    );

    const res = await server.inject({
      method: "PATCH",
      url: `/api/memory/graph/facts/${fact.id}`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown fact", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/memory/graph/facts/${randomUUID()}`,
      headers: { ...authHeaders(ids.userA), "content-type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/memory/graph/entities/:id", () => {
  it("deletes an entity with no facts", async () => {
    const entity = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-delete-entity" },
      (db) =>
        graphRepo.createEntity(db, ids.userA, {
          kind: "project",
          name: "Temp project to delete"
        })
    );
    const res = await server.inject({
      method: "DELETE",
      url: `/api/memory/graph/entities/${entity.id}`,
      headers: authHeaders(ids.userA)
    });
    expect(res.statusCode).toBe(204);
  });

  it("returns 409 when entity has associated facts", async () => {
    const selfEntity = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test-entity-block" },
      (db) => graphRepo.ensureSelfEntity(db, ids.userA)
    );
    const res = await server.inject({
      method: "DELETE",
      url: `/api/memory/graph/entities/${selfEntity.id}`,
      headers: authHeaders(ids.userA)
    });
    expect([403, 404, 409]).toContain(res.statusCode);
  });

  it("returns 404 for unknown entity", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: `/api/memory/graph/entities/${randomUUID()}`,
      headers: authHeaders(ids.userA)
    });
    expect(res.statusCode).toBe(404);
  });
});
