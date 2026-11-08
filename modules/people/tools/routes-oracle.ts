// Legacy HTTP handlers, real account transactions and disposable database rows.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultContextRunner } from "@moss/vault";
import Fastify from "fastify";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { registerPeopleRoutes } from "../../../packages/people/src/routes.js";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";

export const peopleTables = [
  "app.person_context_people",
  "app.person_context_identities",
  "app.person_context_links",
  "app.person_context_link_sources",
  "app.person_context_match_candidates",
  "app.person_context_events",
  "app.person_context_indexing_state"
] as const;

export async function routesOracle() {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const database = createDatabase({ connectionString: urls.app });
  const actors = [randomUUID(), randomUUID(), randomUUID()];
  const [actor, other, admin] = actors;
  if (!actor || !other || !admin) throw new Error("Missing fixture actors");
  const ids = Object.fromEntries(
    ["primary", "secondary", "identity", "link", "accept", "reject", "suppress", "explicit"].map(
      (name) => [name, randomUUID()]
    )
  );
  const root = await mkdtemp(join(tmpdir(), "moss-people-http-folders-"));
  const selected = join(root, "People");
  await mkdir(join(selected, "Family", "Friends"), { recursive: true });
  await mkdir(join(selected, "Work"));
  const oldRoots = process.env.MOSS_NOTES_ROOTS;
  process.env.MOSS_NOTES_ROOTS = root;
  const apps = actors.map((actorUserId) => {
    const app = Fastify();
    registerPeopleRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "people-route-oracle" }),
      dataContext: new DataContextRunner(database),
      vaultRunner: new VaultContextRunner(join(root, "private"))
    });
    setMossErrorHandler(app);
    return app;
  });
  const cleanup = async () => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
      if (oldRoots === undefined) delete process.env.MOSS_NOTES_ROOTS;
      else process.env.MOSS_NOTES_ROOTS = oldRoots;
      await rm(root, { recursive: true, force: true });
      await Promise.allSettled([
        bootstrap.end(),
        database.destroy(),
        ...apps.map((a) => a.close())
      ]);
    }
  };
  const seed = async () => {
    for (const table of [...peopleTables].reverse()) {
      await bootstrap.query(`DELETE FROM ${table} WHERE owner_user_id=$1`, [actor]);
    }
    await bootstrap.query(
      `INSERT INTO app.person_context_people(id,owner_user_id,display_name,relationship_summary,context_summary,status,confidence,created_at,updated_at)
       VALUES($1,$3,'Route Alpha','Keeps relationship','Keeps context','active',0.75,'2020-01-01Z','2020-01-01Z'),
             ($2,$3,'Route Beta',NULL,NULL,'active',0.5,'2020-01-02Z','2020-01-02Z')`,
      [ids.primary, ids.secondary, actor]
    );
    await bootstrap.query(
      `INSERT INTO app.person_context_identities(id,owner_user_id,person_id,identity_kind,source_kind,normalized_value,display_value,status,first_seen_at,last_seen_at,created_at,updated_at)
       VALUES($1,$2,$3,'email_address','email','route@example.test','Route address','active','2020-01-01Z','2020-01-01Z','2020-01-01Z','2020-01-01Z')`,
      [ids.identity, actor, ids.secondary]
    );
    await bootstrap.query(
      `INSERT INTO app.person_context_links(id,owner_user_id,person_id,source_kind,source_ref,source_ref_hash,link_kind,occurred_at,created_at,updated_at)
       VALUES($1,$2,$3,'email','synthetic-ref','route-hash','sender','2020-01-01Z','2020-01-01Z','2020-01-01Z')`,
      [ids.link, actor, ids.secondary]
    );
    for (const [index, name] of ["accept", "reject", "suppress", "explicit"].entries()) {
      await bootstrap.query(
        `INSERT INTO app.person_context_match_candidates(id,owner_user_id,candidate_kind,candidate_signature,suggested_display_name,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'2020-01-01Z'::timestamptz+$6*INTERVAL '1 second','2020-01-01Z')`,
        [
          ids[name],
          actor,
          name === "explicit" ? "merge_people" : "create_person",
          name,
          `Candidate ${name}`,
          index
        ]
      );
    }
  };
  try {
    await bootstrap.connect();
    for (const [index, id] of actors.entries()) {
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Route fixture',$3)",
        [id, `route-${id}@example.test`, index === 2]
      );
    }
    await seed();
    const startedAt = new Date().toISOString();
    let configured = false;
    const cases: {
      actor: string;
      method: string;
      path: string;
      body?: unknown;
      configured?: boolean;
      files?: Record<string, string>;
      expected: unknown;
      rows: Record<string, unknown>;
    }[] = [];
    const run = async (
      method: "GET" | "POST" | "PATCH" | "PUT",
      path: string,
      body?: unknown,
      actorIndex = 0
    ) => {
      const app = apps[actorIndex];
      if (!app) throw new Error("Missing fixture app");
      const response = await app.inject({
        method,
        url: `/api${path}`,
        ...(body !== undefined
          ? { payload: JSON.stringify(body), headers: { "content-type": "application/json" } }
          : {})
      });
      const rows: Record<string, unknown> = {};
      for (const table of peopleTables) {
        rows[table] = (
          await bootstrap.query(
            `SELECT to_jsonb(p) AS row FROM ${table} p WHERE owner_user_id=$1`,
            [actor]
          )
        ).rows.map((r: { row: unknown }) => r.row);
      }
      cases.push({
        actor: actors[actorIndex]!,
        method,
        path,
        ...(body !== undefined ? { body } : {}),
        ...(configured
          ? {
              configured: true,
              files: { "Route.md": await readFile(join(selected, "Route.md"), "utf8") }
            }
          : {}),
        expected: { status: response.statusCode, body: response.json() },
        rows
      });
    };
    await run("GET", "/people");
    // These are real Fastify/Ajv responses, including coercion and error order.
    for (const method of ["POST", "PATCH", "PUT"] as const) {
      const path =
        method === "POST"
          ? "/people"
          : method === "PUT"
            ? "/people/notes-settings"
            : `/people/${ids.primary}`;
      for (const body of [42, true, "text", [{ displayName: "Root array", folder: null }]])
        await run(method, path, body);
    }
    for (const body of [
      null,
      [],
      {},
      { displayName: {} },
      { displayName: "A", aliases: {} },
      { displayName: "A", emails: [null, {}] },
      { displayName: ["A", "B"] }
    ]) {
      await run("POST", "/people", body);
    }
    for (const body of [
      null,
      [],
      { displayName: {} },
      { status: "unknown" },
      { status: null },
      { aliases: {} },
      ...[23, 23.5, -0, 1e20, 1e21, 1e-6, 1e-7, Number("9007199254740993")].map((displayName) => ({
        displayName
      })),
      { displayName: null },
      { displayName: false },
      { status: ["active"] },
      { status: ["bad"] },
      { displayName: ["Coerced"] },
      { relationshipSummary: "Legacy summary", aliases: ["Unprojected alias"] }
    ]) {
      await run("PATCH", `/people/${ids.primary}`, body);
    }
    for (const body of [{}, { secondaryPersonId: {} }, { secondaryPersonId: [] }]) {
      await run("POST", `/people/${ids.primary}/merge`, body);
    }
    for (const body of [{}, { identityId: {} }, { identityId: ids.identity, targetPersonId: {} }]) {
      await run("POST", `/people/${ids.primary}/split-identity`, body);
    }
    await run("GET", "/people/notes-settings");
    for (const body of [{}, { folder: {} }, { folder: [] }, { folder: null }, { folder: "" }]) {
      await run("PUT", "/people/notes-settings", body);
    }
    await run("GET", "/people/notes-directories");
    await run("GET", "/people/notes-directories?path=child");
    await run("GET", "/people/notes-directories?path=a&path=b");
    await run("GET", "/people?status=active&status=archived");
    await run("GET", "/people?search=Route&search=Other");
    await run("GET", "/people/resolve?q=Route&q=Other");
    await run("GET", "/people/resolve");
    await run("GET", "/people?limit=4294967296");
    await run("GET", "/people?limit=9007199254740992");
    await run("GET", "/people?search=Route%20A&status=active&limit=1");
    for (const limit of ["0", "garbage", "%2B1tail", "-1", "1&limit=2"]) {
      await run("GET", `/people?limit=${limit}`);
    }
    await run("GET", "/people/resolve?q=%20ROUTE%40example.test%20");
    await run("GET", "/people/resolve?q=nobody");
    await run("GET", "/people/match-candidates");
    await run("GET", `/people/${ids.secondary}`);
    await run("GET", `/people/${ids.secondary}/links?sourceKind=email&linkKind=sender&limit=1`);
    await run("GET", `/people/${ids.secondary}/links?sourceKind=note`);
    await run("PATCH", `/people/${ids.primary}`, { displayName: "Route renamed" });
    await run("POST", `/people/${ids.primary}/archive`);
    await run("POST", `/people/${ids.primary}/merge`, { secondaryPersonId: ids.secondary });
    await run("POST", `/people/${ids.primary}/split-identity`, {
      identityId: ids.identity,
      newPersonDisplayName: "Route split"
    });
    for (const action of ["accept", "reject", "suppress"] as const) {
      await run("POST", `/people/match-candidates/${ids[action]}/${action}`);
    }
    await run("POST", `/people/match-candidates/${ids.explicit}/accept`);
    await run("POST", `/people/match-candidates/${randomUUID()}/accept`);
    await run("POST", "/people/notes/refresh");
    await run("POST", "/people", { displayName: "No configured folder" });
    for (const index of [1, 2]) {
      await run("GET", "/people", undefined, index);
      await run("GET", `/people/${ids.primary}`, undefined, index);
      await run("PATCH", `/people/${ids.primary}`, { displayName: "Must not change" }, index);
      await run("POST", `/people/${ids.primary}/archive`, undefined, index);
      await run(
        "POST",
        `/people/${ids.primary}/merge`,
        { secondaryPersonId: ids.secondary },
        index
      );
      await run(
        "POST",
        `/people/${ids.primary}/split-identity`,
        { identityId: ids.identity, targetPersonId: ids.primary },
        index
      );
      await run("POST", `/people/match-candidates/${ids.reject}/reject`, undefined, index);
    }
    // Same HTTP handlers with a real chosen folder and canonical file. Capture
    // bytes even after rejected edits so partial publication cannot hide in rows.
    const folderSeed = {
      "Route.md": `---
jarvisPersonId: ${ids.primary}
displayName: Route canonical
aliases: []
emails: []
phones: []
status: active
---
Human text stays.
`
    };
    await writeFile(join(selected, "Route.md"), folderSeed["Route.md"]);
    await bootstrap.query(
      "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'people-notes-folder',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json",
      [actor, JSON.stringify(selected)]
    );
    configured = true;
    await run("GET", "/people/notes-directories");
    await run("GET", "/people/notes-directories?path=Family");
    await run("PATCH", `/people/${ids.primary}`, { displayName: "Canonical renamed" });
    await run("PATCH", `/people/${ids.primary}`, { relationshipSummary: {}, contextSummary: [1] });
    await run("PATCH", `/people/${ids.primary}`, { aliases: "", emails: "", phones: "" });
    await run("PATCH", `/people/${ids.primary}`, {
      aliases: [1, true, null, {}, ["A", null, "B"]]
    });
    await run("PATCH", `/people/${ids.primary}`, {
      emails: [null, false, 12],
      phones: [null, ["1", "2"]]
    });
    await run("PATCH", `/people/${ids.primary}`, { aliases: { length: 0 }, emails: { length: 0 } });
    await run("PATCH", `/people/${ids.primary}`, { aliases: [{ toString: null }] });
    await run("PATCH", `/people/${ids.primary}`, { phones: {} });
    for (const aliases of ["x", true, 0, [[{ toString: null }]]]) {
      await run("PATCH", `/people/${ids.primary}`, { aliases });
    }
    await run("PATCH", `/people/${ids.primary}`, {
      aliases: [1.5, 1e-7, 1e21],
      phones: { length: 0 },
      status: "archived"
    });
    await run("POST", `/people/${ids.primary}/archive`);
    await run("PATCH", `/people/${ids.primary}`, { status: "active" });
    await bootstrap.query(
      "DELETE FROM app.preferences WHERE owner_user_id=$1 AND key='people-notes-folder'",
      [actor]
    );
    // Rust replays the workflow from exactly these original synthetic rows.
    await seed();
    return {
      value: {
        actor,
        other,
        admin,
        ids,
        startedAt,
        cases,
        folderSeed,
        knownIds: [...actors, ...Object.values(ids)]
      },
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
