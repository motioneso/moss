// Legacy HTTP handlers, real account transactions and disposable database rows.
import { randomUUID } from "node:crypto";
import Fastify, { type HTTPMethods } from "fastify";
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
  const apps = actors.map((actorUserId) => {
    const app = Fastify();
    registerPeopleRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId, requestId: "people-route-oracle" }),
      dataContext: new DataContextRunner(database)
    });
    setMossErrorHandler(app);
    return app;
  });
  const cleanup = async () => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actors]);
    } finally {
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
      `INSERT INTO app.person_context_people(id,owner_user_id,display_name,status,confidence,created_at,updated_at)
       VALUES($1,$3,'Route Alpha','active',0.75,'2020-01-01Z','2020-01-01Z'),
             ($2,$3,'Route Beta','active',0.5,'2020-01-02Z','2020-01-02Z')`,
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
    const cases: {
      actor: string;
      method: string;
      path: string;
      body?: unknown;
      expected: unknown;
      rows: Record<string, unknown>;
    }[] = [];
    const run = async (
      method: HTTPMethods,
      path: string,
      body?: Record<string, unknown>,
      actorIndex = 0
    ) => {
      const app = apps[actorIndex];
      if (!app) throw new Error("Missing fixture app");
      const response = await app.inject({
        method,
        url: `/api${path}`,
        ...(body ? { payload: body } : {})
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
        ...(body ? { body } : {}),
        expected: { status: response.statusCode, body: response.json() },
        rows
      });
    };
    await run("GET", "/people");
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
        knownIds: [...actors, ...Object.values(ids)]
      },
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
