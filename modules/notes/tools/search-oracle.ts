/** Real legacy retrieval and SQL over disposable synthetic data. Only query
 * embeddings are a deterministic stand-in, shared byte-for-byte with Rust. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { MemoryRepository, MemoryRetriever, type EmbeddingProvider } from "@moss/memory";
import { legacySearch } from "./search-legacy.js";

export async function searchOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const worker = createDatabase({ connectionString: urls.worker });
  const folder = await mkdtemp(join(tmpdir(), "notes-search-oracle-"));
  const path = join(folder, "expected.json");
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const cleanup = async () => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      await Promise.allSettled([
        bootstrap.end(),
        app.destroy(),
        worker.destroy(),
        rm(folder, { recursive: true, force: true })
      ]);
    }
  };
  try {
    await bootstrap.connect();
    const vector = (x: number, y: number) => [x, y, ...Array<number>(766).fill(0)];
    const queries = { coffee: vector(1, 0), garden: vector(0, 1) };
    const provider: EmbeddingProvider = {
      dimensions: 768,
      modelName: "fixture",
      modelVersion: "0",
      embedDocument: async () => {
        throw new Error("Search must not embed documents");
      },
      embedQuery: async (query) => queries[query as keyof typeof queries]!
    };
    const execute = legacySearch(new MemoryRetriever(provider, new MemoryRepository()));
    for (const [i, actor] of actors.entries()) {
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes search fixture',$3)",
        [actor, `notes-search-${actor}@example.test`, i === 2]
      );
      if (i === 2) continue;
      for (const [kind, x, y] of [
        ["notes", 1, 0],
        ["notes", 0.6, 0.8],
        ["notes", 0, 1],
        ["vault", 1, 0]
      ] as const) {
        await bootstrap.query(
          "INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,line_start,line_end,content_hash,text,embedding,embed_model_name,embed_model_version) VALUES($1,$2,$3,2,5,$4,$5,$6::vector,'fixture','0')",
          [
            actor,
            kind,
            `/notes/${i}/${kind}-${x}.md`,
            randomUUID(),
            `Private ${i} ${kind} café 🌱 ${x}`,
            `[${vector(x, y).join(",")}]`
          ]
        );
      }
      await bootstrap.query(
        "INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,line_start,line_end,content_hash,text,embedding,embed_model_name,embed_model_version) VALUES($1,'notes','/not-indexed.md',0,0,'none','No vector',NULL,'fixture','0')",
        [actor]
      );
    }
    const expected = [];
    for (const [role, database] of [
      ["app", app],
      ["worker", worker]
    ] as const) {
      const runner = new DataContextRunner(database);
      for (const actor of actors)
        for (const parameters of [
          { query: " coffee " },
          { query: "garden", limit: 1 },
          { query: "coffee", limit: 2 },
          { query: "" }
        ]) {
          expected.push({
            actor,
            role,
            parameters,
            value: await runner.withDataContext({ actorUserId: actor }, (db) =>
              execute(db, parameters)
            )
          });
        }
    }
    await writeFile(path, JSON.stringify({ actors, queries, expected }), { mode: 0o600 });
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
