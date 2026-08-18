import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import type * as NodeFsPromises from "node:fs/promises";
import pg from "pg";

// TOCTOU test support (the two "narrows the TOCTOU window" tests below): vi.spyOn cannot patch the
// "node:fs/promises" namespace directly (ESM module namespaces aren't configurable), so realpath is
// routed through this mock via vi.mock instead. Every other export, and every call to realpath
// outside those two tests, passes through to the real implementation untouched. vi.hoisted is
// required (not a plain top-level const) because vi.mock factories are hoisted above all imports,
// including any plain variable declarations that would otherwise sit below them. Same technique as
// tests/integration/notes-write-tools.test.ts.
type FsPromises = typeof NodeFsPromises;

const fsMocks = vi.hoisted(() => ({
  realpathMock: vi.fn(),
  actualFs: undefined as unknown
}));
const { realpathMock } = fsMocks;
function actualFs(): FsPromises {
  return fsMocks.actualFs as FsPromises;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<FsPromises>();
  fsMocks.actualFs = actual;
  fsMocks.realpathMock.mockImplementation(actual.realpath);
  return {
    ...actual,
    realpath: (...args: Parameters<FsPromises["realpath"]>) => fsMocks.realpathMock(...args)
  };
});

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { parseDocument, StubEmbeddingProvider } from "@moss/memory";
import { PreferencesRepository } from "@moss/structured-state";
import {
  handleNotesSyncJob,
  handleNotesSyncJobWithDataContext,
  writeNotesLastSync,
  registerNotesJobWorkers,
  NOTES_SYNC_QUEUE,
  type NotesSyncJobPayload
} from "@moss/notes";
import { createPgBossClient, sendJob } from "@moss/jobs";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// ── handleNotesSyncJob (worker integration) ───────────────────────────────────

describe("handleNotesSyncJob", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let workerDb: Kysely<MossDatabase>;
  let workerDataContext: DataContextRunner;
  let workerBoss: PgBoss;
  const provider = new StubEmbeddingProvider();
  const prefsRepo = new PreferencesRepository();
  const jobUserId = "00000000-0000-4000-8100-000000000099";
  let jobNotesDir: string;

  function makeJob(sourcePath: string): Job<NotesSyncJobPayload> {
    return {
      id: randomUUID(),
      data: { actorUserId: jobUserId, sourcePath }
    } as unknown as Job<NotesSyncJobPayload>;
  }

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });

    jobNotesDir = join(tmpdir(), `jarv1s-notes-worker-${randomUUID()}`);
    await mkdir(jobNotesDir, { recursive: true });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, 'notes-worker@example.test', false) ON CONFLICT DO NOTHING`,
        [jobUserId]
      );
    } finally {
      await client.end();
    }

    dataContext = new DataContextRunner(appDb);
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    workerDataContext = new DataContextRunner(workerDb);
    workerBoss = createPgBossClient(connectionStrings.worker, { connectionTimeoutMillis: 25_000 });
    await workerBoss.start();
    process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
  });

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false });
    await workerDb?.destroy();
    await appDb?.destroy();
    await rm(jobNotesDir, { recursive: true, force: true });
    delete process.env["JARVIS_NOTES_ROOTS"];
  });

  it("ingests markdown files and stores chunks with source_kind=notes", async () => {
    await writeFile(join(jobNotesDir, "hello.md"), "# Hello\n\nThis is a test note.\n");
    await writeFile(join(jobNotesDir, "world.md"), "# World\n\n## Section\n\nMore content.\n");

    const result = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-test" },
      (scopedDb) => handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
    );

    expect(result.ingested).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("dispatches every oversized-file continuation through the registered worker", async () => {
    const largeNotesDir = join(jobNotesDir, `oversized-${randomUUID()}`);
    const largeFile = join(largeNotesDir, "note.md");
    const content = `# Oversized note\n${"x".repeat(500_000)}\n`;
    await mkdir(largeNotesDir, { recursive: true });
    await writeFile(largeFile, content);
    const expectedChunkCount = parseDocument(content).chunks.length;

    const workIds = await registerNotesJobWorkers(workerBoss, workerDataContext, {
      embeddingProviderFactory: async () => provider,
      preferencesRepository: prefsRepo
    });

    try {
      const rootJobId = await sendJob(
        workerBoss,
        NOTES_SYNC_QUEUE,
        {
          actorUserId: jobUserId,
          sourcePath: largeNotesDir
        },
        { singletonKey: `notes-sync:${jobUserId}` }
      );
      expect(rootJobId).toEqual(expect.any(String));

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await client.query<{
            completed: string;
            pending: string;
            chunks: string;
          }>(
            `SELECT
               count(*) FILTER (WHERE name = $1 AND state = 'completed')::text AS completed,
               count(*) FILTER (WHERE name = $1 AND state IN ('created', 'active'))::text AS pending,
               count(*) FILTER (WHERE source_path = $2)::text AS chunks
             FROM pgboss.job
             CROSS JOIN LATERAL (VALUES (data->>'filePath')) AS files(source_path)
             WHERE name = $1 OR source_path = $2`,
            [NOTES_SYNC_QUEUE, await realpath(largeFile)]
          );
          const row = result.rows[0]!;
          if (Number(row.completed) > 1 && row.pending === "0") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const chunks = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM app.memory_chunks
            WHERE owner_user_id = $1
              AND source_kind = 'notes'
              AND source_path = $2`,
          [jobUserId, await realpath(largeFile)]
        );
        expect(Number(chunks.rows[0]?.count)).toBe(expectedChunkCount);

        const jobs = await client.query<{ state: string; count: string }>(
          `SELECT state, count(*)::text AS count
             FROM pgboss.job
            WHERE name = $1
              AND (data->>'sourcePath' = $2 OR data->>'filePath' = $3)
            GROUP BY state`,
          [NOTES_SYNC_QUEUE, jobNotesDir, await realpath(largeFile)]
        );
        expect(jobs.rows).toHaveLength(1);
        expect(jobs.rows[0]).toEqual({ state: "completed", count: expect.any(String) });
        expect(Number(jobs.rows[0]?.count)).toBeGreaterThan(1);
      } finally {
        await client.end();
      }
    } finally {
      await rm(largeNotesDir, { recursive: true, force: true });
      await Promise.all(
        workIds.map((workId) => workerBoss.offWork(NOTES_SYNC_QUEUE, { id: workId, wait: true }))
      );
    }
  });

  it("skips unchanged files on re-run", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-skip" },
      (scopedDb) => handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
    );

    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toBe(0);
  });

  it("re-ingests when file content changes", async () => {
    await writeFile(join(jobNotesDir, "hello.md"), "# Hello\n\nContent was updated.\n");

    const result = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-update" },
      (scopedDb) => handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
    );

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("walks subdirectories recursively", async () => {
    const subDir = join(jobNotesDir, "subdir");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "nested.md"), "# Nested note\n\nDeep content.\n");

    const result = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-nested" },
      (scopedDb) => handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
    );

    expect(result.ingested).toBeGreaterThanOrEqual(1);
  });

  it("worker role stores wikilinks for notes files", async () => {
    const linkFile = join(jobNotesDir, `worker-link-${randomUUID()}.md`);
    await writeFile(linkFile, "# Worker link\n\nReferences [[Daily Plan]].\n");

    const result = await handleNotesSyncJobWithDataContext(
      makeJob(jobNotesDir),
      workerDataContext,
      async () => provider,
      prefsRepo
    );

    expect(result.errors).toBe(0);
    expect(result.ingested).toBeGreaterThanOrEqual(1);

    const resolvedLinkFile = await realpath(linkFile);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const links = await client.query<{ to_path: string }>(
        `SELECT to_path
           FROM app.memory_links
          WHERE owner_user_id = $1 AND from_path = $2
          ORDER BY to_path`,
        [jobUserId, resolvedLinkFile]
      );
      expect(links.rows.map((row) => row.to_path)).toContain("Daily Plan");
    } finally {
      await client.end();
    }
  });

  it("commits other files when one file hits a database write error", async () => {
    const isolatedDir = join(tmpdir(), `jarv1s-notes-partial-${randomUUID()}`);
    await mkdir(isolatedDir, { recursive: true });
    await writeFile(join(isolatedDir, "good-before.md"), "# Good before\n\nSafe content.\n");
    await writeFile(join(isolatedDir, "bad-vector.md"), "# Bad\n\nbad vector content.\n");
    await writeFile(join(isolatedDir, "good-after.md"), "# Good after\n\nMore safe content.\n");

    const badVectorProvider = new (class extends StubEmbeddingProvider {
      override async embedDocument(text: string): Promise<number[]> {
        if (text.includes("bad vector content")) return [0];
        return super.embedDocument(text);
      }
    })();

    process.env["JARVIS_NOTES_ROOTS"] = isolatedDir;
    try {
      const result = await handleNotesSyncJobWithDataContext(
        makeJob(isolatedDir),
        workerDataContext,
        async () => badVectorProvider,
        prefsRepo
      );

      expect(result.ingested).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(1);

      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        const chunks = await client.query<{ source_path: string }>(
          `SELECT source_path
             FROM app.memory_chunks
            WHERE owner_user_id = $1
              AND source_kind = 'notes'
              AND source_path LIKE $2
            ORDER BY source_path`,
          [jobUserId, `${isolatedDir}%`]
        );
        expect(chunks.rows.map((row) => row.source_path.split("/").pop())).toEqual([
          "good-after.md",
          "good-before.md"
        ]);
      } finally {
        await client.end();
      }
    } finally {
      await rm(isolatedDir, { recursive: true, force: true });
      process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
    }
  });

  it("narrows the TOCTOU window: handleNotesSyncJob target swapped to a symlink after the initial check, before ingest", async () => {
    const outside = join(tmpdir(), `jarv1s-notes-outside-toctou6-${randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret6.md"), "TOP SECRET worker payload 6");

    const isolatedDir = join(tmpdir(), `jarv1s-notes-toctou6-${randomUUID()}`);
    await mkdir(isolatedDir, { recursive: true });
    const targetPath = join(isolatedDir, "note6.md");
    await writeFile(targetPath, "safe content 6");

    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === targetPath) {
        await rm(targetPath, { force: true });
        await symlink(join(outside, "secret6.md"), targetPath);
      }
      return resolved;
    });

    process.env["JARVIS_NOTES_ROOTS"] = isolatedDir;
    try {
      await expect(
        dataContext.withDataContext(
          { actorUserId: jobUserId, requestId: "req:worker-toctou6" },
          (scopedDb) => handleNotesSyncJob(makeJob(isolatedDir), scopedDb, provider, prefsRepo)
        )
      ).rejects.toThrow("path is not within the linked notes source");
      await expect(readFile(join(outside, "secret6.md"), "utf-8")).resolves.toBe(
        "TOP SECRET worker payload 6"
      );
    } finally {
      realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) =>
        actualFs().realpath(p)
      );
      process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
      await rm(isolatedDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("narrows the TOCTOU window: handleNotesSyncJobWithDataContext target swapped across the withDataContext boundary", async () => {
    const outside = join(tmpdir(), `jarv1s-notes-outside-toctou7-${randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret7.md"), "TOP SECRET worker payload 7");

    const isolatedDir = join(tmpdir(), `jarv1s-notes-toctou7-${randomUUID()}`);
    await mkdir(isolatedDir, { recursive: true });
    const targetPath = join(isolatedDir, "note7.md");
    await writeFile(targetPath, "safe content 7");

    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === targetPath) {
        await rm(targetPath, { force: true });
        await symlink(join(outside, "secret7.md"), targetPath);
      }
      return resolved;
    });

    process.env["JARVIS_NOTES_ROOTS"] = isolatedDir;
    try {
      await expect(
        handleNotesSyncJobWithDataContext(
          makeJob(isolatedDir),
          workerDataContext,
          async () => provider,
          prefsRepo
        )
      ).rejects.toThrow("path is not within the linked notes source");
      await expect(readFile(join(outside, "secret7.md"), "utf-8")).resolves.toBe(
        "TOP SECRET worker payload 7"
      );
    } finally {
      realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) =>
        actualFs().realpath(p)
      );
      process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
      await rm(isolatedDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("throws when JARVIS_NOTES_ROOTS is not configured", async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    await expect(
      dataContext.withDataContext(
        { actorUserId: jobUserId, requestId: "req:worker-no-roots" },
        (scopedDb) => handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
      )
    ).rejects.toThrow("JARVIS_NOTES_ROOTS not configured");
    process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
  });

  it("throws when sourcePath is not within any allowed root", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;
    await expect(
      dataContext.withDataContext(
        { actorUserId: jobUserId, requestId: "req:worker-escape" },
        (scopedDb) => handleNotesSyncJob(makeJob("/etc"), scopedDb, provider, prefsRepo)
      )
    ).rejects.toThrow("not within any allowed root");
  });

  it("writes notes-last-sync on success with the real counts (#449)", async () => {
    await writeFile(join(jobNotesDir, "lastsync-success.md"), "# Last sync success\n");
    const ctx = { actorUserId: jobUserId, requestId: "req:worker-lastsync-ok" };
    const result = await dataContext.withDataContext(ctx, (scopedDb) =>
      handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
    );
    expect(result.ingested).toBeGreaterThanOrEqual(1);

    // In prod the worker wrapper calls writeNotesLastSync after the ingest tx commits.
    // The test calls the handler directly, so invoke the wrapper's write step here.
    await writeNotesLastSync(dataContext, ctx, prefsRepo, {
      at: new Date().toISOString(),
      ...result
    });

    const stored = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-lastsync-ok-read" },
      (scopedDb) => prefsRepo.get(scopedDb, "notes-last-sync")
    );
    expect(stored).toMatchObject({
      at: expect.any(String),
      ingested: result.ingested,
      skipped: result.skipped,
      errors: result.errors
    });
    expect((stored as { lastError?: string }).lastError).toBeUndefined();
  });

  it("writes notes-last-sync with lastError on failure (failure must not be silent, #449)", async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    const ctx = { actorUserId: jobUserId, requestId: "req:worker-lastsync-fail" };
    const failureMessage = "JARVIS_NOTES_ROOTS not configured";
    await expect(
      dataContext.withDataContext(ctx, (scopedDb) =>
        handleNotesSyncJob(makeJob(jobNotesDir), scopedDb, provider, prefsRepo)
      )
    ).rejects.toThrow(failureMessage);
    process.env["JARVIS_NOTES_ROOTS"] = jobNotesDir;

    // In prod the worker wrapper's catch block calls writeNotesLastSync after rollback.
    await writeNotesLastSync(dataContext, ctx, prefsRepo, {
      at: new Date().toISOString(),
      ingested: 0,
      skipped: 0,
      errors: 0,
      lastError: failureMessage
    });

    const stored = await dataContext.withDataContext(
      { actorUserId: jobUserId, requestId: "req:worker-lastsync-fail-read" },
      (scopedDb) => prefsRepo.get(scopedDb, "notes-last-sync")
    );
    expect(stored).toMatchObject({
      at: expect.any(String),
      ingested: 0,
      skipped: 0,
      errors: 0,
      lastError: expect.stringContaining(failureMessage)
    });
  });
});
