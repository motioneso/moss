import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MEETING_RECORDING_NOTICE } from "@moss/shared";
import { MeetingRecordingNoticeRepository } from "../../packages/meetings/src/recording-notice.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>,
  worker: Kysely<MossDatabase>,
  context: DataContextRunner,
  workerContext: DataContextRunner;
const notices = new MeetingRecordingNoticeRepository();
const owner = { actorUserId: ids.userA };
beforeAll(async () => {
  // Run only through scripts/run-gate.sh on a disposable, isolated database.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app });
  worker = createDatabase({ connectionString: connectionStrings.worker });
  context = new DataContextRunner(app);
  workerContext = new DataContextRunner(worker);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), worker?.destroy()]);
});

describe("durable current-version account recording notice (isolated gate only)", () => {
  it("starts absent, rejects unseen versions, and retains one server-authored acknowledgement in a new browser", async () => {
    expect(
      (await context.withDataContext(owner, (db) => notices.get(db))).acknowledgement
    ).toBeNull();
    await expect(
      context.withDataContext(owner, (db) => notices.acknowledge(db, "previous-text"))
    ).rejects.toMatchObject({ code: "meeting_capture_notice_required", httpStatus: 409 });
    expect(
      (await context.withDataContext(owner, (db) => notices.get(db))).acknowledgement
    ).toBeNull();
    const before = Date.now();
    const first = await context.withDataContext(owner, (db) =>
      notices.acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
    expect(first.acknowledgement?.policyVersion).toBe(MEETING_RECORDING_NOTICE.policyVersion);
    expect(Date.parse(first.acknowledgement!.acknowledgedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(first.acknowledgement!.acknowledgedAt)).toBeLessThanOrEqual(
      Date.now() + 1000
    );
    expect(
      await context.withDataContext({ ...owner, requestId: "another-browser" }, (db) =>
        new MeetingRecordingNoticeRepository().get(db)
      )
    ).toEqual(first);
    const repeated = await Promise.all(
      [1, 2].map(() =>
        context.withDataContext(owner, (db) =>
          notices.acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
        )
      )
    );
    expect(repeated).toEqual([first, first]);
  });
  it.each([ids.userB, ids.adminUser])(
    "owner RLS excludes other accounts, including admin %s",
    async (actorUserId) => {
      const actor = { actorUserId };
      expect(
        (await context.withDataContext(actor, (db) => notices.get(db))).acknowledgement
      ).toBeNull();
      await context.withDataContext(actor, async (db) => {
        expect(
          (
            await sql`SELECT policy_version FROM app.meeting_recording_notices WHERE owner_user_id=${owner.actorUserId}::uuid`.execute(
              db.db
            )
          ).rows
        ).toEqual([]);
        expect(
          (
            await sql`UPDATE app.meeting_recording_notices SET policy_version='forged' WHERE owner_user_id=${owner.actorUserId}::uuid RETURNING owner_user_id`.execute(
              db.db
            )
          ).rows
        ).toEqual([]);
      });
      await expect(
        context.withDataContext(actor, (db) =>
          sql`INSERT INTO app.meeting_recording_notices (owner_user_id,policy_version) VALUES (${owner.actorUserId}::uuid,'forged')`.execute(
            db.db
          )
        )
      ).rejects.toMatchObject({ code: "42501" });
    }
  );
  it("requires acknowledgement again only for a different stored policy version", async () => {
    await context.withDataContext(owner, (db) =>
      sql`UPDATE app.meeting_recording_notices SET policy_version='previous-text'`.execute(db.db)
    );
    await expect(
      context.withDataContext(owner, (db) => notices.requireCurrent(db))
    ).rejects.toMatchObject({ code: "meeting_capture_notice_required" });
    await context.withDataContext(owner, (db) =>
      notices.acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
    expect(await context.withDataContext(owner, (db) => notices.requireCurrent(db))).toBe(
      MEETING_RECORDING_NOTICE.policyVersion
    );
  });
  it("allows owner-scoped read-only acknowledgement metadata for account exports", async () => {
    const rows = await workerContext.withDataContext(owner, (db) =>
      sql`SELECT owner_user_id,policy_version,acknowledged_at FROM app.meeting_recording_notices`.execute(
        db.db
      )
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      owner_user_id: owner.actorUserId,
      policy_version: MEETING_RECORDING_NOTICE.policyVersion
    });
    expect(
      (
        await workerContext.withDataContext({ actorUserId: ids.userB }, (db) =>
          sql`SELECT owner_user_id,policy_version,acknowledged_at FROM app.meeting_recording_notices`.execute(
            db.db
          )
        )
      ).rows
    ).toEqual([]);
    await expect(
      workerContext.withDataContext(owner, (db) =>
        sql`UPDATE app.meeting_recording_notices SET policy_version='forged'`.execute(db.db)
      )
    ).rejects.toMatchObject({ code: "42501" });
  });
});
