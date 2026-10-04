import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { PrivateNoteExportPort } from "@moss/notes";
import { MeetingRecordsRepository } from "@moss/meetings";
import { MeetingOutputsRepository } from "../../packages/meetings/src/output-repository.js";
import { MeetingExportService } from "../../packages/meetings/src/export-service.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>;
let context: DataContextRunner;
const records = new MeetingRecordsRepository();
const outputs = new MeetingOutputsRepository();
const owner = { actorUserId: ids.userA };

beforeAll(async () => {
  // Execute only through the supported isolated verify-gate, never against an ambient DB.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await app?.destroy();
});

async function fixture() {
  const { meeting } = await context.withDataContext(owner, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic export" })
  );
  await context.withDataContext(owner, async (db) => {
    await outputs.lock(db, meeting.id);
    await outputs.save(db, {
      meetingId: meeting.id,
      inputs: { meetingId: meeting.id, transcript: null, personalNotes: "", notesRevision: 0 },
      templateId: "general",
      templateVersion: 1,
      modelRoute: "synthetic",
      origin: "generated",
      stale: false,
      content: {
        overview: "Synthetic saved output",
        decisions: [],
        actions: [],
        openQuestions: [],
        warnings: []
      }
    });
  });
  let written = false;
  const observation = {
    destination: "private-vault" as const,
    audience: "owner" as const,
    noteReference: `notes/generated/${meeting.id}/v1.md`,
    contentHash: "a".repeat(64)
  };
  const notes: PrivateNoteExportPort = {
    inspect: vi.fn<PrivateNoteExportPort["inspect"]>(async () => ({
      ...observation,
      status: written ? "unchanged" : "missing"
    })),
    createOrInspect: vi.fn<PrivateNoteExportPort["createOrInspect"]>(async () => {
      written = true;
      return { ...observation, status: "written" };
    }),
    queueIndex: vi.fn<PrivateNoteExportPort["queueIndex"]>(async () => ({
      status: "queued",
      jobId: randomUUID()
    }))
  };
  return { meeting, notes, service: new MeetingExportService(context, notes) };
}

describe("meeting export receipts", () => {
  it("serializes concurrent requests and durably replays the original receipt", async () => {
    const { meeting, notes, service } = await fixture();
    const input = { requestKey: randomUUID(), artifactVersion: 1 };
    const [first, second] = await Promise.all([
      service.save(owner, meeting.id, input),
      service.save(owner, meeting.id, input)
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ writeStatus: "saved", indexStatus: "queued" });
    expect(notes.createOrInspect).toHaveBeenCalledTimes(1);
    expect(notes.queueIndex).toHaveBeenCalledTimes(1);
    expect(await service.list(owner, meeting.id)).toEqual([first]);
  });
  it.each([ids.userB, ids.adminUser])(
    "owner-only read and write even for actor %s",
    async (actorUserId) => {
      const { meeting, notes, service } = await fixture();
      const input = { requestKey: randomUUID(), artifactVersion: 1 };
      await service.save(owner, meeting.id, input);
      const calls = vi.mocked(notes.inspect).mock.calls.length;
      await expect(service.save({ actorUserId }, meeting.id, input)).rejects.toThrow(
        "meeting_not_found"
      );
      await expect(service.list({ actorUserId }, meeting.id)).rejects.toThrow("meeting_not_found");
      expect(notes.inspect).toHaveBeenCalledTimes(calls);
      await context.withDataContext({ actorUserId }, async (db) => {
        expect(
          await db.db
            .selectFrom("app.meeting_export_receipts")
            .selectAll()
            .where("meeting_id", "=", meeting.id)
            .execute()
        ).toEqual([]);
        expect(
          await db.db
            .selectFrom("app.meeting_export_requests")
            .selectAll()
            .where("meeting_id", "=", meeting.id)
            .execute()
        ).toEqual([]);
        const result = await db.db
          .updateTable("app.meeting_export_receipts")
          .set({ receipt_json: "{}" })
          .where("meeting_id", "=", meeting.id)
          .executeTakeFirstOrThrow();
        expect(result.numUpdatedRows).toBe(0n);
      });
      await expect(
        context.withDataContext({ actorUserId }, (db) =>
          db.db
            .insertInto("app.meeting_export_requests")
            .values({
              meeting_id: meeting.id,
              owner_user_id: ids.userA,
              request_key: randomUUID(),
              artifact_version: 1,
              result_json: null
            })
            .execute()
        )
      ).rejects.toThrow();
    }
  );
  it("deletes meeting receipts without invoking any Notes deletion or rewrite", async () => {
    const { meeting, notes, service } = await fixture();
    await service.save(owner, meeting.id, { requestKey: randomUUID(), artifactVersion: 1 });
    await context.withDataContext(owner, (db) => records.remove(db, meeting.id));
    await context.withDataContext(owner, async (db) => {
      expect(
        await db.db
          .selectFrom("app.meeting_export_receipts")
          .selectAll()
          .where("meeting_id", "=", meeting.id)
          .execute()
      ).toEqual([]);
      expect(
        await db.db
          .selectFrom("app.meeting_export_requests")
          .selectAll()
          .where("meeting_id", "=", meeting.id)
          .execute()
      ).toEqual([]);
    });
    expect(notes.createOrInspect).toHaveBeenCalledTimes(1);
    expect(notes.queueIndex).toHaveBeenCalledTimes(1);
  });
});
