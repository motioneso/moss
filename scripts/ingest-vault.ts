import { randomUUID } from "node:crypto";

import { createDatabase, DataContextRunner, resolveMossEnv, type AccessContext } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";
import {
  IngestionService,
  MemoryIngestPipeline,
  MemoryRepository,
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "@moss/memory";
import { RuntimeConfigResolver } from "@moss/settings";
import { createManagedNoteSnapshotPort } from "@moss/module-registry";

function requireEnv(name: string): string {
  const value = resolveMossEnv(process.env, name);
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const connectionString = requireEnv("DATABASE_URL");
  const actorUserId = requireEnv("JARVIS_USER_ID");
  const vaultBaseDir = requireEnv("JARVIS_VAULT_ROOT");

  const repository = new MemoryRepository();
  const db = createDatabase({ connectionString, maxConnections: 1 });
  const dataContextRunner = new DataContextRunner(db);
  const accessCtx: AccessContext = { actorUserId, requestId: `ingest-cli:${randomUUID()}` };
  const provider = createEmbeddingProvider(
    await dataContextRunner.withDataContext(accessCtx, (scopedDb) =>
      getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb))
    )
  );
  console.log(`Embedding provider: ${provider.modelName} (${provider.dimensions} dims)`);

  const pipeline = new MemoryIngestPipeline(
    provider,
    repository,
    createManagedNoteSnapshotPort(dataContextRunner)
  );
  const service = new IngestionService(pipeline, repository, dataContextRunner);
  const vaultRunner = new VaultContextRunner(vaultBaseDir);

  try {
    const stats = await vaultRunner.withVaultContext(accessCtx, (vaultCtx) =>
      service.ingestVault(accessCtx, vaultCtx, { force })
    );

    console.log("Ingestion complete:");
    console.log(`  processed: ${stats.processed}`);
    console.log(`  skipped:   ${stats.skipped}`);
    console.log(`  deleted:   ${stats.deleted}`);
    console.log(`  failed:    ${stats.failed.length}`);
    for (const f of stats.failed) console.error(`    ! ${f.path}: ${f.error}`);

    process.exitCode = stats.failed.length > 0 ? 1 : 0;
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
