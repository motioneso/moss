import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, CompiledQuery, type Kysely } from "kysely";
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
class VerifiedRollback extends Error {}
describe("0292 original-title migration (isolated gate only)", () => {
  it.each([false, true])(
    "backfills every owner under the real NOBYPASS migration role; guard removed=%s",
    async (removeGuard) => {
      const meetingIds: string[] = [];
      for (const actorUserId of [ids.userA, ids.userB])
        meetingIds.push(
          (
            await context.withDataContext({ actorUserId }, (db) =>
              new MeetingRecordsRepository().create(db, {
                requestKey: randomUUID(),
                title: "Original title"
              })
            )
          ).meeting.id
        );
      for (const [index, actorUserId] of [ids.userA, ids.userB].entries())
        await context.withDataContext({ actorUserId }, async (db) => {
          await sql`INSERT INTO app.meeting_output_artifacts (meeting_id,version,artifact_json,inactive) VALUES (${meetingIds[index]}::uuid,1,${JSON.stringify({ content: { overview: "Owner overview \0 \ud800 retained" } })},false)`.execute(
            db.db
          );
          await sql`INSERT INTO app.meeting_capture_grants (meeting_id,device_id,device_name,verifier_hash,status,state_json,expires_at) VALUES (${meetingIds[index]}::uuid,${randomUUID()}::uuid,'Synthetic recorder',${"0".repeat(64)},'complete',${JSON.stringify({ recordedDurationMs: 4321 })},now()+interval '1 hour')`.execute(
            db.db
          );
        });
      const original = await readFile(
        new URL("../../packages/meetings/sql/0292_meeting_minimal.sql", import.meta.url),
        "utf8"
      );
      const migration = removeGuard
        ? original.replace("ALTER TABLE app.meeting_records DISABLE ROW LEVEL SECURITY;", "")
        : original;
      const role = decodeURIComponent(new URL(connectionStrings.migration).username);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) throw Error("Unexpected isolated migration role");
      expect(
        (
          await sql<{
            rolsuper: boolean;
            rolbypassrls: boolean;
          }>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${role}`.execute(bootstrap)
        ).rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const attempt = bootstrap.transaction().execute(async (tx) => {
        // Rewind only0292 in an always-rolled-back test transaction; migration receipts stay intact.
        await sql`DROP TABLE app.meeting_stop_summaries;
        DROP TRIGGER meeting_record_creation_title ON app.meeting_records;
        DROP FUNCTION app.meeting_record_creation_title();
        ALTER TABLE app.meeting_records DROP COLUMN creation_title;
        ALTER TABLE app.meeting_capture_grants DROP COLUMN recorded_duration_ms;
        ALTER TABLE app.meeting_output_artifacts DROP COLUMN history_overview;
        DROP POLICY meeting_records_summary_worker ON app.meeting_records;
        DROP POLICY meeting_output_requests_summary_worker ON app.meeting_output_requests;
        DROP POLICY meeting_output_requests_summary_result ON app.meeting_output_requests;
        DROP POLICY meeting_output_artifacts_summary_worker ON app.meeting_output_artifacts;
        DROP POLICY meeting_action_candidates_summary_worker ON app.meeting_action_candidates;`.execute(
          tx
        );
        await sql.raw(`SET LOCAL ROLE "${role}"`).execute(tx);
        await sql.raw(migration).execute(tx);
        const source = await readFile(
          new URL("../../packages/meetings/sql/0292_meeting_minimal.backfill.mjs", import.meta.url),
          "utf8"
        );
        const sidecar = (await import(
          `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
        )) as {
          backfill(client: {
            query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
          }): Promise<void>;
        };
        await sidecar.backfill({
          query: async (text, values = []) => {
            const result = await tx.executeQuery(CompiledQuery.raw(text, values));
            return { rows: [...result.rows] };
          }
        });

        await sql`RESET ROLE`.execute(tx);
        expect(
          (
            await sql<{
              title: string;
              creation_title: string;
            }>`SELECT title,creation_title FROM app.meeting_records WHERE id IN (${sql.join(meetingIds.map((id) => sql`${id}::uuid`))})`.execute(
              tx
            )
          ).rows
        ).toEqual([
          { title: "Original title", creation_title: "Original title" },
          { title: "Original title", creation_title: "Original title" }
        ]);
        expect(
          (
            await sql<{
              enabled: boolean;
              forced: boolean;
            }>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='app.meeting_records'::regclass`.execute(
              tx
            )
          ).rows
        ).toEqual([{ enabled: true, forced: true }]);
        expect(
          (
            await sql<{
              history_overview: string;
            }>`SELECT history_overview FROM app.meeting_output_artifacts WHERE meeting_id IN (${sql.join(meetingIds.map((id) => sql`${id}::uuid`))})`.execute(
              tx
            )
          ).rows
        ).toEqual([
          { history_overview: "Owner overview retained" },
          { history_overview: "Owner overview retained" }
        ]);
        expect(
          (
            await sql<{
              recorded_duration_ms: number;
            }>`SELECT recorded_duration_ms FROM app.meeting_capture_grants WHERE meeting_id IN (${sql.join(meetingIds.map((id) => sql`${id}::uuid`))})`.execute(
              tx
            )
          ).rows
        ).toEqual([{ recorded_duration_ms: 4321 }, { recorded_duration_ms: 4321 }]);
        throw new VerifiedRollback();
      });
      if (removeGuard) await expect(attempt).rejects.toMatchObject({ code: "23502" });
      else await expect(attempt).rejects.toBeInstanceOf(VerifiedRollback);
      expect(
        (
          await sql`SELECT creation_title FROM app.meeting_records WHERE id IN (${sql.join(meetingIds.map((id) => sql`${id}::uuid`))})`.execute(
            bootstrap
          )
        ).rows
      ).toHaveLength(2);
    }
  );
});
