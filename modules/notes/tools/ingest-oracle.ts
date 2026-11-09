/** Real legacy ingestVaultDocument + MemoryRepository + StubEmbeddingProvider.
 * Filesystem admission uses the real VaultContextRunner. No managed publication. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { ingestVaultDocument, MemoryRepository, StubEmbeddingProvider } from "@moss/memory";
import { VaultContextRunner } from "@moss/vault";

export const ingestSnapshotSql = `SELECT jsonb_build_object(
  'chunks', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,source_kind,source_path,line_start,line_end,content_hash,text,embed_model_name,embed_model_version) ORDER BY source_path,line_start,text) FROM app.memory_chunks WHERE owner_user_id=ANY($1::uuid[])), '[]'),
  'links', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,from_path,to_path) ORDER BY from_path,to_path) FROM app.memory_links WHERE owner_user_id=ANY($1::uuid[])), '[]'),
  'index', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,source_kind,source_path,file_hash,chunk_count,embed_model_name,embed_model_version) ORDER BY source_path) FROM app.memory_file_index WHERE owner_user_id=ANY($1::uuid[])), '[]')
) AS value`;

const NOTES: Record<string, string> = {
  "a.md":
    "---\ntitle: Alpha\n---\n# Alpha\n\nSee [[Other Note|label]] and [[Plain]].\n\n## Two\n\nBody two text.\n",
  "nested/b.md": `# Long\n\n${"A long paragraph sentence with enough words to split. ".repeat(80)}\n`,
  "c.md": "Small plain note.\n"
};

export async function ingestOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const folder = await mkdtemp(join(tmpdir(), "notes-ingest-"));
  const root = join(folder, "notes");
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const path = join(folder, "oracle.json");
  const cleanup = async () => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      await Promise.allSettled([
        bootstrap.end(),
        app.destroy(),
        rm(folder, { recursive: true, force: true })
      ]);
    }
  };
  try {
    await bootstrap.connect();
    await mkdir(join(root, "nested"), { recursive: true });
    for (const [name, text] of Object.entries(NOTES)) await writeFile(join(root, name), text);
    for (const [i, actor] of actors.entries())
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes ingest fixture',$3)",
        [actor, `notes-ingest-${actor}@example.test`, i === 2]
      );
    const provider = new StubEmbeddingProvider();
    const repository = new MemoryRepository();
    const files = Object.keys(NOTES).sort();
    await new DataContextRunner(app).withDataContext({ actorUserId: actors[0]! }, async (db) => {
      for (const relative of files) {
        await new VaultContextRunner(folder).withVaultContextAt(
          { actorUserId: actors[0]! },
          root,
          [folder],
          (ctx) =>
            ingestVaultDocument(
              db,
              ctx,
              relative,
              { sourceKind: "notes", sourcePath: join(root, relative) },
              { repository, embeddingProvider: provider }
            )
        );
      }
    });
    const expected = (await bootstrap.query(ingestSnapshotSql, [actors])).rows[0]?.value;
    // Clear the legacy rows so the compiled run starts from the same empty index.
    for (const table of ["memory_chunks", "memory_links", "memory_file_index"])
      await bootstrap.query(`DELETE FROM app.${table} WHERE owner_user_id=ANY($1::uuid[])`, [
        actors
      ]);
    await writeFile(
      path,
      JSON.stringify({
        actors,
        root,
        parent: folder,
        files: files.map((f) => join(root, f)),
        snapshotSql: ingestSnapshotSql,
        expected
      }),
      { mode: 0o600 }
    );
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
