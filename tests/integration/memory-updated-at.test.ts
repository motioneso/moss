import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { MemoryRepository, StubEmbeddingProvider } from "@moss/memory";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;
const userId = "00000000-0000-4000-8000-000000000011";
const access: AccessContext = { actorUserId: userId, requestId: "memory-updated-at-test" };
const provider = new StubEmbeddingProvider();
const repo = new MemoryRepository();

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false)",
      [userId, "memory-updated-at@example.test"]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb.destroy();
});

it("vectorSearch exposes updatedAt matching memory_chunks.updated_at", async () => {
  const path = "notes/repo-test-updated-at.md";
  const text = "Freshly ingested content";
  const vector = await provider.embedDocument(text);

  await dataContext.withDataContext(access, (scopedDb) =>
    repo.upsertFileChunks(
      scopedDb,
      userId,
      path,
      [
        {
          sourcePath: path,
          lineStart: 1,
          lineEnd: 1,
          contentHash: "updated-at",
          text,
          embedding: vector
        }
      ],
      "stub",
      "0"
    )
  );

  await dataContext.withDataContext(access, async (scopedDb) => {
    const row = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM app.memory_chunks WHERE source_path = ${path}
    `.execute(scopedDb.db);
    const results = await repo.vectorSearch(scopedDb, await provider.embedQuery(text), 10);
    const match = results.find((result) => result.sourcePath === path);

    expect(match?.updatedAt).toBeInstanceOf(Date);
    expect(match?.updatedAt.getTime()).toBe(row.rows[0]?.updated_at.getTime());
  });
});
