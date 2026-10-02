import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClassifierReleaseRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2881: approved tool release eligibility. The table is empty by default (so turning the
// classifier gate `on` is refused). Instance-global admin data under RLS: every authed actor may
// read it, only an admin may write it. Empty-by-default is the security property that keeps the
// gate from being enabled before a release is reviewed.

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new ClassifierReleaseRepository();

const asActor = <T>(
  actorUserId: string,
  work: (db: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
) => dataContext.withDataContext({ actorUserId, requestId: "release-test" }, work);

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("app.chat_classifier_release_eligibility", () => {
  it("forces row security and lets the app role delete (admin-gated) but not the worker", async () => {
    const table = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'app.chat_classifier_release_eligibility'::regclass
    `.execute(appDb);
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const grant = await sql<{ app_delete: boolean; worker_delete: boolean }>`
      SELECT
        has_table_privilege('jarvis_app_runtime', 'app.chat_classifier_release_eligibility', 'DELETE') AS app_delete,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_classifier_release_eligibility', 'DELETE') AS worker_delete
    `.execute(appDb);
    expect(grant.rows[0]).toEqual({ app_delete: true, worker_delete: false });
  });

  it("is empty by default, so there is no eligible release", async () => {
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.chat_classifier_release_eligibility
    `.execute(appDb);
    expect(count.rows[0]?.n).toBe("0");
    expect(await asActor(ids.adminUser, (db) => repository.hasEligibleRelease(db))).toBe(false);
  });

  it("reports eligibility once an admin records a release, and lists the record", async () => {
    const moduleId = "calendar";
    const toolName = `calendar.listVisibleEvents.${Date.now()}`;
    await asActor(ids.adminUser, (db) =>
      sql`
        INSERT INTO app.chat_classifier_release_eligibility
          (module_id, tool_name, classifier_config_version, approved_by_user_id)
        VALUES (${moduleId}, ${toolName}, 'cfg-v1', ${ids.adminUser}::uuid)
      `.execute(db.db)
    );

    expect(await asActor(ids.adminUser, (db) => repository.hasEligibleRelease(db))).toBe(true);

    const records = await asActor(ids.adminUser, (db) => repository.listEligibleReleases(db));
    const match = records.find((r) => r.toolName === toolName);
    expect(match).toMatchObject({
      moduleId,
      toolName,
      classifierConfigVersion: "cfg-v1",
      approvedByUserId: ids.adminUser
    });
    expect(typeof match?.approvedAt).toBe("string");
  });

  it("is readable by a non-admin but not writable by one", async () => {
    // Read: instance-global admin data is visible to every authed actor.
    expect(await asActor(ids.userA, (db) => repository.hasEligibleRelease(db))).toBe(true);

    // Write: RLS WITH CHECK requires current_actor_is_admin().
    await expect(
      asActor(ids.userA, (db) =>
        sql`
          INSERT INTO app.chat_classifier_release_eligibility
            (module_id, tool_name, classifier_config_version, approved_by_user_id)
          VALUES ('calendar', 'forged-tool', 'cfg-v1', ${ids.userA}::uuid)
        `.execute(db.db)
      )
    ).rejects.toThrow();
  });
});
