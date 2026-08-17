import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import type * as NodeFsPromises from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";

// TOCTOU test support (tests 6-7 in the handleNotesSyncJob describe block below): vi.spyOn cannot
// patch the "node:fs/promises" namespace directly (ESM module namespaces aren't configurable), so
// realpath is routed through this mock via vi.mock instead. Every other export, and every call to
// realpath outside those two tests, passes through to the real implementation untouched. vi.hoisted
// is required (not a plain top-level const) because vi.mock factories are hoisted above all
// imports, including any plain variable declarations that would otherwise sit below them. Same
// technique as tests/integration/notes-write-tools.test.ts.
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

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { GetNotesSourceResponse, PostNotesSyncResponse } from "@moss/shared";
import { parseDocument, StubEmbeddingProvider } from "@moss/memory";
import { NOTES_SOURCE_PREFERENCE_KEY, resolveNotesRoots } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import {
  assertWithinRoot,
  NotesPathError,
  handleNotesSyncJob,
  handleNotesSyncJobWithDataContext,
  writeNotesLastSync,
  registerNotesSyncRoutes,
  registerNotesJobWorkers,
  NOTES_SYNC_QUEUE,
  type NotesSyncJobPayload
} from "@moss/notes";
import { createPgBossClient, sendJob } from "@moss/jobs";
import { notesSearchExecute } from "../../packages/notes/src/tools.js";
// notesMonitorProvider is internal wiring (registered via notesModuleManifest), not part of the
// package's public API — imported directly from source, same pattern as notesSearchExecute above.
import { notesMonitorProvider } from "../../packages/notes/src/monitor-provider.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const { Client } = pg;

// ── path-guard ────────────────────────────────────────────────────────────────

describe("assertWithinRoot", () => {
  it("passes when path equals the root", () => {
    expect(() => assertWithinRoot("/notes", "/notes")).not.toThrow();
  });

  it("passes when path is directly inside the root", () => {
    expect(() => assertWithinRoot("/notes", "/notes/daily.md")).not.toThrow();
  });

  it("passes when path is deeply nested inside the root", () => {
    expect(() => assertWithinRoot("/notes", "/notes/2026/June/01.md")).not.toThrow();
  });

  it("throws NotesPathError for path outside root", () => {
    expect(() => assertWithinRoot("/notes", "/etc/passwd")).toThrowError(NotesPathError);
  });

  it("rejects partial prefix overlap (no slash suffix)", () => {
    expect(() => assertWithinRoot("/notes", "/notes-evil/file.md")).toThrowError(NotesPathError);
  });

  it("rejects path traversal attempt", () => {
    expect(() => assertWithinRoot("/notes", "/notes/../etc/passwd")).toThrowError(NotesPathError);
  });
});

// ── resolveNotesRoots ─────────────────────────────────────────────────────────

describe("resolveNotesRoots", () => {
  it("returns empty array when env var is absent", () => {
    const roots = resolveNotesRoots({});
    expect(roots).toEqual([]);
  });

  it("parses comma-separated roots", () => {
    const roots = resolveNotesRoots({ JARVIS_NOTES_ROOTS: "/a, /b , /c" });
    expect(roots).toEqual(["/a", "/b", "/c"]);
  });

  it("filters empty segments", () => {
    const roots = resolveNotesRoots({ JARVIS_NOTES_ROOTS: ",," });
    expect(roots).toEqual([]);
  });
});

// ── shared API server setup ───────────────────────────────────────────────────

let appDb: Kysely<MossDatabase>;
let ownerCookie: string;
let notesDir: string;

async function signUp(
  srv: ReturnType<typeof createApiServer>,
  name: string,
  email: string
): Promise<string> {
  const res = await srv.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: { name, email, password: "correct horse battery staple" }
  });
  expect(res.statusCode).toBe(200);
  const cookies: string[] = Array.isArray(res.headers["set-cookie"])
    ? res.headers["set-cookie"]
    : [String(res.headers["set-cookie"] ?? "")];
  return cookies.map((c) => c.split(";", 1)[0]).join("; ");
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  notesDir = join(tmpdir(), `jarv1s-notes-test-${randomUUID()}`);
  await mkdir(notesDir, { recursive: true });
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  await setInstanceSetting("registration.requires_approval", { value: false });
});

afterAll(async () => {
  await appDb?.destroy();
  await rm(notesDir, { recursive: true, force: true });
});

// ── GET /api/me/notes-source ──────────────────────────────────────────────────

describe("GET /api/me/notes-source", () => {
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    server = createApiServer({ appDb, logger: false });
    await server.ready();
    ownerCookie = await signUp(server, "Owner2", `get-notes-${randomUUID()}@example.test`);
  });

  afterAll(async () => {
    await server?.close();
  });

  it("returns null path by default", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/notes-source",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<GetNotesSourceResponse>().path).toBeNull();
  });

  it("requires authentication", async () => {
    const res = await server.inject({ method: "GET", url: "/api/me/notes-source" });
    expect(res.statusCode).toBe(401);
  });
});

// ── PUT /api/me/notes-source ──────────────────────────────────────────────────

describe("PUT /api/me/notes-source", () => {
  let server: ReturnType<typeof createApiServer>;
  let cookie: string;

  beforeAll(async () => {
    server = createApiServer({ appDb, logger: false });
    await server.ready();
    cookie = await signUp(server, "PutOwner", `put-notes-${randomUUID()}@example.test`);
  });

  afterAll(async () => {
    await server?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["JARVIS_NOTES_ROOTS"];
  });

  it("returns 503 when JARVIS_NOTES_ROOTS is not set", async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    const res = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: "/some/path" }
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 400 when path is not within any allowed root", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    const res = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: "/etc" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("saves path when it is within an allowed root", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: notesDir }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<GetNotesSourceResponse>().path).toBe(notesDir);

    const get = await server.inject({
      method: "GET",
      url: "/api/me/notes-source",
      headers: { cookie }
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<GetNotesSourceResponse>().path).toBe(notesDir);
  });

  it("clears path when null is provided", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    // Set first
    await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: notesDir }
    });
    // Clear
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: null }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<GetNotesSourceResponse>().path).toBeNull();
  });

  it("path preference is per-user (RLS)", async () => {
    const memberCk = await signUp(server, "RLSMember", `rls-member-${randomUUID()}@example.test`);
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: notesDir }
    });
    const memberRes = await server.inject({
      method: "GET",
      url: "/api/me/notes-source",
      headers: { cookie: memberCk }
    });
    expect(memberRes.json<GetNotesSourceResponse>().path).toBeNull();
  });
});

// ── POST /api/notes/sync ──────────────────────────────────────────────────────

describe("POST /api/notes/sync", () => {
  let server: ReturnType<typeof createApiServer>;
  let syncCookie: string;

  beforeAll(async () => {
    server = createApiServer({ appDb, logger: false });
    await server.ready();
    syncCookie = await signUp(server, "SyncUser", `sync-${randomUUID()}@example.test`);
  });

  afterAll(async () => {
    await server?.close();
  });

  it("returns 409 when no notes source is configured", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/notes/sync",
      headers: { cookie: syncCookie }
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 202 with jobId when notes source is configured (mock boss)", async () => {
    const bossSend = vi.fn(async () => "test-job-id-123");
    const fakeServer = Fastify({ logger: false });

    const userId = randomUUID();
    const dataContextRunner = new DataContextRunner(appDb);

    // Pre-seed the notes source preference in DB
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
        [userId, `sync-mock-${userId}@example.test`]
      );
      await client.query(
        `INSERT INTO app.preferences (owner_user_id, key, value_json) VALUES ($1, $2, $3::jsonb) ON CONFLICT (owner_user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`,
        [userId, NOTES_SOURCE_PREFERENCE_KEY, JSON.stringify(notesDir)]
      );
    } finally {
      await client.end();
    }

    registerNotesSyncRoutes(fakeServer, {
      dataContext: dataContextRunner,
      resolveAccessContext: async () => ({ actorUserId: userId, requestId: "req:sync-test" }),
      preferencesRepository: new PreferencesRepository(),
      boss: { send: bossSend } as unknown as PgBoss
    });

    await fakeServer.ready();
    try {
      const res = await fakeServer.inject({ method: "POST", url: "/api/notes/sync" });
      expect(res.statusCode).toBe(202);
      const body = res.json<PostNotesSyncResponse>();
      expect(typeof body.jobId).toBe("string");
      expect(bossSend).toHaveBeenCalledWith(
        NOTES_SYNC_QUEUE,
        expect.objectContaining({ actorUserId: userId, sourcePath: notesDir }),
        expect.objectContaining({ singletonKey: `notes-sync:${userId}` })
      );
    } finally {
      await fakeServer.close();
    }
  });

  it("requires authentication", async () => {
    const res = await server.inject({ method: "POST", url: "/api/notes/sync" });
    expect(res.statusCode).toBe(401);
  });
});

// ── handleNotesSyncJob (worker integration) ───────────────────────────────────

describe("handleNotesSyncJob", () => {
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

  it("closes the TOCTOU window: handleNotesSyncJob target swapped to a symlink after the initial check, before ingest", async () => {
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
      ).rejects.toThrow("not within allowed root");
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

  it("closes the TOCTOU window: handleNotesSyncJobWithDataContext target swapped across the withDataContext boundary", async () => {
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
      ).rejects.toThrow("not within allowed root");
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

// ── PUT /api/me/notes-source → 15-min heartbeat schedule reconcile (#449) ─────

describe("PUT /api/me/notes-source schedule reconcile (#449)", () => {
  let server: ReturnType<typeof createApiServer>;
  let cookie: string;
  let scheduleUserActorId: string;

  beforeAll(async () => {
    server = createApiServer({ appDb, logger: false });
    await server.ready();
    cookie = await signUp(server, "ScheduleUser", `sched-${randomUUID()}@example.test`);
    // Resolve the actor userId so we can assert the schedule row key directly.
    const me = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie }
    });
    scheduleUserActorId = me.json<{ user: { id: string } }>().user.id;
  });

  afterAll(async () => {
    await server?.close();
  });

  afterEach(() => {
    delete process.env["JARVIS_NOTES_ROOTS"];
  });

  async function fetchScheduleRow(): Promise<{ cron: string; data: unknown } | null> {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const res = await client.query<{ cron: string; data: unknown }>(
        `SELECT cron, data FROM pgboss.schedule WHERE name = $1 AND key = $2`,
        [NOTES_SYNC_QUEUE, scheduleUserActorId]
      );
      return res.rows[0] ?? null;
    } finally {
      await client.end();
    }
  }

  it("PUT with a valid path creates one 15-min schedule row keyed on actorUserId", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: notesDir }
    });
    expect(put.statusCode).toBe(200);

    const row = await fetchScheduleRow();
    expect(row, "schedule row must exist after PUT with a path").not.toBeNull();
    expect(row!.cron).toBe("*/15 * * * *");
    // Metadata-only: just actorUserId (the handler resolves sourcePath at fire time).
    expect(row!.data).toEqual({ actorUserId: scheduleUserActorId });
  });

  it("PUT with null clears the schedule row", async () => {
    process.env["JARVIS_NOTES_ROOTS"] = notesDir;
    // Ensure a row exists first.
    await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: notesDir }
    });
    expect(await fetchScheduleRow()).not.toBeNull();

    // Clear.
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/notes-source",
      headers: { cookie, "content-type": "application/json" },
      payload: { path: null }
    });
    expect(put.statusCode).toBe(200);
    expect(await fetchScheduleRow(), "schedule row must be gone after clearing path").toBeNull();
  });
});

// ── notes.search tool (RLS retrieval) ─────────────────────────────────────────

describe("notes.search tool", () => {
  let server: ReturnType<typeof createApiServer>;
  let userA: string;
  let userB: string;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    server = createApiServer({ appDb, logger: false });
    await server.ready();

    // User A signs up and gets their actor id
    const cookieA = await signUp(server, "SearchUserA", `searchA-${randomUUID()}@example.test`);
    const meA = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieA }
    });
    userA = meA.json<{ user: { id: string } }>().user.id;

    // User B signs up
    const cookieB = await signUp(server, "SearchUserB", `searchB-${randomUUID()}@example.test`);
    const meB = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieB }
    });
    userB = meB.json<{ user: { id: string } }>().user.id;

    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await server?.close();
  });

  it("retrieves chunks for the owner and hides them from non-owners (RLS)", async () => {
    const jobNotesDirA = join(tmpdir(), `jarv1s-notes-search-${randomUUID()}`);
    await mkdir(jobNotesDirA, { recursive: true });
    await writeFile(
      join(jobNotesDirA, "secret.md"),
      "# Secret\n\nThis is a unique chunk of secret words."
    );

    process.env["JARVIS_NOTES_ROOTS"] = jobNotesDirA;
    try {
      // 1. User A ingests
      const provider = new StubEmbeddingProvider();
      const prefsRepo = new PreferencesRepository();
      const jobA = {
        id: randomUUID(),
        data: { actorUserId: userA, sourcePath: jobNotesDirA }
      } as unknown as Job<NotesSyncJobPayload>;

      await dataContext.withDataContext(
        { actorUserId: userA, requestId: "req:search-ingest" },
        (scopedDb) => handleNotesSyncJob(jobA, scopedDb, provider, prefsRepo)
      );

      // 2. User A searches
      const resultA = await dataContext.withDataContext(
        { actorUserId: userA, requestId: "req:search-a" },
        (scopedDb) =>
          notesSearchExecute(scopedDb, { query: "unique chunk of secret words" }, {} as never)
      );
      const dataA = resultA.data as { chunks: unknown[] };
      expect(dataA?.chunks).toHaveLength(1);
      expect(dataA?.chunks[0]).toMatchObject({
        sourcePath: expect.stringContaining("secret.md"),
        text: expect.stringContaining("unique chunk of secret words")
      });

      // 3. User B searches the same query
      const resultB = await dataContext.withDataContext(
        { actorUserId: userB, requestId: "req:search-b" },
        (scopedDb) =>
          notesSearchExecute(scopedDb, { query: "unique chunk of secret words" }, {} as never)
      );

      const dataB = resultB.data as { chunks: unknown[] };
      // RLS must isolate
      expect(dataB?.chunks).toHaveLength(0);
    } finally {
      await rm(jobNotesDirA, { recursive: true, force: true });
      delete process.env["JARVIS_NOTES_ROOTS"];
    }
  }, 60_000);
});

// ── notesMonitorProvider.collectSignals (#767) ────────────────────────────────
//
// Regression coverage for #767: notesMonitorProvider.collectSignals delegates to
// MemoryRepository.listRecentVaultFiles, which hardcoded source_kind = 'vault' —
// so it never saw files ingested by the notes sync job (source_kind = 'notes'),
// and the proactive monitor silently never fired. This test ingests a real .md
// file under a notes-kind path via the actual sync job, sets a matching priority
// anchor, and asserts a priority_anchor_changed signal now fires.

describe("notesMonitorProvider.collectSignals", () => {
  let dataContext: DataContextRunner;
  const provider = new StubEmbeddingProvider();
  const prefsRepo = new PreferencesRepository();
  const monitorUserId = "00000000-0000-4000-8100-000000000201";
  let monitorNotesDir: string;

  function makeJob(sourcePath: string): Job<NotesSyncJobPayload> {
    return {
      id: randomUUID(),
      data: { actorUserId: monitorUserId, sourcePath }
    } as unknown as Job<NotesSyncJobPayload>;
  }

  beforeAll(async () => {
    monitorNotesDir = join(tmpdir(), `jarv1s-notes-monitor-${randomUUID()}`);
    await mkdir(monitorNotesDir, { recursive: true });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, 'notes-monitor@example.test', false) ON CONFLICT DO NOTHING`,
        [monitorUserId]
      );
    } finally {
      await client.end();
    }

    dataContext = new DataContextRunner(appDb);
    process.env["JARVIS_NOTES_ROOTS"] = monitorNotesDir;

    await writeFile(
      join(monitorNotesDir, "roadmap.md"),
      "# Planning\n\nFollow up on the Q3 Roadmap with the team this week.\n"
    );

    await dataContext.withDataContext(
      { actorUserId: monitorUserId, requestId: "req:monitor-ingest" },
      (scopedDb) => handleNotesSyncJob(makeJob(monitorNotesDir), scopedDb, provider, prefsRepo)
    );
  });

  afterAll(async () => {
    await rm(monitorNotesDir, { recursive: true, force: true });
    delete process.env["JARVIS_NOTES_ROOTS"];
  });

  it("fires a priority_anchor_changed signal for a recently-ingested note matching an anchor", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: monitorUserId, requestId: "req:monitor-collect" },
      (scopedDb) =>
        notesMonitorProvider.collectSignals(scopedDb, {
          ownerUserId: monitorUserId,
          sinceCursor: null,
          now: new Date().toISOString(),
          timeZone: "UTC",
          maxSignals: 10,
          priorityAnchors: [{ label: "Roadmap", aliases: [] }]
        })
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      source: "notes",
      signalType: "priority_anchor_changed",
      title: "roadmap"
    });
  });

  it("fires no signal when no priority anchor matches", async () => {
    const result = await dataContext.withDataContext(
      { actorUserId: monitorUserId, requestId: "req:monitor-no-match" },
      (scopedDb) =>
        notesMonitorProvider.collectSignals(scopedDb, {
          ownerUserId: monitorUserId,
          sinceCursor: null,
          now: new Date().toISOString(),
          timeZone: "UTC",
          maxSignals: 10,
          priorityAnchors: [{ label: "Nonexistent Topic Xyz", aliases: [] }]
        })
    );

    expect(result.signals).toHaveLength(0);
  });
});
