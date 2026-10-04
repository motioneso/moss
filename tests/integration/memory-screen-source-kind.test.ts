import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { MemoryRepository } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2638 plan §4.1).
//
// Backtrack's screen history is embedded under a new memory source_kind, 'screen'. This file
// proves the widened CHECK (0281) and the new deleteChunksForSources primitive backtrack uses
// instead of ever touching app.memory_chunks itself.

const { Client } = pg;

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let bootstrap: pg.Client;
const repository = new MemoryRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});

afterAll(async () => {
  await appDb.destroy();
  await workerDb.destroy();
  await bootstrap.end();
});

async function insertChunk(
  ownerUserId: string,
  sourceKind: string,
  sourcePath: string
): Promise<string> {
  const id = randomUUID();
  await bootstrap.query(
    `INSERT INTO app.memory_chunks
       (id, owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
     VALUES ($1, $2, $3, $4, 0, 0, 'hash', 'chunk text')`,
    [id, ownerUserId, sourceKind, sourcePath]
  );
  return id;
}

async function stillExists(id: string): Promise<boolean> {
  const result = await bootstrap.query<{ id: string }>(
    `SELECT id::text FROM app.memory_chunks WHERE id = $1`,
    [id]
  );
  return result.rows.length === 1;
}

describe("memory_chunks source_kind CHECK", () => {
  it("the migration 0281 file is applied", async () => {
    const result = await bootstrap.query<{ name: string }>(
      `SELECT name FROM app.schema_migrations WHERE version = '0281'`
    );
    expect(result.rows).toEqual([{ name: "0281_memory_screen_source_kind.sql" }]);
  });

  it("the pre-migration constraint rejected 'screen'; the migrated constraint accepts it", async () => {
    // Reproduce the pre-0281 constraint to prove this migration is what fixes it, then restore
    // the real migrated constraint in a `finally` so later tests in this file see the real state.
    await bootstrap.query(
      `ALTER TABLE app.memory_chunks DROP CONSTRAINT memory_chunks_source_kind_check`
    );
    await bootstrap.query(`
      ALTER TABLE app.memory_chunks ADD CONSTRAINT memory_chunks_source_kind_check
      CHECK (source_kind IN ('vault', 'connector', 'chat', 'notes'))
    `);
    try {
      await expect(
        bootstrap.query(
          `INSERT INTO app.memory_chunks
             (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
           VALUES ($1, 'screen', 'backtrack/pre-migration-check', 0, 0, 'hash', 'text')`,
          [ids.userA]
        )
      ).rejects.toThrow(/memory_chunks_source_kind_check/);
    } finally {
      await bootstrap.query(
        `ALTER TABLE app.memory_chunks DROP CONSTRAINT memory_chunks_source_kind_check`
      );
      await bootstrap.query(`
        ALTER TABLE app.memory_chunks ADD CONSTRAINT memory_chunks_source_kind_check
        CHECK (source_kind IN ('vault', 'connector', 'chat', 'notes', 'screen'))
      `);
    }

    await bootstrap.query(
      `INSERT INTO app.memory_chunks
         (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
       VALUES ($1, 'screen', 'backtrack/post-migration-check', 0, 0, 'hash', 'text')`,
      [ids.userA]
    );
  });
});

describe("MemoryRepository.deleteChunksForSources", () => {
  it("removes only the named paths of the named kind for the actor (jarvis_app_runtime)", async () => {
    const keepSamePathOtherKind = await insertChunk(ids.userA, "vault", "backtrack/app-1");
    const keepOtherPath = await insertChunk(ids.userA, "screen", "backtrack/app-2");
    const keepOtherOwner = await insertChunk(ids.userB, "screen", "backtrack/app-1");
    const removed = await insertChunk(ids.userA, "screen", "backtrack/app-1");

    const deleted = await new DataContextRunner(appDb).withDataContext(
      { actorUserId: ids.userA, requestId: "test:memory-screen-app" },
      (scopedDb) =>
        repository.deleteChunksForSources(scopedDb, ids.userA, ["backtrack/app-1"], "screen")
    );

    expect(deleted).toBe(1);
    expect(await stillExists(removed)).toBe(false);
    expect(await stillExists(keepSamePathOtherKind)).toBe(true);
    expect(await stillExists(keepOtherPath)).toBe(true);
    expect(await stillExists(keepOtherOwner)).toBe(true);
  });

  it("removes only the named paths of the named kind for the actor (jarvis_worker_runtime)", async () => {
    const keepSamePathOtherKind = await insertChunk(ids.userA, "vault", "backtrack/worker-1");
    const keepOtherPath = await insertChunk(ids.userA, "screen", "backtrack/worker-2");
    const keepOtherOwner = await insertChunk(ids.userB, "screen", "backtrack/worker-1");
    const removed = await insertChunk(ids.userA, "screen", "backtrack/worker-1");

    const deleted = await new DataContextRunner(workerDb).withDataContext(
      { actorUserId: ids.userA, requestId: "test:memory-screen-worker" },
      (scopedDb) =>
        repository.deleteChunksForSources(scopedDb, ids.userA, ["backtrack/worker-1"], "screen")
    );

    expect(deleted).toBe(1);
    expect(await stillExists(removed)).toBe(false);
    expect(await stillExists(keepSamePathOtherKind)).toBe(true);
    expect(await stillExists(keepOtherPath)).toBe(true);
    expect(await stillExists(keepOtherOwner)).toBe(true);
  });

  it("deletes nothing when the owner passed does not match the acting actor", async () => {
    const otherOwnersChunk = await insertChunk(ids.userB, "screen", "backtrack/cross-owner");

    const deleted = await new DataContextRunner(appDb).withDataContext(
      { actorUserId: ids.userA, requestId: "test:memory-screen-cross-owner" },
      (scopedDb) =>
        repository.deleteChunksForSources(scopedDb, ids.userB, ["backtrack/cross-owner"], "screen")
    );

    expect(deleted).toBe(0);
    expect(await stillExists(otherOwnersChunk)).toBe(true);
  });

  it("rejects more than 500 source paths in one call", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `backtrack/${i}`);

    await expect(
      new DataContextRunner(appDb).withDataContext(
        { actorUserId: ids.userA, requestId: "test:memory-screen-cap" },
        (scopedDb) => repository.deleteChunksForSources(scopedDb, ids.userA, tooMany, "screen")
      )
    ).rejects.toThrow(/at most 500/);
  });
});
