import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
let app: Kysely<MossDatabase>, bootstrap: Kysely<MossDatabase>, context: DataContextRunner;
beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});
class RollbackVerifiedUpgrade extends Error {}
class BackfillGuardFailure extends Error {}
describe("0288 upgrade of existing recording grants (isolated gate only)", () => {
  it.each([false, true])(
    "revokes legacy rows under the real NOBYPASS migration role; protection removed=%s",
    async (removeProtection) => {
      const grantIds: string[] = [];
      for (const actorUserId of [ids.userA, ids.userB])
        await context.withDataContext({ actorUserId }, async (db) => {
          const { meeting } = await new MeetingRecordsRepository().create(db, {
            requestKey: randomUUID(),
            title: "Synthetic legacy capture"
          });
          const id = randomUUID();
          grantIds.push(id);
          await sql`INSERT INTO app.meeting_capture_grants (id,meeting_id,device_id,device_name,verifier_hash,status,expires_at) VALUES (${id}::uuid,${meeting.id}::uuid,${randomUUID()}::uuid,'Synthetic legacy Mac',${"0".repeat(64)},'active',now()+interval '1 hour')`.execute(
            db.db
          );
        });
      const original = await readFile(
        new URL(
          "../../packages/meetings/sql/0288_meeting_recording_connections.sql",
          import.meta.url
        ),
        "utf8"
      );
      const migration = removeProtection
        ? original.replace("ALTER TABLE app.meeting_capture_grants DISABLE ROW LEVEL SECURITY;", "")
        : original;
      const role = decodeURIComponent(new URL(connectionStrings.migration).username);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) throw Error("Unexpected isolated migration role");
      const expectedDatabase = new URL(connectionStrings.bootstrap).pathname.slice(1);
      expect(
        (await sql<{ name: string }>`SELECT current_database() AS name`.execute(bootstrap)).rows[0]
          ?.name
      ).toBe(expectedDatabase);
      expect(
        (
          await sql<{
            rolsuper: boolean;
            rolbypassrls: boolean;
          }>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${role}`.execute(bootstrap)
        ).rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await expect(
        bootstrap.transaction().execute(async (transaction) => {
          // Rewind only this new feature inside a transaction that always rolls back. Applied0284 bytes and migration receipts stay untouched.
          await sql`DROP TABLE app.meeting_capture_start_cancellations,app.meeting_capture_connections;
     DROP INDEX app.meeting_capture_one_active;
     ALTER TABLE app.meeting_capture_grants DROP COLUMN connection_id,DROP COLUMN capability_revision,DROP COLUMN claim_expires_at,DROP COLUMN start_request_key,DROP COLUMN start_fingerprint;
     ALTER TABLE app.meeting_capture_grants DROP CONSTRAINT meeting_capture_grants_status_check;
     ALTER TABLE app.meeting_capture_grants ADD CONSTRAINT meeting_capture_grants_status_check CHECK (status IN ('pending','approved','active','revoked'));
     CREATE UNIQUE INDEX meeting_capture_one_active ON app.meeting_capture_grants(meeting_id) WHERE status='active';
     ALTER TABLE app.meeting_capture_receipts DROP COLUMN attempts,DROP COLUMN retry_at;`.execute(
            transaction
          );
          await sql.raw(`SET LOCAL ROLE "${role}"`).execute(transaction);
          expect(
            (await sql<{ role: string }>`SELECT current_user AS role`.execute(transaction)).rows[0]
              ?.role
          ).toBe(role);
          await sql.raw(migration).execute(transaction);
          await sql`RESET ROLE`.execute(transaction);
          const rows = await sql<{
            status: string;
          }>`SELECT status FROM app.meeting_capture_grants WHERE id IN (${sql.join(grantIds.map((id) => sql`${id}::uuid`))})`.execute(
            transaction
          );
          if (rows.rows.length !== 2 || rows.rows.some((row) => row.status !== "revoked"))
            throw new BackfillGuardFailure("Legacy capture grant survived upgrade");
          expect(
            (
              await sql<{
                enabled: boolean;
                forced: boolean;
              }>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='app.meeting_capture_grants'::regclass`.execute(
                transaction
              )
            ).rows
          ).toEqual([{ enabled: true, forced: true }]);
          throw new RollbackVerifiedUpgrade();
        })
      ).rejects.toBeInstanceOf(removeProtection ? BackfillGuardFailure : RollbackVerifiedUpgrade);
      expect(
        (
          await sql<{
            status: string;
          }>`SELECT status FROM app.meeting_capture_grants WHERE id IN (${sql.join(grantIds.map((id) => sql`${id}::uuid`))})`.execute(
            bootstrap
          )
        ).rows.every((row) => row.status === "active")
      ).toBe(true);
    }
  );
});
