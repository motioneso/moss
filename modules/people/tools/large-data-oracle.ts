// Real legacy reads across the module host's thousand-row query boundary.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type DataContextRunner } from "@moss/db";
import Fastify from "fastify";
import { PeopleRepository } from "../../../packages/people/src/repository.js";
import { findPeopleByNames } from "../../../packages/people/src/find-by-names.js";
import { registerPeopleRoutes } from "../../../packages/people/src/routes.js";

export async function largeDataOracle(
  bootstrap: pg.Client,
  runner: DataContextRunner,
  actor: string
) {
  const ids = Array.from({ length: 1005 }, () => randomUUID());
  await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Paging oracle')", [
    actor,
    `paging-${actor}@example.test`
  ]);
  await bootstrap.query(
    `INSERT INTO app.person_context_people(id,owner_user_id,display_name,status,created_at,updated_at)
     SELECT id,$1,'Paging '||lpad(n::text,4,'0'),'active',
       '2020-01-01Z'::timestamptz+n*INTERVAL '1 second','2020-01-01Z'
     FROM unnest($2::uuid[]) WITH ORDINALITY AS input(id,n)`,
    [actor, ids]
  );
  await bootstrap.query(
    `INSERT INTO app.person_context_identities(owner_user_id,person_id,identity_kind,source_kind,
       normalized_value,display_value,status,first_seen_at,last_seen_at,created_at,updated_at)
     SELECT $1,id,kind::app.person_context_identity_kind,'manual',value,value,
       (CASE WHEN kind='email_address' AND n=1005 THEN 'rejected' ELSE 'active' END)::app.person_context_identity_status,
       '2020-01-01Z','2020-01-01Z','2020-01-01Z','2020-01-01Z'
     FROM unnest($2::uuid[]) WITH ORDINALITY AS input(id,n)
     CROSS JOIN LATERAL (VALUES ('alias','Paging alias'),
       ('email_address','paging-'||CASE WHEN n=1005 THEN 1 ELSE n END||'@example.test')) AS identity(kind,value)`,
    [actor, ids]
  );
  await bootstrap.query(
    `INSERT INTO app.person_context_links(owner_user_id,person_id,source_kind,source_ref,source_ref_hash,
       link_kind,occurred_at,created_at,updated_at)
     SELECT $1,$2,(CASE WHEN n<=1000 THEN 'manual' ELSE 'note' END)::app.person_context_source_kind,'paging-'||n,'paging-hash-'||n,'related',
       '2020-01-01Z'::timestamptz+n*INTERVAL '1 second','2020-01-01Z','2020-01-01Z'
     FROM generate_series(1,1005) n`,
    [actor, ids[0]]
  );
  const repo = new PeopleRepository();
  const app = Fastify();
  registerPeopleRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "people-paging-oracle" }),
    dataContext: runner
  });
  try {
    const cases: { kind: string; request: unknown; expected: unknown; count: number }[] = [];
    for (const limit of [999, 1000, 1001, 1005, 1006, undefined]) {
      const query = limit === undefined ? {} : { limit: String(limit) };
      for (const links of [false, true]) {
        const path = links ? `/people/${ids[0]}/links` : "/people";
        const response = await app.inject({
          method: "GET",
          url: `/api${path}${limit === undefined ? "" : `?limit=${limit}`}`
        });
        const body = response.json<{ people?: unknown[]; links?: unknown[] }>();
        const rows = links ? body.links : body.people;
        const count = Math.min(limit ?? 1005, 1005);
        if (response.statusCode !== 200 || rows?.length !== count)
          throw new Error("Legacy paging fixture lost rows");
        cases.push({
          kind: "route",
          request: {
            method: "GET",
            path: links ? "/people/:id/links" : "/people",
            params: links ? { id: ids[0] } : {},
            query,
            body: null
          },
          expected: { status: response.statusCode, body },
          count
        });
      }
    }
    // An unbounded query with exactly one full page must terminate on its next,
    // empty page. A finite limit of 1000 would not exercise that branch.
    const filtered = await app.inject({
      method: "GET",
      url: `/api/people/${ids[0]}/links?sourceKind=manual`
    });
    const filteredBody = filtered.json<{ links: unknown[] }>();
    if (filtered.statusCode !== 200 || filteredBody.links.length !== 1000)
      throw new Error("Legacy exact-page fixture lost rows");
    cases.push({
      kind: "route",
      request: {
        method: "GET",
        path: "/people/:id/links",
        params: { id: ids[0] },
        query: { sourceKind: "manual" },
        body: null
      },
      expected: { status: filtered.statusCode, body: filteredBody },
      count: 1000
    });
    const [names, emails] = await runner.withDataContext(
      { actorUserId: actor },
      async (scope) =>
        [
          await findPeopleByNames(scope, actor, ["Paging alias", "Paging 1005"]),
          await repo.listEmailIdentityValues(scope, actor)
        ] as const
    );
    if (names.length !== 1005 || emails.length !== 1005)
      throw new Error("Legacy API paging fixture lost rows");
    if (emails.filter((email) => email === "paging-1@example.test").length !== 2)
      throw new Error("Legacy email fixture lost its duplicate");
    cases.push(
      {
        kind: "api",
        request: {
          name: "findPeopleByNames",
          parameters: { names: ["Paging alias", "Paging 1005"] }
        },
        expected: names,
        count: 1005
      },
      {
        kind: "api",
        request: { name: "listEmailIdentityValues", parameters: {} },
        expected: emails,
        count: 1005
      }
    );
    return { actor, cases };
  } finally {
    await app.close();
  }
}
