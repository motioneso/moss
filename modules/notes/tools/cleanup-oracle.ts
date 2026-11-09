/** Authored legacy cleanup + real MemoryRepository, actor transactions and files.
 * No embeddings or ingestion are involved in this deletion-only checkpoint. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { MemoryRepository } from "@moss/memory";

export const snapshotSql = `SELECT jsonb_build_object(
  'chunks', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,source_kind,source_path,text) ORDER BY owner_user_id,source_kind,source_path) FROM app.memory_chunks WHERE owner_user_id=ANY($1::uuid[])), '[]'),
  'links', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,from_path,to_path) ORDER BY owner_user_id,from_path,to_path) FROM app.memory_links WHERE owner_user_id=ANY($1::uuid[])), '[]'),
  'index', COALESCE((SELECT jsonb_agg(jsonb_build_array(owner_user_id,source_kind,source_path,file_hash) ORDER BY owner_user_id,source_kind,source_path) FROM app.memory_file_index WHERE owner_user_id=ANY($1::uuid[])), '[]')
) AS value`;

export async function cleanupOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const worker = createDatabase({ connectionString: urls.worker });
  const folder = await mkdtemp(join(tmpdir(), "notes-cleanup-"));
  const root = join(folder, "notes%_ café");
  const empty = join(folder, "empty");
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const path = join(folder, "oracle.json");
  const chunks: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  const index: Record<string, unknown>[] = [];
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
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(empty);
    const files = [join(root, "keep.md"), join(root, "nested", "🌱.md")];
    for (const file of files) await writeFile(file, "A real synthetic note");
    await writeFile(join(root, "UPPER.MD"), "Not included by legacy's lowercase extension walk");
    const walked = [...files, join(root, "vanished.md")];
    for (const [i, actor] of actors.entries()) {
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes cleanup fixture',$3)",
        [actor, `notes-cleanup-${actor}@example.test`, i === 2]
      );
      for (const file of [
        ...walked,
        join(root, "gone-a.md"),
        join(root, "gone-b.md"),
        join(root, "UPPER.MD"),
        `${root}-other/keep.md`,
        join(folder, "other", "keep.md"),
        root,
        join(empty, "gone.md"),
        join(empty, "other.md")
      ]) {
        for (const kind of ["notes", "vault"]) {
          chunks.push({ owner: actor, kind, path: file, text: `Private fixture ${i} ${kind}` });
          index.push({ owner: actor, kind, path: file, hash: "fixture" });
        }
        links.push({ owner: actor, from: file, to: "/keep-target.md" });
      }
      links.push({ owner: actor, from: "/incoming.md", to: join(root, "gone-a.md") });
      chunks.push({
        owner: actor,
        kind: "notes",
        path: join(root, "no-index.md"),
        text: "Unindexed chunk"
      });
      links.push({ owner: actor, from: join(root, "no-index.md"), to: "/keep-target.md" });
    }
    async function reset() {
      for (const table of ["memory_chunks", "memory_links", "memory_file_index"])
        await bootstrap.query(`DELETE FROM app.${table} WHERE owner_user_id=ANY($1::uuid[])`, [
          actors
        ]);
      await bootstrap.query(
        "INSERT INTO app.memory_chunks(owner_user_id,source_kind,source_path,text,line_start,line_end,content_hash,embed_model_name,embed_model_version) SELECT owner,kind,path,text,0,0,'fixture','fixture','0' FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,kind text,path text,text text)",
        [JSON.stringify(chunks)]
      );
      await bootstrap.query(
        'INSERT INTO app.memory_links(owner_user_id,from_path,to_path) SELECT owner,"from","to" FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,"from" text,"to" text)',
        [JSON.stringify(links)]
      );
      await bootstrap.query(
        "INSERT INTO app.memory_file_index(owner_user_id,source_kind,source_path,file_hash,chunk_count,embed_model_name,embed_model_version) SELECT owner,kind,path,hash,1,'fixture','0' FROM jsonb_to_recordset($1::jsonb) AS x(owner uuid,kind text,path text,hash text)",
        [JSON.stringify(index)]
      );
    }
    const ast = ts.createSourceFile(
      "jobs.ts",
      readFileSync(new URL("../../../packages/notes/src/jobs.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.ES2022,
      true
    );
    const node = ast.statements.find(
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.text === "purgeDeletedNotes"
    );
    if (!node) throw new Error("Legacy cleanup is missing");
    const purge = runInNewContext(
      ts.transpileModule(`${node.getText(ast)}\npurgeDeletedNotes;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }).outputText,
      { realpath, NOTES_SOURCE_KIND: "notes", Set }
    ) as (
      db: unknown,
      actor: string,
      root: string,
      files: string[],
      repository: MemoryRepository
    ) => Promise<void>;
    const cases = [];
    for (const [role, database] of [
      ["app", app],
      ["worker", worker]
    ] as const)
      for (const actor of actors)
        for (const scenario of [
          { name: "ordinary", source: root, files: walked },
          { name: "empty", source: empty, files: [] as string[] }
        ]) {
          await reset();
          await new DataContextRunner(database).withDataContext({ actorUserId: actor }, (db) =>
            purge(db, actor, scenario.source, scenario.files, new MemoryRepository())
          );
          cases.push({
            role,
            actor,
            ...scenario,
            expected: (await bootstrap.query(snapshotSql, [actors])).rows[0]?.value
          });
        }
    await reset();
    const baseline: unknown = (await bootstrap.query(snapshotSql, [actors])).rows[0]?.value;
    await writeFile(
      path,
      JSON.stringify({
        actors,
        root,
        empty,
        walked,
        chunks,
        links,
        index,
        snapshotSql,
        baseline,
        cases
      }),
      { mode: 0o600 }
    );
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
