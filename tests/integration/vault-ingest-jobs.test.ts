import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { VaultContextRunner, writeVaultFile } from "@moss/vault";
import {
  MemoryRepository,
  MemoryIngestPipeline,
  MemoryRetriever,
  StubEmbeddingProvider,
  applyVaultIngestNudge,
  runVaultIngestSweep,
  scheduleVaultIngestNudge
} from "@moss/memory";
import {
  registerVaultIngestRootProvider,
  resetVaultIngestRootProvidersForTests
} from "../../packages/memory/src/vault-ingest-registry.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const INGEST_ROOT = "vault-notes/";

describe("vault ingest sweep/nudge", () => {
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let vaultsBaseDir: string;
  let vaultRunner: VaultContextRunner;
  let repository: MemoryRepository;
  const provider = new StubEmbeddingProvider();

  const ownerA = "00000000-0000-4000-8200-0000000000a1";
  const ownerB = "00000000-0000-4000-8200-0000000000b2";

  async function seedUser(id: string, email: string): Promise<void> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, is_instance_admin)
         VALUES ($1, $2, false) ON CONFLICT DO NOTHING`,
        [id, email]
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    await seedUser(ownerA, "vault-ingest-a@example.test");
    await seedUser(ownerB, "vault-ingest-b@example.test");

    vaultsBaseDir = join(tmpdir(), `jarv1s-vault-ingest-${randomUUID()}`);
    vaultRunner = new VaultContextRunner(vaultsBaseDir);
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    dataContext = new DataContextRunner(workerDb);
    repository = new MemoryRepository();

    resetVaultIngestRootProvidersForTests();
    registerVaultIngestRootProvider({
      moduleId: "test-fixture",
      resolveRoots: async () => [INGEST_ROOT]
    });
  });

  afterAll(async () => {
    resetVaultIngestRootProvidersForTests();
    await workerDb?.destroy();
    await rm(vaultsBaseDir, { recursive: true, force: true });
  });

  function accessContext(actorUserId: string) {
    return { actorUserId, requestId: `req:vault-ingest-${actorUserId}` };
  }

  it("ingests allowlisted markdown into source_kind=vault chunks for the right owner", async () => {
    const pipeline = new MemoryIngestPipeline(provider, repository);

    await vaultRunner.withVaultContext(accessContext(ownerA), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}first.md`, "# First\n\nSome content.\n");
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}second.md`, "# Second\n\nMore content.\n");
    });

    const stats = await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      runVaultIngestSweep(accessContext(ownerA), vaultCtx, dataContext, pipeline, repository)
    );

    expect(stats.processed).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toEqual([]);

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const paths = await repository.listIndexedPaths(scopedDb, ownerA, "vault");
      expect(paths.sort()).toEqual([`${INGEST_ROOT}first.md`, `${INGEST_ROOT}second.md`]);
    });
  });

  it("skips unchanged files on a second sweep (hash-skip)", async () => {
    const pipeline = new MemoryIngestPipeline(provider, repository);

    const stats = await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      runVaultIngestSweep(accessContext(ownerA), vaultCtx, dataContext, pipeline, repository)
    );

    expect(stats.processed).toBe(0);
    expect(stats.skipped).toBe(2);
    expect(stats.failed).toEqual([]);
  });

  it("purges chunks and the file-index row for a file removed since the last sweep", async () => {
    const pipeline = new MemoryIngestPipeline(provider, repository);

    await vaultRunner.withVaultContext(accessContext(ownerA), async (vaultCtx) => {
      await rm(join(vaultCtx.vaultRoot, INGEST_ROOT, "second.md"));
    });

    const stats = await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      runVaultIngestSweep(accessContext(ownerA), vaultCtx, dataContext, pipeline, repository)
    );

    expect(stats.deleted).toBe(1);

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const paths = await repository.listIndexedPaths(scopedDb, ownerA, "vault");
      expect(paths).toEqual([`${INGEST_ROOT}first.md`]);
    });
  });

  it("isolates a per-file ingest failure without failing the rest of the sweep", async () => {
    const badVectorProvider = new (class extends StubEmbeddingProvider {
      override async embedDocument(text: string): Promise<number[]> {
        if (text.includes("poison")) throw new Error("embedding failed");
        return super.embedDocument(text);
      }
    })();
    const pipeline = new MemoryIngestPipeline(badVectorProvider, repository);

    await vaultRunner.withVaultContext(accessContext(ownerA), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}good-before.md`, "# Good before\n\nSafe.\n");
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}bad.md`, "# Bad\n\npoison content.\n");
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}good-after.md`, "# Good after\n\nSafe too.\n");
    });

    const stats = await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      runVaultIngestSweep(accessContext(ownerA), vaultCtx, dataContext, pipeline, repository)
    );

    expect(stats.processed).toBe(2);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.path).toBe(`${INGEST_ROOT}bad.md`);

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const paths = await repository.listIndexedPaths(scopedDb, ownerA, "vault");
      expect(paths).not.toContain(`${INGEST_ROOT}bad.md`);
      expect(paths).toContain(`${INGEST_ROOT}good-before.md`);
      expect(paths).toContain(`${INGEST_ROOT}good-after.md`);
    });
  });

  it("never touches another owner's vault files or index rows during a sweep (RLS)", async () => {
    const pipeline = new MemoryIngestPipeline(provider, repository);

    await vaultRunner.withVaultContext(accessContext(ownerB), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, `${INGEST_ROOT}owner-b-only.md`, "# Owner B\n\nPrivate.\n");
    });

    const stats = await vaultRunner.withVaultContext(accessContext(ownerB), (vaultCtx) =>
      runVaultIngestSweep(accessContext(ownerB), vaultCtx, dataContext, pipeline, repository)
    );

    expect(stats.processed).toBe(1);

    await dataContext.withDataContext(accessContext(ownerB), async (scopedDb) => {
      const pathsB = await repository.listIndexedPaths(scopedDb, ownerB, "vault");
      expect(pathsB).toEqual([`${INGEST_ROOT}owner-b-only.md`]);
    });

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const pathsA = await repository.listIndexedPaths(scopedDb, ownerA, "vault");
      expect(pathsA).not.toContain(`${INGEST_ROOT}owner-b-only.md`);
    });
  });

  it("makes a nudged write retrievable without waiting for a sweep", async () => {
    const pipeline = new MemoryIngestPipeline(provider, repository);
    const retriever = new MemoryRetriever(provider, repository);
    const freshPath = `${INGEST_ROOT}fresh-nudge.md`;

    await vaultRunner.withVaultContext(accessContext(ownerA), async (vaultCtx) => {
      await writeVaultFile(vaultCtx, freshPath, "# Fresh nudge\n\nJust written, not yet swept.\n");
    });

    await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      applyVaultIngestNudge(accessContext(ownerA), vaultCtx, dataContext, pipeline, freshPath, "upsert")
    );

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const results = await retriever.retrieve(scopedDb, "Just written, not yet swept", 10, "vault");
      expect(results.some((r) => r.sourcePath === freshPath)).toBe(true);
    });

    await vaultRunner.withVaultContext(accessContext(ownerA), (vaultCtx) =>
      applyVaultIngestNudge(accessContext(ownerA), vaultCtx, dataContext, pipeline, freshPath, "delete")
    );

    await dataContext.withDataContext(accessContext(ownerA), async (scopedDb) => {
      const paths = await repository.listIndexedPaths(scopedDb, ownerA, "vault");
      expect(paths).not.toContain(freshPath);
    });
  });

  it("scheduleVaultIngestNudge accepts an op-bearing payload without throwing (ALLOWED_PAYLOAD_KEYS fix)", async () => {
    const sent: unknown[] = [];
    const fakeBoss = {
      send: async (_queue: string, payload: unknown) => {
        sent.push(payload);
        return "fake-job-id";
      }
    } as unknown as PgBoss;

    await scheduleVaultIngestNudge(fakeBoss, {
      actorUserId: ownerA,
      sourcePath: `${INGEST_ROOT}nudged.md`,
      op: "upsert"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: "upsert", sourcePath: `${INGEST_ROOT}nudged.md` });
  });
});
