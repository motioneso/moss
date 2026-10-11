import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  MemoryGraphRepository,
  memoryForgetExecute,
  registerMemoryGraphRoutes
} from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let appDataContext: DataContextRunner;
let graphServer: FastifyInstance;
let originalEmbedProvider: string | undefined;

beforeAll(async () => {
  originalEmbedProvider = process.env.JARVIS_EMBED_PROVIDER;
  process.env.JARVIS_EMBED_PROVIDER = "stub";
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  appDataContext = new DataContextRunner(appDb);
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
  if (originalEmbedProvider === undefined) {
    delete process.env.JARVIS_EMBED_PROVIDER;
  } else {
    process.env.JARVIS_EMBED_PROVIDER = originalEmbedProvider;
  }
});

async function resolveAccessContext(request: FastifyRequest) {
  if (request.headers.authorization === "Bearer user-a") {
    return { actorUserId: ids.userA, requestId: "memory-graph-forget" };
  }
  throw new Error("Unauthorized");
}

function userAHeaders() {
  return { authorization: "Bearer user-a" };
}

describe("forgetting a memory fact cleans up conflicts", () => {
  async function seedConflict(labels: string[]) {
    return appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:forget-conflict" },
      async (db) => {
        const repo = new MemoryGraphRepository();
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const facts = [];
        for (const label of labels) {
          facts.push(
            await repo.createFact(db, ids.userA, {
              subjectEntityId: self.id,
              predicate: "prefers",
              objectText: `forget conflict ${label} ${randomUUID()}`,
              confidence: 0.8,
              provenance: "volunteered",
              source: { sourceKind: "manual", sourceRef: `manual:${label}`, excerpt: label }
            })
          );
        }
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
            AND id IN (${sql.join(facts.map((f) => sql`${f.id}::uuid`))})
        `.execute(db.db);
        return { facts, groupId };
      }
    );
  }

  async function readConflictState(factId: string, groupId: string) {
    return appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:forget-conflict-check" },
      async (db) => {
        const fact = await sql<{ status: string; conflict_group_id: string | null }>`
          SELECT status, conflict_group_id FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${factId}::uuid
        `.execute(db.db);
        const group = await sql<{ status: string }>`
          SELECT status FROM app.memory_conflict_groups
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${groupId}::uuid
        `.execute(db.db);
        return { fact: fact.rows[0], group: group.rows[0] };
      }
    );
  }

  it("forgetting one side of a conflict restores the other fact and resolves the group", async () => {
    const { facts, groupId } = await seedConflict(["first", "second"]);
    const [first, second] = facts;

    const res = await graphServer.inject({
      method: "DELETE",
      url: `/api/memory/graph/facts/${first?.id}`,
      headers: userAHeaders()
    });
    expect(res.statusCode).toBe(204);

    const after = await readConflictState(second?.id ?? "", groupId);
    expect(after.fact).toMatchObject({ status: "active", conflict_group_id: null });
    expect(after.group?.status).toBe("resolved");
  });

  it("forget an overruled fact after another is confirmed", async () => {
    const { facts, groupId } = await seedConflict(["first", "second", "third"]);
    const [first, second] = facts;
    await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:forget-after-confirm" },
      (db) => new MemoryGraphRepository().confirmFact(db, ids.userA, first?.id ?? "")
    );

    const res = await graphServer.inject({
      method: "DELETE",
      url: `/api/memory/graph/facts/${second?.id}`,
      headers: userAHeaders()
    });
    expect(res.statusCode).toBe(204);

    const third = await readConflictState(facts[2]?.id ?? "", groupId);
    expect(third.fact?.status).toBe("superseded");
  });

  it("the memory.forget tool cleans up conflicts the same way", async () => {
    const { facts, groupId } = await seedConflict(["first", "second"]);
    const [first, second] = facts;

    const result = await appDataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:forget-tool" },
      (db) =>
        memoryForgetExecute(db, { factId: first?.id }, {
          actorUserId: ids.userA
        } as Parameters<typeof memoryForgetExecute>[2])
    );
    expect(result.data).toMatchObject({ deleted: true });

    const after = await readConflictState(second?.id ?? "", groupId);
    expect(after.fact).toMatchObject({ status: "active", conflict_group_id: null });
    expect(after.group?.status).toBe("resolved");
  });
});
