import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { registerMemoryDashboardRoutes } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

interface CandidatePage {
  total: number;
  hasMore: boolean;
  remainingCount: number;
  nextCursor: string | null;
  items: { id: string; title: string; summary: string; createdAt: string }[];
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let server: FastifyInstance;
let originalEmbedProvider: string | undefined;

const tiedTimestamp = "2026-10-06T12:00:00.123456Z";
const actors = [ids.userA, ids.userB, ids.adminUser];

beforeAll(async () => {
  originalEmbedProvider = process.env.JARVIS_EMBED_PROVIDER;
  process.env.JARVIS_EMBED_PROVIDER = "stub";
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  server = Fastify();
  registerMemoryDashboardRoutes(server, {
    dataContext,
    resolveAccessContext: async (request) => ({
      actorUserId: request.headers["x-user-id"] as string,
      requestId: "candidate-paging"
    })
  });
  await server.ready();
});

beforeEach(async () => {
  for (const actorUserId of actors) {
    await dataContext.withDataContext({ actorUserId, requestId: "clear-paging-fixtures" }, (db) =>
      sql`DELETE FROM app.memory_candidates WHERE owner_user_id = ${actorUserId}::uuid`.execute(
        db.db
      )
    );
  }
});

afterAll(async () => {
  await server?.close();
  await appDb?.destroy();
  if (originalEmbedProvider === undefined) delete process.env.JARVIS_EMBED_PROVIDER;
  else process.env.JARVIS_EMBED_PROVIDER = originalEmbedProvider;
});

function candidateId(number: number): string {
  return `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

async function seedCandidates(
  ownerUserId: string,
  numbers: readonly number[],
  createdAt = tiedTimestamp
): Promise<string[]> {
  await dataContext.withDataContext(
    { actorUserId: ownerUserId, requestId: "seed-paging" },
    async (db) => {
      for (const number of numbers) {
        const id = candidateId(number);
        const payload = {
          manualRequest: true,
          excerpt: `Suggestion ${number} belonging to ${ownerUserId}`,
          targetKind: "chat_message",
          targetRef: id
        };
        await sql`
        INSERT INTO app.memory_candidates (
          id, owner_user_id, kind, action, payload_json, candidate_signature,
          confidence, importance, provenance, created_at
        ) VALUES (
          ${id}::uuid, ${ownerUserId}::uuid, 'fact', 'create', ${JSON.stringify(payload)}::jsonb,
          ${`paging:${id}`}, 0.5, 0.5, 'volunteered', ${createdAt}::timestamptz
        )
      `.execute(db.db);
      }
    }
  );
  return numbers.map(candidateId);
}

async function readPage(ownerUserId: string, cursor?: string | null): Promise<CandidatePage> {
  const response = await server.inject({
    method: "GET",
    url: `/api/memory/candidates${cursor == null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
    headers: { "x-user-id": ownerUserId }
  });
  expect(response.statusCode).toBe(200);
  return response.json<CandidatePage>();
}

function expectPage(
  page: CandidatePage,
  expectedIds: readonly string[],
  total: number,
  remainingCount: number,
  nextCursor: string | null
): void {
  expect(page).toMatchObject({ total, remainingCount, hasMore: remainingCount > 0, nextCursor });
  expect(page.items.map((item) => item.id)).toEqual(expectedIds);
  expect(page).not.toHaveProperty("nextOffset");
}

describe("GET /api/memory/candidates stable last-seen cursors", () => {
  it("returns all seven unseen suggestions after rejecting two of the first five, including the cursor anchor", async () => {
    const orderedIds = Array.from({ length: 12 }, (_, i) => candidateId(i + 1));
    await seedCandidates(
      ids.userA,
      Array.from({ length: 12 }, (_, i) => 12 - i)
    );

    const first = await readPage(ids.userA);
    expectPage(first, orderedIds.slice(0, 5), 12, 7, `${tiedTimestamp}_${orderedIds[4]}`);
    for (const id of [orderedIds[0], orderedIds[4]]) {
      const response = await server.inject({
        method: "POST",
        url: `/api/memory/candidates/${id}/reject`,
        headers: { "x-user-id": ids.userA },
        payload: { reason: "decided while paging" }
      });
      expect(response.statusCode).toBe(204);
    }

    const second = await readPage(ids.userA, first.nextCursor);
    expectPage(second, orderedIds.slice(5, 10), 10, 2, `${tiedTimestamp}_${orderedIds[9]}`);
    const third = await readPage(ids.userA, second.nextCursor);
    expectPage(third, orderedIds.slice(10), 10, 0, null);

    const unseenIds = [...second.items, ...third.items].map((item) => item.id);
    expect(unseenIds).toEqual(orderedIds.slice(5));
    expect(unseenIds).toHaveLength(7);
    const deliveredIds = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(deliveredIds).toEqual(orderedIds);
    expect(new Set(deliveredIds).size).toBe(12);
  });

  it("defers arrivals before the cursor until a fresh list and includes arrivals after it without repeats", async () => {
    const orderedIds = await seedCandidates(ids.userA, [10, 20, 30, 40, 50, 60, 70, 80]);
    const first = await readPage(ids.userA);
    expectPage(first, orderedIds.slice(0, 5), 8, 3, `${tiedTimestamp}_${candidateId(50)}`);

    await seedCandidates(ids.userA, [90], "2026-10-06T12:00:00.123457Z");
    await seedCandidates(ids.userA, [55]);
    const second = await readPage(ids.userA, first.nextCursor);
    expectPage(second, [55, 60, 70, 80].map(candidateId), 10, 0, null);
    const deliveredIds = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(deliveredIds).size).toBe(9);
    expect(deliveredIds).not.toContain(candidateId(90));

    const restarted = await readPage(ids.userA);
    expectPage(
      restarted,
      [90, 10, 20, 30, 40].map(candidateId),
      10,
      5,
      `${tiedTimestamp}_${candidateId(40)}`
    );
  });

  it("updates the remaining count when unseen suggestions are decided before continuation", async () => {
    await seedCandidates(
      ids.userA,
      Array.from({ length: 12 }, (_, i) => i + 1)
    );
    const first = await readPage(ids.userA);
    expectPage(
      first,
      [1, 2, 3, 4, 5].map(candidateId),
      12,
      7,
      `${tiedTimestamp}_${candidateId(5)}`
    );
    for (const number of [6, 12]) {
      const response = await server.inject({
        method: "POST",
        url: `/api/memory/candidates/${candidateId(number)}/reject`,
        headers: { "x-user-id": ids.userA },
        payload: { reason: "decided before this page was viewed" }
      });
      expect(response.statusCode).toBe(204);
    }

    const second = await readPage(ids.userA, first.nextCursor);
    expectPage(second, [7, 8, 9, 10, 11].map(candidateId), 10, 0, null);
  });

  it("preserves PostgreSQL microseconds and ascending UUID ties across a page boundary", async () => {
    await seedCandidates(ids.userA, [8, 7, 5, 4, 3]);
    await seedCandidates(ids.userA, [9], "2026-10-06T12:00:00.123457Z");
    await seedCandidates(ids.userA, [2, 1], "2026-10-06T12:00:00.123455Z");

    const first = await readPage(ids.userA);
    expectPage(first, [9, 3, 4, 5, 7].map(candidateId), 8, 3, `${tiedTimestamp}_${candidateId(7)}`);
    // These timestamps all collapse to one millisecond in JavaScript Dates.
    expect(first.items.map((item) => item.createdAt)).toEqual(
      Array(5).fill("2026-10-06T12:00:00.123Z")
    );
    const second = await readPage(ids.userA, first.nextCursor);
    expectPage(second, [8, 1, 2].map(candidateId), 8, 0, null);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      [9, 3, 4, 5, 7, 8, 1, 2].map(candidateId)
    );
  });

  it("resumes from the stored timestamp and UUID after the cursor anchor is deleted", async () => {
    await seedCandidates(ids.userA, [1, 2, 3, 4, 5, 6, 7]);
    const first = await readPage(ids.userA);
    expectPage(first, [1, 2, 3, 4, 5].map(candidateId), 7, 2, `${tiedTimestamp}_${candidateId(5)}`);
    const deleted = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "delete-cursor-anchor" },
      (db) =>
        sql<{ id: string }>`
        DELETE FROM app.memory_candidates
        WHERE owner_user_id = ${ids.userA}::uuid AND id = ${candidateId(5)}::uuid
        RETURNING id
      `.execute(db.db)
    );
    expect(deleted.rows).toEqual([{ id: candidateId(5) }]);

    const second = await readPage(ids.userA, first.nextCursor);
    expectPage(second, [6, 7].map(candidateId), 6, 0, null);
  });

  it.each([
    ["another owner", ids.userB],
    ["an instance admin", ids.adminUser]
  ])(
    "keeps rows and both counts owner-scoped when %s supplies a foreign cursor",
    async (_label, actorUserId) => {
      await seedCandidates(
        ids.userA,
        Array.from({ length: 12 }, (_, i) => i + 1)
      );
      const ownIds = await seedCandidates(
        actorUserId,
        [101, 102, 103, 104, 105, 106],
        "2026-10-06T12:00:00.123455Z"
      );
      const foreign = await readPage(ids.userA);
      expectPage(
        foreign,
        [1, 2, 3, 4, 5].map(candidateId),
        12,
        7,
        `${tiedTimestamp}_${candidateId(5)}`
      );

      const sought = await readPage(actorUserId, foreign.nextCursor);
      expectPage(
        sought,
        ownIds.slice(0, 5),
        6,
        1,
        `2026-10-06T12:00:00.123455Z_${candidateId(105)}`
      );
      expect(JSON.stringify(sought)).not.toContain(ids.userA);
      const final = await readPage(actorUserId, sought.nextCursor);
      expectPage(final, ownIds.slice(5), 6, 0, null);
      expect(JSON.stringify(final)).not.toContain(ids.userA);
    }
  );

  it.each([
    "",
    "not-a-cursor",
    "2026-10-06T12:00:00.123456Z_not-a-uuid",
    `2026-10-06T12:00:00.123456Z_${candidateId(1)}_extra`,
    `2026-02-29T12:00:00.123456Z_${candidateId(1)}`,
    `2026-02-30T12:00:00.123456Z_${candidateId(1)}`,
    `2026-04-31T12:00:00.123456Z_${candidateId(1)}`,
    `2026-00-06T12:00:00.123456Z_${candidateId(1)}`,
    `2026-13-06T12:00:00.123456Z_${candidateId(1)}`,
    `2026-10-00T12:00:00.123456Z_${candidateId(1)}`,
    `2026-10-32T12:00:00.123456Z_${candidateId(1)}`,
    `2026-10-06T24:00:00.123456Z_${candidateId(1)}`,
    `2026-10-06T12:60:00.123456Z_${candidateId(1)}`,
    `2026-10-06T12:00:60.123456Z_${candidateId(1)}`
  ])("returns 400 for malformed or invalid-calendar cursor %j", async (cursor) => {
    await seedCandidates(ids.userA, [1]);
    const response = await server.inject({
      method: "GET",
      url: `/api/memory/candidates?cursor=${encodeURIComponent(cursor)}`,
      headers: { "x-user-id": ids.userA }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).not.toHaveProperty("items");
  });

  it("accepts a valid leap-day cursor whose UUID does not identify a stored row", async () => {
    await seedCandidates(ids.userA, [1], "2024-02-29T12:00:00.123456Z");
    const page = await readPage(ids.userA, `2024-02-29T12:00:00.123457Z_${candidateId(999)}`);
    expectPage(page, [candidateId(1)], 1, 0, null);
  });
});
