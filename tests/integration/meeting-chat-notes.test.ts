import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import { MeetingRecordsRepository, meetingsModuleManifest } from "@moss/meetings";
import { MeetingContextService } from "../../packages/chat/src/live/meeting-context.js";
import { createMeetingChatData } from "../../packages/module-registry/src/meeting-chat.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
let app: Kysely<MossDatabase>, context: DataContextRunner;
beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await app?.destroy();
});
describe("notes-only meeting chat through the real owner-scoped composition (isolated gate only)", () => {
  it("binds saved notes before any transcript, locks the meeting for persistence and rejects other owners/admin", async () => {
    const records = new MeetingRecordsRepository(),
      actor = { actorUserId: ids.userA };
    const meeting = await context.withDataContext(actor, async (db) => {
      const created = await records.create(db, {
        requestKey: randomUUID(),
        title: "Notes-only meeting"
      });
      await records.putNotes(db, {
        meetingId: created.meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 0,
        personalNotes: "The chosen budget is 500 dollars."
      });
      return created.meeting;
    });
    const port = createMeetingChatData({
      dataContext: context,
      resolveActiveModules: async () => [meetingsModuleManifest]
    });
    const service = new MeetingContextService(port.source);
    const bound = await service.bind(
      actor,
      { meetingId: meeting.id, selectionId: randomUUID() },
      "Budget?"
    );
    expect(bound.evidenceBlock).toContain("The chosen budget is 500 dollars.");
    expect(bound.citations).toEqual([]);
    expect(bound.coverage).toMatchObject({ notesRevision: 1, transcriptRevision: 0 });
    await expect(port.withMeeting(actor, meeting.id, async () => "authorized")).resolves.toBe(
      "authorized"
    );
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await expect(
        service.bind(
          { actorUserId },
          { meetingId: meeting.id, selectionId: randomUUID() },
          "Budget?"
        )
      ).rejects.toThrow();
      await expect(
        port.withMeeting({ actorUserId }, meeting.id, async () => "forbidden")
      ).rejects.toThrow();
    }
    await context.withDataContext(actor, (db) => records.remove(db, meeting.id));
    await expect(service.assertAvailable(actor, bound)).rejects.toThrow();
  });
});
