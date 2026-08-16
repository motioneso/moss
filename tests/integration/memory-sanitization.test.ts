import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { MemoryRepository, StubEmbeddingProvider } from "@moss/memory";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// ── MemoryRepository — chunk text NUL-byte sanitization (#1589) ────────────────

describe("MemoryRepository — chunk text sanitization", () => {
  const userId = "00000000-0000-4000-8000-000000000021";

  function ctx(actorUserId: string): AccessContext {
    return { actorUserId, requestId: "req:memory-sanitization-test" };
  }

  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, 'memory-sanitization@example.test', false)`,
        [userId]
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

  const repo = new MemoryRepository();
  const provider = new StubEmbeddingProvider();

  async function makeChunks(
    sourcePath: string,
    texts: string[]
  ): Promise<
    Array<{
      sourcePath: string;
      lineStart: number;
      lineEnd: number;
      contentHash: string;
      text: string;
      embedding: number[];
    }>
  > {
    return Promise.all(
      texts.map(async (text, i) => ({
        sourcePath,
        lineStart: i * 10,
        lineEnd: i * 10 + 5,
        contentHash: Buffer.from(text).toString("hex"),
        text,
        embedding: await provider.embedDocument(text)
      }))
    );
  }

  it("upsertFileChunks strips NUL bytes so the insert does not throw", async () => {
    const path = "notes/repo-test-nul-1.md";
    const chunks = await makeChunks(path, ["before\u0000after"]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, chunks, "stub", "0");
      const stored = await sql<{ text: string }>`
        SELECT text FROM app.memory_chunks WHERE source_path = ${path}
      `.execute(scopedDb.db);
      expect(stored.rows.map((r) => r.text)).toEqual(["beforeafter"]);
    });
  });

  it("upsertFileChunks does not lose existing chunks when a re-ingested file introduces a NUL byte", async () => {
    const path = "notes/repo-test-nul-2.md";
    const cleanChunks = await makeChunks(path, ["Chunk A", "Chunk B"]);
    const reingestedChunks = await makeChunks(path, ["Chunk A\u0000", "Chunk B"]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, cleanChunks, "stub", "0");
      await repo.upsertFileChunks(scopedDb, userId, path, reingestedChunks, "stub", "0");
      const stored = await sql<{ text: string }>`
        SELECT text FROM app.memory_chunks WHERE source_path = ${path}
      `.execute(scopedDb.db);
      expect(stored.rows).toHaveLength(2);
    });
  });

  it("upsertFileChunks preserves tab, newline, and carriage return in chunk text", async () => {
    const path = "notes/repo-test-nul-3.md";
    const text = "line one\tcol\nline two\r\n";
    const chunks = await makeChunks(path, [text]);
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      await repo.upsertFileChunks(scopedDb, userId, path, chunks, "stub", "0");
      const stored = await sql<{ text: string }>`
        SELECT text FROM app.memory_chunks WHERE source_path = ${path}
      `.execute(scopedDb.db);
      expect(stored.rows.map((r) => r.text)).toEqual([text]);
    });
  });
});
