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
import { formatPeopleNote } from "../../../packages/people/src/notes-format.js";
import { refreshCases, refreshQueue } from "./refresh-oracle.js";

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
  for (const name of ["Ü", "ü", "ǖ", "ǘ", "ǚ", "ǜ", "ű", "ũ", "ū", "á̈", "ä́", "Ş", "ș", "Ţ", "ț"])
    await mkdir(join(selected, "Family", "Friends", name));
  await mkdir(join(selected, "Family", "apple"));
  await mkdir(join(selected, "Family", "Banana"));
  await mkdir(join(selected, "Family", "Ábc"));
  await mkdir(join(selected, "Work"));
  for (const name of ["Banana", "apple", "Ära", "zebra", "\u1102\u1161", "가"])
    await mkdir(join(selected, name));
  const oldRoots = process.env.MOSS_NOTES_ROOTS;
  process.env.MOSS_NOTES_ROOTS = root;
  let refresh: Awaited<ReturnType<typeof refreshQueue>> | undefined;
  const apps = actors.map((actorUserId) => {
    const app = Fastify();
    registerPeopleRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "people-route-oracle" }),
      dataContext: new DataContextRunner(database),
      vaultRunner: new VaultContextRunner(join(root, "private")),
      get boss() {
        return refresh?.boss;
      }
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
        ...apps.map((a) => a.close()),
        refresh?.boss.stop()
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
    refresh = await refreshQueue(urls.bootstrap, bootstrap);
    for (const [index, id] of actors.entries()) {
      await bootstrap.query(
        "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Route fixture',$3)",
        [id, `route-${id}@example.test`, index === 2]
      );
    }
    await seed();
    const startedAt = new Date().toISOString();
    let configured = false;
    const notePaths = new Set<string>();
    const cases: {
      actor: string;
      method: string;
      path: string;
      body?: unknown;
      configured?: boolean;
      files?: Record<string, string>;
      seedFiles?: Record<string, string>;
      expected: unknown;
      rows: Record<string, unknown>;
      queued?: unknown[];
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
      const expected: unknown = response.json();
      if (configured && method === "POST" && path === "/people/notes/refresh") {
        const result = response.json<{
          discovered: number;
          projected: number;
          ignored: number;
          candidates: number;
        }>();
        if (
          response.statusCode !== 200 ||
          result.discovered !== 7 ||
          result.projected !== 3 ||
          result.ignored !== 1 ||
          // Missing ID, duplicate pair, and two unmerged records without notes.
          result.candidates !== 4
        )
          throw new Error(`Nested refresh coverage mismatch: ${JSON.stringify(result)}`);
        console.log("Nested People refresh coverage:", JSON.stringify(result));
      }
      if (configured && method === "POST" && path === "/people") {
        if (response.statusCode !== 200) throw new Error("Configured People creation must succeed");
        const notePath: unknown = response.json().notePath;
        if (typeof notePath !== "string") throw new Error("Created People note path missing");
        notePaths.add(notePath);
      }
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
              files: Object.fromEntries(
                await Promise.all(
                  [...notePaths].map(async (path) => [
                    path,
                    await readFile(join(selected, path), "utf8")
                  ])
                )
              )
            }
          : {}),
        expected: { status: response.statusCode, body: expected },
        rows,
        ...(path === "/people/index/refresh" ? { queued: await refresh!.snapshot() } : {})
      });
    };
    // Parse strings so __proto__ is an own JSON member, not object-literal syntax.
    const forbiddenBodies: unknown[] = [
      '{"__proto__":null}',
      '{"constructor":{"prototype":false}}',
      '{"extra":[{"nested":{"__proto__":{}}}]}',
      '{"aliases":[{"constructor":{"prototype":null}}]}',
      '[{"__proto__":true}]',
      '{"folder":"Work","extra":{"__proto__":{}}}',
      '{"extra":{"constructor":[{"__proto__":null}]}}',
      '{"extra":{"constr\\u0075ctor":{"proto\\u0074ype":null}}}'
    ].map((text) => JSON.parse(text));
    const parserCases = async (method: "POST" | "PATCH" | "PUT", path: string) => {
      for (const body of forbiddenBodies) {
        await run(method, path, body);
        const expected = cases.at(-1)?.expected;
        if (
          JSON.stringify(expected) !==
          JSON.stringify({
            status: 400,
            body: {
              error: "Body is not valid JSON but content-type is set to 'application/json'"
            }
          })
        )
          throw new Error(`Legacy JSON parser rejection changed: ${JSON.stringify(expected)}`);
      }
    };
    await run("GET", "/people");
    // Fastify does not parse GET bodies, even if a JSON content type is supplied.
    for (const body of forbiddenBodies) await run("GET", "/people", body);
    await parserCases("POST", "/people");
    await parserCases("PUT", "/people/notes-settings");
    await parserCases("POST", `/people/${ids.primary}/archive`);
    // Similar-looking valid members must keep their ordinary legacy result.
    for (const extra of [
      { constructor: null },
      { constructor: false },
      { constructor: "prototype" },
      { constructor: [] },
      { constructor: { name: "prototype" } },
      { prototype: {} },
      { text: "__proto__" },
      { Constructor: { prototype: true }, __Proto__: true }
    ])
      await run("PUT", "/people/notes-settings", { folder: "", ...extra });
    await refreshCases(run);
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
      ...[
        23,
        23.5,
        -0,
        1e20,
        1e21,
        1e-6,
        1e-7,
        Number("652282746268236.2"),
        Number("-245777903432188.62"),
        Number("9007199254740993"),
        2 ** -24,
        -(2 ** -24),
        // Component-parser regression. The host test binary also enables
        // float_roundtrip via its native People dev-dependency; this does not
        // qualify the shipping host/listener's upstream JSON parsing.
        Number("2.3050789863520357e+299")
      ].map((displayName) => ({
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
`,
      "Family/Missing.md": "---\ndisplayName: Missing id\nstatus: active\n---\nNeeds review.\n",
      "Family/Invalid.md": "Ordinary markdown without People frontmatter.\n",
      "Work/Upper.MD": "---\ndisplayName: Ignored uppercase extension\n---\n",
      "Family/Duplicate.md": `---\njarvisPersonId: ${ids.secondary}\ndisplayName: Duplicate one\nstatus: active\n---\n`,
      "Work/Duplicate.md": `---\njarvisPersonId: ${ids.secondary}\ndisplayName: Duplicate two\nstatus: active\n---\n`,
      "Family/New.md": `---\njarvisPersonId: ${ids.explicit}\ndisplayName: New canonical\naliases:\n  - New alias\nemails:\n  - new@example.test\nstatus: active\n---\n`
    };
    for (const [path, content] of Object.entries(folderSeed)) {
      await writeFile(join(selected, path), content);
      notePaths.add(path);
    }
    await bootstrap.query(
      "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'people-notes-folder',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json",
      [actor, JSON.stringify(selected)]
    );
    configured = true;
    // Capture canonical bytes and all seven tables after every rejected edit.
    await parserCases("PATCH", `/people/${ids.primary}`);
    await run("GET", "/people/notes-directories");
    await run("GET", "/people/notes-directories?path=Family");
    await run("GET", "/people/notes-directories?path=Family/Friends");
    for (const path of [
      ".",
      "Family/",
      "Family/./Friends",
      "Family//Friends",
      "missing",
      "../Work"
    ])
      await run("GET", `/people/notes-directories?path=${encodeURIComponent(path)}`);
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
    // Retain the part-eight fixture with an existing managed section and human text.
    // Per-case seeds let both independently built workflows replay in sequence.
    const noteContent = formatPeopleNote({
      frontmatter: {
        jarvisPersonId: ids.primary!,
        displayName: "Route Alpha",
        aliases: ["Original"],
        emails: ["route@example.test"],
        phones: ["123"],
        status: "active"
      },
      body: "# Route Alpha\n\nHuman 🪴 text.\n<!-- jarvis:people:start -->\nOld summary\n<!-- jarvis:people:end -->\nHuman suffix.\n"
    });
    await writeFile(join(selected, "Route.md"), noteContent);
    const additionalStart = cases.length;
    for (const body of [
      { displayName: "Note-backed edit" },
      { aliases: [23, true, null, ["Nested", null], {}] },
      { aliases: "" },
      { emails: [23, false, null, ["Nested", null], {}] },
      { phones: [23, false, null, ["Nested", null], {}] },
      { phones: { length: 0 } },
      { aliases: { length: 1 } },
      { aliases: [{ toString: "not callable" }] },
      { aliases: null },
      { status: "archived" },
      { displayName: "Restored", aliases: null, emails: null, phones: null },
      {
        displayName: Number("652282746268236.2"),
        aliases: [Number("652282746268236.8")],
        emails: [Number("-245777903432188.62")],
        phones: [Number("198676698324544.12")]
      },
      {
        displayName: Number("2.3050789863520357e+299"),
        aliases: [Number("2.3050789863520357e+299")],
        emails: [Number("2.3050789863520357e+299")],
        phones: [Number("2.3050789863520357e+299")]
      },
      { displayName: "Final note-backed edit" }
    ])
      await run("PATCH", `/people/${ids.primary}`, body);
    for (const index of [1, 2])
      await run("PATCH", `/people/${ids.primary}`, { displayName: "Must stay private" }, index);
    cases[additionalStart]!.seedFiles = { "Route.md": noteContent };
    // Keep the positive installed-consumer fixture from part seven meaningful.
    await run("PATCH", `/people/${ids.primary}`, {
      displayName: "Canonical renamed",
      status: "active"
    });
    await run("POST", "/people", {
      displayName: "Created Person",
      aliases: ["Created alias"],
      emails: ["created@example.test"],
      phones: ["12345"]
    });
    await run("GET", "/people?search=Created");
    await run("GET", "/people/resolve?q=created%40example.test");
    await run("POST", "/people/notes/refresh");
    await run("POST", "/people/notes/refresh");
    await run("GET", "/people/match-candidates");
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
