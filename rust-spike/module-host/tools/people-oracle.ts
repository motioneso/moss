// Database differential oracle only: run the current TypeScript implementation on
// synthetic rows, then let the native Rust port read the exact same committed rows.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { PeopleRepository } from "../../../packages/people/src/repository.js";
import { PersonContextService } from "../../../packages/people/src/service.js";
import { findPeopleByNames } from "../../../packages/people/src/find-by-names.js";
import { notesOracle } from "./people-notes-oracle.js";
import { mutationOracle } from "./people-mutation-oracle.js";

export async function peopleOracle(): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
  const urls = getMossDatabaseUrls();
  const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
  const app = createDatabase({ connectionString: urls.app });
  const folder = await mkdtemp(join(tmpdir(), "moss-people-oracle-"));
  const actor = randomUUID();
  const person = randomUUID();
  const archived = randomUUID();
  const path = join(folder, "expected.json");
  const cleanup = async (): Promise<void> => {
    try {
      await bootstrap.query("DELETE FROM app.users WHERE id=$1", [actor]);
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
    await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'People oracle')", [
      actor,
      `people-oracle-${actor}@example.test`
    ]);
    await bootstrap.query(
      `INSERT INTO app.person_context_people(id,owner_user_id,display_name,relationship_summary,context_summary,status,confidence,created_at,updated_at)
      VALUES($1,$3,'Alice_%','Friend','A private summary','active',0.75,'2020-01-02T03:04:05.123456Z','2020-01-02T03:04:05.123456Z'),
      ($2,$3,'Archived Person',null,null,'archived',0.5,'2020-01-02T03:04:06Z','2020-01-02T03:04:06Z')`,
      [person, archived, actor]
    );
    await bootstrap.query(
      `INSERT INTO app.person_context_identities(owner_user_id,person_id,identity_kind,source_kind,normalized_value,display_value,status,confidence)
      VALUES($1,$2,'alias','manual','Al_%','Al_%','active',0.75),($1,$3,'email_address','email','archived@example.test','archived@example.test','rejected',0.5)`,
      [actor, person, archived]
    );
    await bootstrap.query(
      `INSERT INTO app.person_context_links(owner_user_id,person_id,source_kind,source_ref,source_ref_hash,link_kind,occurred_at,created_at)
      SELECT $1,$2,'manual','private-ref-'||n,'hash-'||n,'related',CASE WHEN n=1 THEN NULL ELSE '2020-01-02T03:04:05Z'::timestamptz+n*INTERVAL '1 second' END,'2020-01-02T03:04:05Z'::timestamptz+n*INTERVAL '1 second'
      FROM generate_series(1,24) n`,
      [actor, person]
    );
    const aliasPerson = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.person_context_people(id,owner_user_id,display_name,relationship_summary,context_summary,status,created_at)
       VALUES($1,$2,'Alias Person',$3,$4,'active','2019-01-01Z')`,
      [aliasPerson, actor, " \r\n  Role line \r\nsecond line", `\nX${"🪴".repeat(100)}\nignored`]
    );
    await bootstrap.query(
      `INSERT INTO app.person_context_identities(owner_user_id,person_id,identity_kind,source_kind,normalized_value,display_value,status)
       VALUES($1,$2,'alias','manual','first alias','First Alias','active'),
             ($1,$2,'display_name','manual','friendly name','Friendly Name','active'),
             ($1,$2,'alias','manual','inactive','Inactive','rejected'),
             ($1,$3,'alias','manual','archived alias','Archived Alias','active')`,
      [actor, aliasPerson, archived]
    );
    const runner = new DataContextRunner(app);
    const repo = new PeopleRepository();
    const service = new PersonContextService(repo);
    const guestCases: {
      request: { name: string; parameters: Record<string, unknown> };
      expected: unknown;
    }[] = await runner.withDataContext({ actorUserId: actor }, async (scope) => [
      {
        request: { name: "getPerson", parameters: { personId: person } },
        expected: await service.getPerson(scope, actor, person)
      },
      {
        request: { name: "resolve", parameters: { query: "  aL_%  " } },
        expected: { person: await service.resolve(scope, actor, "  aL_%  ") }
      },
      {
        request: { name: "resolve", parameters: { query: "archived@example.test" } },
        expected: { person: await service.resolve(scope, actor, "archived@example.test") }
      },
      {
        request: { name: "resolve", parameters: { query: "AliceZZ" } },
        expected: { person: await service.resolve(scope, actor, "AliceZZ") }
      },
      {
        request: { name: "listEmailIdentityValues", parameters: {} },
        expected: await repo.listEmailIdentityValues(scope, actor)
      }
    ]);
    await runner.withDataContext({ actorUserId: actor }, async (scope) => {
      for (const names of [
        [],
        [" \ufeff", "ALICE_%", "aLiCe_%", "Al_%"],
        ["First Alias", "Alias Person", "Friendly Name", "Alice_%"],
        ["First Alias", "Friendly Name", "Al_%"],
        ["Inactive", "Archived Alias", "Archived Person", "AliceZZ", "Alice"],
        [...Array<string>(30).fill(" "), "Alice_%"],
        ["Alias Person", "ALIAS PERSON", "aLiAs PeRsOn"],
        ["\ufeff First Alias \u00a0", "aL_%"]
      ]) {
        guestCases.push({
          request: { name: "findPeopleByNames", parameters: { names } },
          expected: await findPeopleByNames(scope, actor, names)
        });
      }
    });
    const cases = await runner.withDataContext({ actorUserId: actor }, async (scope) => [
      {
        operation: "get",
        parameters: { id: person },
        expected: await repo.getPerson(scope, actor, person)
      },
      {
        operation: "list",
        parameters: {},
        expected: await repo.listPeople(scope, actor, { status: "active" })
      },
      {
        operation: "list-options",
        parameters: { status: "", search: "", limit: 0 },
        expected: await repo.listPeople(scope, actor, { status: "", search: "", limit: 0 })
      },
      {
        operation: "list-options",
        parameters: { search: "Alice_%", limit: 1 },
        expected: await repo.listPeople(scope, actor, { search: "Alice_%", limit: 1 })
      },
      {
        operation: "links-options",
        parameters: { id: person, sourceKind: "", linkKind: "", limit: 0 },
        expected: await repo.listLinks(scope, actor, person, {
          sourceKind: "",
          linkKind: "",
          limit: 0
        })
      },
      {
        operation: "detail",
        parameters: { id: person },
        expected: {
          identities: await repo.listIdentities(scope, actor, person),
          links: await repo.listLinks(scope, actor, person, { limit: 20 }),
          emails: await repo.listEmailIdentityValues(scope, actor)
        }
      },
      {
        operation: "resolve",
        parameters: { query: "  aL_%  " },
        expected: await service.resolve(scope, actor, "  aL_%  ")
      },
      {
        operation: "resolve",
        parameters: { query: "archived@example.test" },
        expected: await service.resolve(scope, actor, "archived@example.test")
      },
      {
        operation: "resolve",
        parameters: { query: "AliceZZ" },
        expected: await service.resolve(scope, actor, "AliceZZ")
      },
      {
        operation: "resolve",
        parameters: { query: "Alice_%" },
        expected: await service.resolve(scope, actor, "Alice_%")
      }
    ]);
    // Also record the raw persisted projection, not just the returned response.
    const rows = (
      await bootstrap.query(
        "SELECT to_jsonb(p) AS row FROM app.person_context_people p WHERE owner_user_id=$1 ORDER BY id",
        [actor]
      )
    ).rows.map((r: { row: unknown }) => r.row);
    const projectionId = randomUUID();
    const projection = await runner.withDataContext({ actorUserId: actor }, (scope) =>
      repo.upsertPersonProjection(scope, {
        ownerUserId: actor,
        personId: projectionId,
        displayName: "Private Person",
        relationshipSummary: "Friend",
        contextSummary: "Private summary",
        status: "active",
        confidence: 0.75
      })
    );
    const projectionRow = (
      await bootstrap.query(
        "SELECT to_jsonb(p) AS row FROM app.person_context_people p WHERE id=$1",
        [projectionId]
      )
    ).rows[0] as { row: unknown };
    await bootstrap.query("DELETE FROM app.person_context_people WHERE id=$1", [projectionId]);
    let mutation: unknown;
    let notes: unknown;
    const rollback = new Error("Roll back the TypeScript mutation oracle");
    try {
      await runner.withDataContext({ actorUserId: actor }, async (scope) => {
        mutation = await mutationOracle(scope, actor);
        notes = await notesOracle(scope, actor);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    await writeFile(
      path,
      JSON.stringify({
        actor,
        personId: person,
        cases,
        guestCases,
        rows,
        projection,
        projectionRow: projectionRow.row,
        projectionId,
        mutation,
        notes
      })
    );
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
