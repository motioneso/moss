import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BacktrackRepository } from "@moss/backtrack";
import { indexBacktrackSegments, runBacktrackUpkeep } from "@moss/backtrack/workers";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { PgBoss } from "@moss/jobs";
import {
  MemoryRepository,
  MemoryRetriever,
  StubEmbeddingProvider,
  type EmbeddingProvider
} from "@moss/memory";
import { RecallService } from "@moss/chat";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2638 plan §4.5/§4.6).
//
// The index job and the hourly upkeep, run against the worker role exactly as apps/worker does.
// Embeddings come from memory's own deterministic StubEmbeddingProvider (a hash of the text), so
// a query for a segment's exact text is its best possible match.

const { Client } = pg;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let workerDb: Kysely<MossDatabase>;
let appDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
let bootstrap: pg.Client;
const repository = new BacktrackRepository();
const memory = new MemoryRepository();
const provider = new StubEmbeddingProvider();
const OWNER_A = ids.userA;
const OWNER_B = ids.userB;

beforeAll(async () => {
  await resetFoundationDatabase();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(workerDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});

beforeEach(async () => {
  await bootstrap.query("DELETE FROM app.backtrack_segments");
  await bootstrap.query("DELETE FROM app.backtrack_deletions");
  await bootstrap.query("DELETE FROM app.memory_chunks");
});

afterAll(async () => {
  await Promise.allSettled([workerDb?.destroy(), appDb?.destroy(), bootstrap?.end()]);
});

interface SeedOptions {
  readonly owner?: string;
  readonly startedAgo?: number;
  readonly createdAgo?: number;
  readonly windowTitle?: string;
  readonly address?: string | null;
  readonly body?: string;
  readonly indexed?: boolean;
}

/** Writes a segment as the superuser so `created_at` and `started_at` can be placed anywhere. */
async function seed(options: SeedOptions = {}): Promise<string> {
  const id = randomUUID();
  const startedAgo = options.startedAgo ?? 5 * MINUTE;
  const createdAgo = options.createdAgo ?? 0;
  await bootstrap.query(
    `INSERT INTO app.backtrack_segments
       (id, owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
        address, body, body_hash, indexed_at, created_at, client_started_at)
     VALUES ($1, $2, $3,
       now() - ($4 || ' milliseconds')::interval,
       now() - ($4 || ' milliseconds')::interval + interval '10 seconds',
       'Safari', 'com.apple.Safari', $5, $6, $7, $8,
       CASE WHEN $9::boolean THEN now() ELSE NULL END,
       now() - ($10 || ' milliseconds')::interval, now())`,
    [
      id,
      options.owner ?? OWNER_A,
      randomUUID(),
      String(startedAgo),
      options.windowTitle ?? "A page",
      options.address === undefined ? "https://example.test" : options.address,
      options.body ?? `body ${id}`,
      randomBytes(32),
      options.indexed ?? false,
      String(createdAgo)
    ]
  );
  return id;
}

async function seedScreenChunk(owner: string, segmentId: string): Promise<void> {
  await bootstrap.query(
    `INSERT INTO app.memory_chunks
       (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
     VALUES ($1, 'screen', $2, 0, 0, 'hash', 'chunk text')`,
    [owner, `backtrack/${segmentId}`]
  );
}

async function chunkRows(owner?: string) {
  const result = await bootstrap.query<{ source_kind: string; source_path: string; text: string }>(
    `SELECT source_kind, source_path, text FROM app.memory_chunks
      ${owner ? "WHERE owner_user_id = $1" : ""} ORDER BY source_path, line_start`,
    owner ? [owner] : []
  );
  return result.rows;
}

async function segmentRow(id: string) {
  const result = await bootstrap.query<{ indexed_at: Date | null }>(
    "SELECT indexed_at FROM app.backtrack_segments WHERE id = $1",
    [id]
  );
  return result.rows[0] ?? null;
}

function indexAs(
  owner: string,
  segmentIds: readonly string[],
  embedding: EmbeddingProvider = provider,
  db: Kysely<MossDatabase> = workerDb
) {
  return new DataContextRunner(db).withDataContext(
    { actorUserId: owner, requestId: "test:backtrack-index" },
    (scopedDb) =>
      indexBacktrackSegments(scopedDb, owner, segmentIds, {
        repository,
        memory,
        embeddingProviderFactory: async () => embedding
      })
  );
}

describe("backtrack.index", () => {
  it("embeds a segment under source kind screen and stamps indexed_at", async () => {
    const id = await seed({
      windowTitle: "Quarterly plan",
      address: "https://x.test/p",
      body: "revenue"
    });
    expect(await indexAs(OWNER_A, [id])).toBe(1);

    const rows = await chunkRows(OWNER_A);
    expect(rows).toEqual([
      {
        source_kind: "screen",
        source_path: `backtrack/${id}`,
        text: "Quarterly plan\nhttps://x.test/p\nrevenue"
      }
    ]);
    expect((await segmentRow(id))?.indexed_at).not.toBeNull();
  });

  it("indexes only the actor's rows, even when the payload lists someone else's", async () => {
    const mine = await seed({ owner: OWNER_A });
    const theirs = await seed({ owner: OWNER_B });

    expect(await indexAs(OWNER_A, [mine, theirs])).toBe(1);

    expect(await chunkRows(OWNER_B)).toHaveLength(0);
    expect((await segmentRow(theirs))?.indexed_at).toBeNull();
    expect((await chunkRows(OWNER_A)).map((row) => row.source_path)).toEqual([`backtrack/${mine}`]);
  });

  it("gives a segment deleted before the job runs no chunk", async () => {
    const id = await seed();
    await bootstrap.query("DELETE FROM app.backtrack_segments WHERE id = $1", [id]);
    expect(await indexAs(OWNER_A, [id])).toBe(0);
    expect(await chunkRows()).toHaveLength(0);
  });

  it("gives a segment past the 37-day cutoff no chunk, by started_at and by created_at", async () => {
    const byStarted = await seed({ startedAgo: 37 * DAY + MINUTE });
    const byCreated = await seed({ createdAgo: 37 * DAY + MINUTE });
    const young = await seed({ startedAgo: 37 * DAY - HOUR, createdAgo: 37 * DAY - HOUR });

    expect(await indexAs(OWNER_A, [byStarted, byCreated, young])).toBe(1);

    expect((await chunkRows()).map((row) => row.source_path)).toEqual([`backtrack/${young}`]);
    expect((await segmentRow(byStarted))?.indexed_at).toBeNull();
    expect((await segmentRow(byCreated))?.indexed_at).toBeNull();
  });

  it("re-running replaces a segment's chunks rather than duplicating them", async () => {
    const id = await seed({ body: "word ".repeat(1500) });
    await indexAs(OWNER_A, [id]);
    const first = await chunkRows();
    expect(first.length).toBeGreaterThan(1);
    expect(new Set(first.map((row) => row.source_path))).toEqual(new Set([`backtrack/${id}`]));

    await indexAs(OWNER_A, [id]);
    expect(await chunkRows()).toHaveLength(first.length);
  });

  it("rejects a payload that is not a short list of UUIDs", async () => {
    await expect(indexAs(OWNER_A, ["not-a-uuid"])).rejects.toThrow(/segmentIds/);
    const tooMany = Array.from({ length: 201 }, () => randomUUID());
    await expect(indexAs(OWNER_A, tooMany)).rejects.toThrow(/segmentIds/);
  });
});

describe("the owner lock (decision 3)", () => {
  /** An embedding provider whose embedDocument waits on a gate, to hold the index transaction open. */
  function gatedProvider() {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const gated: EmbeddingProvider = {
      dimensions: provider.dimensions,
      modelName: provider.modelName,
      modelVersion: provider.modelVersion,
      embedQuery: (text) => provider.embedQuery(text),
      embedDocument: async (text) => {
        entered();
        await gate;
        return provider.embedDocument(text);
      }
    };
    return { gated, release, reached };
  }

  const settles = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
    ]);

  it("a delete racing a queued index job leaves no chunk", async () => {
    const id = await seed();
    let releaseDelete!: () => void;
    const hold = new Promise<void>((resolve) => (releaseDelete = resolve));
    let deleteHasLock!: () => void;
    const locked = new Promise<void>((resolve) => (deleteHasLock = resolve));

    // Connection 1: the user delete, holding the owner lock after removing the row.
    const deleting = new DataContextRunner(workerDb).withDataContext(
      { actorUserId: OWNER_A, requestId: "test:race-delete" },
      async (scopedDb) => {
        await repository.lockOwner(scopedDb, OWNER_A);
        const removed = await repository.deleteSegmentsInRange(scopedDb, OWNER_A, {
          from: null,
          to: null
        });
        deleteHasLock();
        await hold;
        return removed;
      }
    );
    await locked;

    // Connection 2: the queued index job arrives while the delete is still open.
    const indexing = indexAs(OWNER_A, [id]);
    expect(await settles(indexing, 400)).toBe(false); // it is waiting on the lock

    releaseDelete();
    expect(await deleting).toEqual([id]);
    expect(await indexing).toBe(0);
    expect(await chunkRows()).toHaveLength(0);
  });

  it("the hourly purge waits for an index job already running, then removes what it wrote", async () => {
    const live = await seed();
    const expired = await seed({ startedAgo: 38 * DAY });
    const { gated, release, reached } = gatedProvider();

    const indexing = indexAs(OWNER_A, [live], gated);
    await reached; // the index transaction now holds the owner lock

    const upkeep = runBacktrackUpkeep({
      rootDb: workerDb,
      dataContext: runner,
      boss: { send: vi.fn() } as unknown as PgBoss
    });
    expect(await settles(upkeep, 400)).toBe(false);
    expect(await segmentRow(expired)).not.toBeNull(); // not purged while the lock is held

    release();
    await indexing;
    const stats = await upkeep;
    expect(stats.deletedSegments).toBe(1);
    expect(await segmentRow(expired)).toBeNull();
    expect((await chunkRows()).map((row) => row.source_path)).toEqual([`backtrack/${live}`]);
  });
});

describe("passive recall never returns screen history", () => {
  it("retrieve with no kind skips a screen chunk that is the exact match", async () => {
    const text = "the exact words on the screen";
    const id = await seed({ windowTitle: text, address: null, body: "" });
    await indexAs(OWNER_A, [id]);
    expect((await chunkRows()).map((row) => row.text)).toEqual([text]);

    // A vault note that does embed, so "nothing came back" can't be mistaken for an empty index.
    await runner.withDataContext(
      { actorUserId: OWNER_A, requestId: "test:vault-note" },
      async (db) =>
        memory.upsertFileChunks(
          db,
          OWNER_A,
          "note.md",
          [
            {
              sourcePath: "note.md",
              lineStart: 0,
              lineEnd: 0,
              contentHash: "h",
              text: "an unrelated note",
              embedding: await provider.embedDocument("an unrelated note")
            }
          ],
          provider.modelName,
          provider.modelVersion,
          "vault"
        )
    );

    const retriever = new MemoryRetriever(provider, memory);
    const found = await new DataContextRunner(appDb).withDataContext(
      { actorUserId: OWNER_A, requestId: "test:passive-recall" },
      async (scopedDb) => ({
        semantic: await retriever.retrieve(scopedDb, text),
        screen: await retriever.retrieve(scopedDb, text, 5, "screen")
      })
    );

    // The screen chunk is a similarity-1 match for this query, and is only reachable by asking
    // for its kind. Fails if the default kind is widened to include it.
    expect(found.semantic.map((chunk) => chunk.text)).toEqual(["an unrelated note"]);
    expect(found.screen.map((chunk) => chunk.text)).toEqual([text]);
  });

  it("chat recall skips a screen chunk that is the exact match for its query", async () => {
    // The chat recall port queries for "past conversations"; a segment whose text is exactly that
    // embeds to the identical vector, so it would rank first if kinds were not separated.
    const id = await seed({ windowTitle: "past conversations", address: null, body: "" });
    await indexAs(OWNER_A, [id]);
    expect(await chunkRows(OWNER_A)).toHaveLength(1);

    const recall = new RecallService(new DataContextRunner(appDb), provider);
    const result = await recall.recall(OWNER_A);
    expect(result.episodicChunks).toEqual([]);
  });
});

describe("backtrack.upkeep", () => {
  const send = vi.fn(async () => "job-id");
  const boss = { send } as unknown as PgBoss;
  const upkeep = () => runBacktrackUpkeep({ rootDb: workerDb, dataContext: runner, boss });

  beforeEach(() => {
    send.mockClear();
  });

  it("removes a segment at 37 days by started_at and keeps one at 36 days 23 hours", async () => {
    const kept = await seed({ startedAgo: 36 * DAY + 23 * HOUR, indexed: true });
    const gone = await seed({ startedAgo: 37 * DAY + MINUTE, indexed: true });
    await seedScreenChunk(OWNER_A, kept);
    await seedScreenChunk(OWNER_A, gone);

    const stats = await upkeep();

    expect(stats).toMatchObject({ deletedSegments: 1, deletedChunks: 1 });
    expect(await segmentRow(kept)).not.toBeNull();
    expect(await segmentRow(gone)).toBeNull();
    expect((await chunkRows()).map((row) => row.source_path)).toEqual([`backtrack/${kept}`]);
  });

  it("removes a segment at 37 days by created_at, even with a start time in the future", async () => {
    const future = async (createdAgo: number) => {
      const id = await seed({ createdAgo, indexed: true });
      await bootstrap.query(
        `UPDATE app.backtrack_segments
            SET started_at = now() + interval '2 days', ended_at = now() + interval '2 days'
          WHERE id = $1`,
        [id]
      );
      return id;
    };
    const kept = await future(36 * DAY + 23 * HOUR);
    const gone = await future(37 * DAY + MINUTE);
    await seedScreenChunk(OWNER_A, gone);

    await upkeep();

    expect(await segmentRow(kept)).not.toBeNull();
    expect(await segmentRow(gone)).toBeNull();
    expect(await chunkRows()).toHaveLength(0);
  });

  it("leaves another owner's fresh rows alone while purging an expired one of their own", async () => {
    const aFresh = await seed({ owner: OWNER_A, indexed: true });
    const bFresh = await seed({ owner: OWNER_B, indexed: true });
    const aOld = await seed({ owner: OWNER_A, startedAgo: 40 * DAY, indexed: true });
    await seedScreenChunk(OWNER_A, aFresh);
    await seedScreenChunk(OWNER_B, bFresh);
    await seedScreenChunk(OWNER_A, aOld);

    await upkeep();

    expect(await segmentRow(aFresh)).not.toBeNull();
    expect(await segmentRow(bFresh)).not.toBeNull();
    expect(await segmentRow(aOld)).toBeNull();
    expect((await chunkRows(OWNER_B)).map((row) => row.source_path)).toEqual([
      `backtrack/${bFresh}`
    ]);
    expect((await chunkRows(OWNER_A)).map((row) => row.source_path)).toEqual([
      `backtrack/${aFresh}`
    ]);
  });

  it("runs with the storage switch off", async () => {
    const original = process.env.MOSS_BACKTRACK_STORAGE;
    process.env.MOSS_BACKTRACK_STORAGE = "off";
    try {
      const gone = await seed({ startedAgo: 38 * DAY, indexed: true });
      await upkeep();
      expect(await segmentRow(gone)).toBeNull();
    } finally {
      if (original === undefined) delete process.env.MOSS_BACKTRACK_STORAGE;
      else process.env.MOSS_BACKTRACK_STORAGE = original;
    }
  });

  it("re-enqueues a segment still unindexed after ten minutes, once, and not the others", async () => {
    const stale = await seed({ createdAgo: 11 * MINUTE });
    await seed({ createdAgo: MINUTE }); // too new
    await seed({ createdAgo: 30 * MINUTE, indexed: true }); // already indexed

    const stats = await upkeep();

    expect(stats.enqueuedSegments).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("backtrack.index", {
      actorUserId: OWNER_A,
      segmentIds: [stale]
    });

    // Once the job has indexed it, the next hourly run has nothing to send.
    await indexAs(OWNER_A, [stale]);
    send.mockClear();
    await upkeep();
    expect(send).not.toHaveBeenCalled();
  });

  it("enqueues stale segments in batches of at most 200", async () => {
    await bootstrap.query(
      `INSERT INTO app.backtrack_segments
         (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title, body,
          body_hash, created_at, client_started_at)
       SELECT $1, gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour',
              'Safari', 'com.apple.Safari', 't', 'b', decode(md5(random()::text || g::text) || md5(g::text || random()::text), 'hex'),
              now() - interval '20 minutes', now() - (g || ' seconds')::interval
         FROM generate_series(1, 250) AS g`,
      [OWNER_A]
    );

    const stats = await upkeep();

    expect(stats.enqueuedSegments).toBe(250);
    const sizes = send.mock.calls.map(
      (call) => ((call as unknown[])[1] as { segmentIds: string[] }).segmentIds.length
    );
    expect(sizes).toEqual([200, 50]);
  });

  it("removes a 38-day-old deletion marker and keeps a younger one", async () => {
    await bootstrap.query(
      `INSERT INTO app.backtrack_deletions (owner_user_id, range, created_at) VALUES
         ($1, tstzrange(NULL, now() - interval '38 days', '[)'), now() - interval '38 days 1 minute'),
         ($1, tstzrange(NULL, now() - interval '37 days', '[)'), now() - interval '37 days 23 hours')`,
      [OWNER_A]
    );

    const stats = await upkeep();

    expect(stats.deletedMarkers).toBe(1);
    const left = await bootstrap.query("SELECT count(*)::int AS n FROM app.backtrack_deletions");
    expect(left.rows[0]?.n).toBe(1);
  });

  it("does not let one owner's failure stop the others, and fails the job for a retry", async () => {
    const aOld = await seed({ owner: OWNER_A, startedAgo: 40 * DAY, indexed: true });
    const bOld = await seed({ owner: OWNER_B, startedAgo: 40 * DAY, indexed: true });
    const flaky = {
      deleteChunksForSources: vi.fn(
        async (_db: unknown, owner: string, paths: readonly string[], kind: string) => {
          if (owner === OWNER_A) throw new Error("boom");
          return memory.deleteChunksForSources(_db as never, owner, paths, kind);
        }
      )
    };

    await expect(
      runBacktrackUpkeep({ rootDb: workerDb, dataContext: runner, boss, memory: flaky })
    ).rejects.toThrow(/1 of 2 owners/);

    expect(await segmentRow(bOld)).toBeNull();
    expect(await segmentRow(aOld)).not.toBeNull(); // A's transaction rolled back whole
  });
});
