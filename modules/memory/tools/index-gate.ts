/** Seeds accounts, a private notes folder and index rows written by the real TypeScript ingest,
 * then runs the Rust vault index tests against them. Only through scripts/run-gate.sh. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { ingestVaultDocument, MemoryRepository, StubEmbeddingProvider } from "@moss/memory";
import { ManagedNoteSnapshotService } from "@moss/notes";
import { VaultContextRunner } from "@moss/vault";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const app = createDatabase({ connectionString: urls.app });
const base = await mkdtemp(join(tmpdir(), "memory-index-"));
const actors = [randomUUID(), randomUUID(), randomUUID()];
const legacyNote = `notes/generated/${randomUUID()}/v1.md`;
let status = 1;
try {
  await bootstrap.connect();
  for (const actor of actors)
    await bootstrap.query(
      "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Memory index fixture',false)",
      [actor, `memory-index-${actor}@example.test`]
    );
  const root = join(base, actors[0]!);
  await mkdir(join(root, "notes/generated", legacyNote.split("/")[2]!), { recursive: true });
  await writeFile(join(root, legacyNote), "# Written by TypeScript\n\nLegacy indexed note body.\n");
  // The real legacy ingest, with its real snapshot capture, writes the rows Rust must honour.
  await new DataContextRunner(app).withDataContext({ actorUserId: actors[0]! }, async (db) => {
    await new VaultContextRunner(base).withVaultContextAt(
      { actorUserId: actors[0]! },
      root,
      [base],
      (ctx) =>
        ingestVaultDocument(
          db,
          ctx,
          legacyNote,
          { sourceKind: "vault", sourcePath: legacyNote },
          {
            repository: new MemoryRepository(),
            embeddingProvider: new StubEmbeddingProvider(),
            publication: new ManagedNoteSnapshotService(undefined as never)
          }
        )
    );
  });
  const env = {
    ...process.env,
    MEMORY_INDEX_BASE: base,
    MEMORY_INDEX_ACTORS: JSON.stringify(actors),
    MEMORY_INDEX_LEGACY_NOTE: legacyNote,
    JS55_APP_URL: urls.app,
    JS55_WORKER_URL: urls.worker,
    JS55_BOOTSTRAP_URL: urls.bootstrap
  };
  status =
    spawnSync("bash", ["modules/memory/tools/index-tests.sh"], { stdio: "inherit", env }).status ??
    1;
} finally {
  await bootstrap
    .query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors])
    .catch(() => undefined);
  await Promise.allSettled([
    bootstrap.end(),
    app.destroy(),
    rm(base, { recursive: true, force: true })
  ]);
}
process.exitCode = status;
