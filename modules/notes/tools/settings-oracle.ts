// Actual legacy Settings handlers on the same disposable database as the guest.
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { PreferencesRepository } from "../../../packages/structured-state/src/preferences-repository.js";
import { registerNotesSourceRoutes } from "../../../packages/settings/src/notes-source-routes.js";

export async function settingsOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const db = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const folder = await mkdtemp(join(tmpdir(), "moss-notes-settings-"));
  const path = join(folder, "expected.json");
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const roots = actors.map((actor) => join(folder, actor));
  const server = Fastify();
  let actor = actors[0]!;
  const previousRoots = process.env.JARVIS_NOTES_ROOTS;
  const cleanup = async () => {
    if (previousRoots === undefined) delete process.env.JARVIS_NOTES_ROOTS;
    else process.env.JARVIS_NOTES_ROOTS = previousRoots;
    try {
      await db.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      await Promise.allSettled([
        server.close(),
        db.end(),
        app.destroy(),
        rm(folder, { recursive: true, force: true })
      ]);
    }
  };
  try {
    await db.connect();
    for (const [index, id] of actors.entries()) {
      await db.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Notes settings oracle',$3)",
        [id, `notes-settings-${id}@example.test`, index === 2]
      );
      await mkdir(join(roots[index]!, "Journal"), { recursive: true });
      await writeFile(join(roots[index]!, "keep.md"), "Private notes fixture");
    }
    registerNotesSourceRoutes(server, {
      dataContext: new DataContextRunner(app),
      resolveAccessContext: async () => ({ actorUserId: actor }),
      preferencesRepository: new PreferencesRepository()
    });
    await server.ready();
    const expected = [];
    for (const [index, id] of actors.entries()) {
      actor = id;
      process.env.JARVIS_NOTES_ROOTS = roots[index]!;
      const variants = [
        { method: "GET", route: "/notes-source", source: null, status: null },
        { method: "GET", route: "/notes-source", source: { invalid: true }, status: null },
        { method: "GET", route: "/notes-source", source: roots[index]!, status: null },
        ...[
          null,
          {},
          { at: 3 },
          {
            at: "2026-11-08T12:00:00Z",
            ingested: 4,
            skipped: "invalid",
            errors: 2,
            lastError: "Safe saved error",
            secret: "not returned"
          }
        ].map((status) => ({ method: "GET", route: "/notes-last-sync", source: null, status })),
        { method: "GET", route: "/notes-source/directories", source: null, status: null },
        {
          method: "GET",
          route: `/notes-source/directories?path=${encodeURIComponent(roots[index]!)}`,
          source: null,
          status: null
        },
        {
          method: "PUT",
          route: "/notes-source",
          source: null,
          status: null,
          body: { path: roots[index]! }
        },
        {
          method: "PUT",
          route: "/notes-source",
          source: null,
          status: null,
          body: { path: join(roots[index]!, "Journal") }
        },
        {
          method: "PUT",
          route: "/notes-source",
          source: roots[index]!,
          status: null,
          body: { path: null }
        },
        { method: "PUT", route: "/notes-source", source: roots[index]!, status: null, body: null },
        { method: "PUT", route: "/notes-source", source: roots[index]!, status: null, body: {} },
        // Keep an existing link while checking errors: a rejected selection must
        // not silently unlink it. Use real filesystem paths, not error stand-ins.
        ...["", join(roots[index]!, "missing"), roots[(index + 1) % roots.length]!].flatMap(
          (path) => [
            {
              method: "PUT",
              route: "/notes-source",
              source: roots[index]!,
              status: null,
              body: { path }
            },
            {
              method: "GET",
              route: `/notes-source/directories?path=${encodeURIComponent(path)}`,
              source: roots[index]!,
              status: null
            }
          ]
        )
      ];
      for (const entry of variants) {
        await db.query("DELETE FROM app.preferences WHERE owner_user_id=$1", [id]);
        for (const [key, value] of [
          ["notes-source-path", entry.source],
          ["notes-last-sync", entry.status]
        ]) {
          await db.query(
            "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3::jsonb)",
            [id, key, JSON.stringify(value)]
          );
        }
        const reply = await server.inject({
          method: entry.method as "GET" | "PUT",
          url: `/api/me${entry.route}`,
          ...("body" in entry && entry.body !== null ? { payload: entry.body } : {})
        });
        const saved = await db.query(
          "SELECT value_json,revision FROM app.preferences WHERE owner_user_id=$1 AND key='notes-source-path'",
          [id]
        );
        expected.push({
          actor: id,
          ...entry,
          expected: { status: reply.statusCode, body: reply.json() },
          savedSource: saved.rows[0]?.value_json ?? null,
          savedRevision: saved.rows[0]?.revision
        });
      }
    }
    await writeFile(path, JSON.stringify({ actors, roots, expected }), { mode: 0o600 });
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
