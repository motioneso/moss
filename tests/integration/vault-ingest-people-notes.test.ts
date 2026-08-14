import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";
import {
  MemoryRepository,
  MemoryIngestPipeline,
  MemoryRetriever,
  StubEmbeddingProvider,
  runVaultIngestSweep
} from "@moss/memory";
import {
  registerVaultIngestRootProvider,
  resetVaultIngestRootProvidersForTests
} from "../../packages/memory/src/vault-ingest-registry.js";
import { PeopleNotesService, createPeopleVaultIngestProvider } from "@moss/people";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("vault ingest: people notes end-to-end", () => {
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let vaultsBaseDir: string;
  let vaultRunner: VaultContextRunner;
  let repository: MemoryRepository;
  let notesService: PeopleNotesService;
  const embeddingProvider = new StubEmbeddingProvider();

  const owner = "00000000-0000-4000-8300-0000000000c3";

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
    await seedUser(owner, "vault-ingest-people@example.test");

    vaultsBaseDir = join(tmpdir(), `jarv1s-vault-ingest-people-${randomUUID()}`);
    vaultRunner = new VaultContextRunner(vaultsBaseDir);
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    dataContext = new DataContextRunner(workerDb);
    repository = new MemoryRepository();
    notesService = new PeopleNotesService();

    // Real provider (not a test fixture) — proves createPeopleVaultIngestProvider's
    // preference-backed root resolution, matching prod module-registry wiring.
    resetVaultIngestRootProvidersForTests();
    registerVaultIngestRootProvider(createPeopleVaultIngestProvider());
  });

  afterAll(async () => {
    resetVaultIngestRootProvidersForTests();
    await workerDb?.destroy();
    await rm(vaultsBaseDir, { recursive: true, force: true });
  });

  function accessContext(actorUserId: string) {
    return { actorUserId, requestId: `req:vault-ingest-people-${actorUserId}` };
  }

  it("ingests a people-note written through PeopleNotesService, retrieves it, then purges it on delete", async () => {
    const pipeline = new MemoryIngestPipeline(embeddingProvider, repository);
    const retriever = new MemoryRetriever(embeddingProvider, repository);
    const ac = accessContext(owner);

    const notePath = await vaultRunner.withVaultContext(ac, (vaultCtx) =>
      dataContext.withDataContext(ac, async (scopedDb) => {
        await notesService.putSettings(scopedDb, owner, { folder: "people-notes" });
        const { notePath } = await notesService.createPersonNote(scopedDb, vaultCtx, owner, {
          displayName: "Ada Lovelace",
          emails: ["ada@example.test"]
        });
        return notePath;
      })
    );

    const stats = await vaultRunner.withVaultContext(ac, (vaultCtx) =>
      runVaultIngestSweep(ac, vaultCtx, dataContext, pipeline, repository)
    );
    expect(stats.processed).toBe(1);
    expect(stats.failed).toEqual([]);

    await dataContext.withDataContext(ac, async (scopedDb) => {
      const results = await retriever.retrieve(scopedDb, "Ada Lovelace", 10, "vault");
      expect(results.some((r) => r.sourcePath === notePath)).toBe(true);
    });

    // PeopleNotesService has no vault-file-delete path (archive just updates status), so the
    // purge half of this test exercises deletion the same way the periodic sweep would observe
    // it: the file disappearing from the vault out-of-band.
    await vaultRunner.withVaultContext(ac, async (vaultCtx) => {
      await rm(join(vaultCtx.vaultRoot, notePath));
    });

    const purgeStats = await vaultRunner.withVaultContext(ac, (vaultCtx) =>
      runVaultIngestSweep(ac, vaultCtx, dataContext, pipeline, repository)
    );
    expect(purgeStats.deleted).toBe(1);

    await dataContext.withDataContext(ac, async (scopedDb) => {
      const paths = await repository.listIndexedPaths(scopedDb, owner, "vault");
      expect(paths).not.toContain(notePath);
    });
  });
});
