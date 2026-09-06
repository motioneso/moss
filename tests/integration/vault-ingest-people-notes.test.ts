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
import { createPeopleVaultIngestProvider } from "@moss/people";
import { PreferencesRepository } from "@moss/structured-state";
import { writeVaultFile } from "@moss/vault";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("vault ingest: people notes end-to-end", () => {
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let vaultsBaseDir: string;
  let vaultRunner: VaultContextRunner;
  let repository: MemoryRepository;
  const preferences = new PreferencesRepository();
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

  // #2268 — People notes now normally live in the user's own notes folder, which the notes module
  // already sweeps into memory. What is still swept out of private storage is a People folder saved
  // before that change: a plain relative name. This test covers exactly that surviving case.
  it("ingests a people-note left in private storage by an older People folder setting, then purges it on delete", async () => {
    const pipeline = new MemoryIngestPipeline(embeddingProvider, repository);
    const retriever = new MemoryRetriever(embeddingProvider, repository);
    const ac = accessContext(owner);

    const notePath = "people-notes/Ada-Lovelace.md";
    await vaultRunner.withVaultContext(ac, (vaultCtx) =>
      dataContext.withDataContext(ac, async (scopedDb) => {
        await preferences.upsert(scopedDb, "people-notes-folder", "people-notes");
        await writeVaultFile(
          vaultCtx,
          notePath,
          `---
jarvisPersonId: 00000000-0000-4000-8000-0000000001ad
displayName: Ada Lovelace
aliases: []
emails:
  - ada@example.test
phones: []
status: active
---
Ada Lovelace wrote the first algorithm intended for a machine.
`
        );
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
