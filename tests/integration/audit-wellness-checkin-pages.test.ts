import Fastify, { type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { registerWellnessRoutes } from "@moss/wellness";
import type { ListCheckinsResponse } from "@moss/shared";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

// Run only through scripts/run-gate.sh. This exercises the real route, repository and RLS.
const owner = "00000000-0000-4000-8000-000000000861";
const other = "00000000-0000-4000-8000-000000000862";
const since = "2026-10-01T00:00:00.000Z";
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let server: FastifyInstance;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  try {
    await bootstrap.query(
      "INSERT INTO app.users (id,email,is_instance_admin) VALUES ($1,'audit-wellness-owner@example.test',false),($2,'audit-wellness-other@example.test',false)",
      [owner, other]
    );
  } finally {
    await bootstrap.end();
  }
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(db);
  for (const actor of [owner, other]) {
    await runner.withDataContext(
      { actorUserId: actor, requestId: "audit:seed" },
      async (scoped) => {
        await scoped.db
          .insertInto("app.wellness_checkins")
          .values(
            Array.from({ length: actor === owner ? 620 : 1 }, (_, index) => ({
              owner_user_id: actor,
              id: `10000000-0000-4000-${actor === owner ? "8000" : "8001"}-${String(index + 1).padStart(12, "0")}`,
              feeling_core: "happy" as const,
              note: `Fictional observation ${index + 1}`,
              intensity: 3,
              // Ties and microseconds deliberately straddle page boundaries.
              checked_in_at: sql<Date>`'2026-10-10T12:00:00.123456Z'::timestamptz`
            }))
          )
          .execute();
      }
    );
  }
  server = Fastify();
  registerWellnessRoutes(server, {
    dataContext: runner,
    resolveAccessContext: async (request) => ({
      actorUserId: request.headers["x-test-actor"] === "other" ? other : owner,
      requestId: "audit:read"
    })
  });
});

afterAll(async () => {
  await server?.close();
  await db?.destroy();
});

async function page(params: URLSearchParams, actor = "owner") {
  const response = await server.inject({
    method: "GET",
    url: `/api/wellness/checkins?${params}`,
    headers: { "x-test-actor": actor }
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListCheckinsResponse>();
}

describe("Wellness check-in traversal", () => {
  it("drains a selected window exceeding 500 rows without dropping tied timestamps", async () => {
    const first = await page(new URLSearchParams({ limit: "500", since }));
    expect(first.checkins).toHaveLength(500);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(
      new URLSearchParams({ limit: "500", since, cursor: first.nextCursor! })
    );
    expect(second.checkins).toHaveLength(120);
    expect(second.nextCursor).toBeNull();
    const all = [...first.checkins, ...second.checkins];
    expect(new Set(all.map((checkin) => checkin.id)).size).toBe(620);
    expect(all.every((checkin) => checkin.ownerUserId === owner)).toBe(true);
  });

  it("continues after the last page anchor is deleted and new rows arrive before it", async () => {
    const first = await page(new URLSearchParams({ limit: "50" }));
    const anchor = first.checkins.at(-1)!;
    await runner.withDataContext(
      { actorUserId: owner, requestId: "audit:interrupt" },
      async (scoped) => {
        await scoped.db.deleteFrom("app.wellness_checkins").where("id", "=", anchor.id).execute();
        await scoped.db
          .insertInto("app.wellness_checkins")
          .values({
            owner_user_id: owner,
            feeling_core: "sad",
            note: "Fictional newer observation",
            checked_in_at: new Date("2026-10-11T12:00:00Z")
          })
          .execute();
      }
    );
    const second = await page(new URLSearchParams({ limit: "50", cursor: first.nextCursor! }));
    expect(second.checkins).toHaveLength(50);
    expect(
      second.checkins.every((checkin) => !first.checkins.some((prior) => prior.id === checkin.id))
    ).toBe(true);
    expect(second.checkins[0]!.id < anchor.id).toBe(true);
  });

  it("rejects malformed, invalid-timestamp, invalid-id and changed-filter cursors", async () => {
    const first = await page(new URLSearchParams({ limit: "50", since }));
    const tokens = [
      "invalid-token",
      Buffer.from(
        JSON.stringify({ checkedInAt: "invalid", id: first.checkins[0]!.id, since })
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ checkedInAt: "2026-10-10T12:00:00.123456Z", id: "bad-id", since })
      ).toString("base64url")
    ];
    for (const cursor of tokens) {
      const response = await server.inject({
        method: "GET",
        url: `/api/wellness/checkins?${new URLSearchParams({ cursor, since })}`
      });
      expect(response.statusCode).toBe(400);
    }
    const changed = await server.inject({
      method: "GET",
      url: `/api/wellness/checkins?${new URLSearchParams({ cursor: first.nextCursor!, since: "2026-09-01T00:00:00Z" })}`
    });
    expect(changed.statusCode).toBe(400);
  });

  it("an owner cursor never exposes another owner's rows", async () => {
    const otherPage = await page(new URLSearchParams({ limit: "50" }), "other");
    expect(otherPage.checkins).toHaveLength(1);
    expect(otherPage.checkins[0]!.ownerUserId).toBe(other);
    expect(otherPage.nextCursor).toBeNull();
    const ownerPage = await page(new URLSearchParams({ limit: "50" }));
    const resumed = await page(
      new URLSearchParams({ limit: "50", cursor: ownerPage.nextCursor! }),
      "other"
    );
    expect(resumed.checkins.every((checkin) => checkin.ownerUserId === other)).toBe(true);
  });
});
