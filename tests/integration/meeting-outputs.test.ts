import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  MeetingRecordsRepository,
  MeetingOutputsRepository,
  MeetingOutputService
} from "@moss/meetings";
import { TasksRepository } from "@moss/tasks";
import type { MeetingOutputContent } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
let app: Kysely<MossDatabase>;
let context: DataContextRunner;
const owner = { actorUserId: ids.userA };
const records = new MeetingRecordsRepository();
const outputs = new MeetingOutputsRepository();
const tasks = new TasksRepository();
beforeAll(async () => {
  // Only through the isolated run-gate workflow; never run against the dev database.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await app?.destroy();
});
async function fixture() {
  return context.withDataContext(owner, async (db) => {
    const { meeting } = await records.create(db, {
      requestKey: randomUUID(),
      title: "Output test"
    });
    await records.putNotes(db, {
      meetingId: meeting.id,
      requestKey: randomUUID(),
      expectedRevision: 0,
      personalNotes: "Prepare report tomorrow"
    });
    const inputs = await outputs.inputs(db, meeting.id);
    const content: MeetingOutputContent = {
      overview: "A report was discussed",
      decisions: [],
      openQuestions: [],
      warnings: [],
      actions: [
        {
          text: "Prepare report",
          ownerPhrase: null,
          duePhrase: "tomorrow",
          evidence: [
            {
              kind: "personal-note",
              meetingId: meeting.id,
              notesRevision: 1,
              startCharacter: 0,
              endCharacter: 23
            }
          ]
        }
      ]
    };
    const artifact = await outputs.save(db, {
      meetingId: meeting.id,
      inputs,
      content,
      templateId: "general",
      templateVersion: 1,
      modelRoute: "test-only",
      origin: "generated",
      stale: false
    });
    const [candidate] = await outputs.candidates(db, meeting.id);
    return { meeting, inputs, content, artifact, candidate: candidate! };
  });
}
describe("Meeting output ownership and action acceptance", () => {
  it.each([ids.userB, ids.adminUser])(
    "hides artifacts, candidates and receipts from %s",
    async (actorUserId) => {
      const { meeting, artifact } = await fixture();
      await context.withDataContext({ actorUserId }, async (db) => {
        expect(await outputs.getArtifact(db, meeting.id, artifact.version)).toBeNull();
        expect(await outputs.candidates(db, meeting.id)).toEqual([]);
        expect(
          await db.db
            .selectFrom("app.meeting_output_requests")
            .selectAll()
            .where("meeting_id", "=", meeting.id)
            .execute()
        ).toEqual([]);
      });
      await expect(
        context.withDataContext({ actorUserId }, (db) => outputs.list(db, meeting.id))
      ).rejects.toMatchObject({ code: "meeting_not_found" });
    }
  );
  it("serializes repeated acceptance and preserves later Task edits", async () => {
    const { meeting, candidate } = await fixture();
    const input = {
      requestKey: randomUUID(),
      decision: "accept" as const,
      title: "Owner reviewed report",
      dueAt: null
    };
    const accept = () =>
      context.withDataContext(owner, (db) =>
        outputs.review(db, meeting.id, candidate.id, input, (transaction, value) =>
          tasks.create(transaction, value)
        )
      );
    const [first, second] = await Promise.all([accept(), accept()]);
    expect(first.acceptedTaskId).toBe(second.acceptedTaskId);
    expect(first.reviewState).toBe("accepted");
    const taskId = first.acceptedTaskId!;
    await context.withDataContext(owner, (db) =>
      tasks.update(db, taskId, { title: "Edited in Tasks" })
    );
    const replay = await context.withDataContext(owner, (db) =>
      outputs.review(
        db,
        meeting.id,
        candidate.id,
        { ...input, requestKey: randomUUID(), title: "Do not overwrite Task" },
        (transaction, value) => tasks.create(transaction, value)
      )
    );
    expect(replay.acceptedTaskId).toBe(taskId);
    await context.withDataContext(owner, async (db) => {
      expect((await tasks.getById(db, taskId))?.title).toBe("Edited in Tasks");
      expect(
        await db.db
          .selectFrom("app.tasks")
          .select("id")
          .where("source", "=", "meeting")
          .where("source_ref", "=", meeting.id)
          .execute()
      ).toHaveLength(1);
    });
  });
  it("preserves dismissals and requires review of changed proposals on regeneration", async () => {
    const { meeting, candidate, inputs, content } = await fixture();
    await context.withDataContext(owner, (db) =>
      outputs.review(
        db,
        meeting.id,
        candidate.id,
        { requestKey: randomUUID(), decision: "dismiss" },
        (transaction, value) => tasks.create(transaction, value)
      )
    );
    await context.withDataContext(owner, async (db) => {
      await outputs.lock(db, meeting.id);
      await outputs.save(db, {
        meetingId: meeting.id,
        inputs,
        content,
        templateId: "general",
        templateVersion: 1,
        modelRoute: "test-only",
        origin: "generated",
        stale: false
      });
      expect(await outputs.candidates(db, meeting.id)).toHaveLength(1);
      await outputs.save(db, {
        meetingId: meeting.id,
        inputs,
        content: {
          ...content,
          actions: [{ ...content.actions[0]!, text: "Prepare a detailed report" }]
        },
        templateId: "general",
        templateVersion: 1,
        modelRoute: "test-only",
        origin: "generated",
        stale: false
      });
      const rows = await outputs.candidates(db, meeting.id);
      expect(rows.find((row) => row.id === candidate.id)?.reviewState).toBe("dismissed");
      const changed = rows.find((row) => row.id !== candidate.id)!;
      expect(changed.possibleMatchIds).toContain(candidate.id);
    });
    const changed = await context.withDataContext(
      owner,
      async (db) =>
        (await outputs.candidates(db, meeting.id)).find((row) => row.id !== candidate.id)!
    );
    await expect(
      context.withDataContext(owner, (db) =>
        outputs.review(
          db,
          meeting.id,
          changed.id,
          { requestKey: randomUUID(), decision: "accept", title: "Prepare detailed report" },
          (transaction, value) => tasks.create(transaction, value)
        )
      )
    ).rejects.toMatchObject({ code: "meeting_action_match_review_required" });
  });
  it("retains immutable note evidence while a delayed generation becomes stale", async () => {
    const { meeting, artifact, content } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new MeetingOutputService(context, async () => {
      entered();
      await waiting;
      return { content, modelRoute: "test-only" };
    });
    const input = {
      requestKey: randomUUID(),
      expectedOutputVersion: artifact.version,
      expectedTranscriptRevision: 0,
      expectedNotesRevision: 1,
      templateId: "general" as const,
      templateVersion: 1
    };
    const pending = service.generate(owner, meeting.id, input);
    await started;
    expect(await service.generate(owner, meeting.id, input)).toMatchObject({ status: "pending" });
    await context.withDataContext(owner, (db) =>
      records.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 1,
        personalNotes: "Changed notes"
      })
    );
    release();
    const result = await pending;
    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected artifact");
    expect(result.artifact.stale).toBe(true);
    expect(result.artifact.inputs.personalNotes).toBe("Prepare report tomorrow");
    await context.withDataContext(owner, async (db) => {
      expect((await outputs.head(db, meeting.id))?.version).toBe(artifact.version);
    });
    expect(await service.generate(owner, meeting.id, input)).toMatchObject({
      status: "saved",
      replayed: true
    });
  });
  it("reconciles an abandoned reservation without dispatching again", async () => {
    const { meeting, artifact } = await fixture();
    const input = {
      requestKey: randomUUID(),
      expectedOutputVersion: artifact.version,
      expectedTranscriptRevision: 0,
      expectedNotesRevision: 1,
      templateId: "general" as const,
      templateVersion: 1
    };
    await context.withDataContext(owner, async (db) => {
      await db.db
        .insertInto("app.meeting_output_requests")
        .values({
          meeting_id: meeting.id,
          request_key: input.requestKey,
          input_json: JSON.stringify({ kind: "generate", ...input }),
          result_json: null,
          expires_at: new Date(0)
        })
        .execute();
    });
    let dispatches = 0;
    const service = new MeetingOutputService(context, async () => {
      dispatches++;
      throw new Error("Must not dispatch");
    });
    expect(await service.generate(owner, meeting.id, input)).toEqual({
      status: "failed",
      requestKey: input.requestKey,
      code: "meeting_output_interrupted"
    });
    expect(dispatches).toBe(0);
    await context.withDataContext(owner, async (db) => {
      expect((await outputs.list(db, meeting.id)).artifacts).toHaveLength(1);
    });
  });

  it("keeps an active head and exact candidate sources available beyond 100 stale versions", async () => {
    const { meeting, artifact, candidate, inputs, content } = await fixture();
    await context.withDataContext(owner, async (db) => {
      for (let i = 0; i < 101; i++) {
        await outputs.save(db, {
          meetingId: meeting.id,
          inputs,
          content,
          templateId: "general",
          templateVersion: 1,
          modelRoute: "test-only",
          origin: "generated",
          stale: true
        });
      }
      const page = await outputs.list(db, meeting.id);
      expect(page.artifacts).toHaveLength(101);
      expect(page.headVersion).toBe(artifact.version);
      expect(page.artifacts.some((row) => row.version === page.headVersion)).toBe(true);
      expect(page.candidates).toHaveLength(1);
      expect(page.candidates[0]?.id).toBe(candidate.id);
      expect(page.candidates[0]?.reviewState).toBe("pending");
      expect(await outputs.getArtifact(db, meeting.id, candidate.artifactVersion)).toEqual(
        artifact
      );
      // A newer active generation can leave the old pending candidate outside the page.
      await outputs.save(db, {
        meetingId: meeting.id,
        inputs,
        content,
        templateId: "general",
        templateVersion: 1,
        modelRoute: "test-only",
        origin: "generated",
        stale: false
      });
      const recent = await outputs.list(db, meeting.id);
      expect(recent.artifacts).toHaveLength(100);
      expect(recent.artifacts.some((row) => row.version === candidate.artifactVersion)).toBe(false);
      expect(await outputs.getArtifact(db, meeting.id, candidate.artifactVersion)).toEqual(
        artifact
      );
    });
  });

  it("serializes distinct generation request keys before any second provider dispatch", async () => {
    const { meeting, artifact, content } = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatches = 0;
    const service = new MeetingOutputService(context, async () => {
      dispatches++;
      await waiting;
      return { content, modelRoute: "test-only" };
    });
    const input = {
      requestKey: randomUUID(),
      expectedOutputVersion: artifact.version,
      expectedTranscriptRevision: 0,
      expectedNotesRevision: 1,
      templateId: "general" as const,
      templateVersion: 1
    };
    const first = service.generate(owner, meeting.id, input);
    const second = service.generate(owner, meeting.id, { ...input, requestKey: randomUUID() });
    try {
      await expect(Promise.race([first, second])).rejects.toMatchObject({
        code: "meeting_output_busy",
        statusCode: 409
      });
      expect(dispatches).toBe(1);
    } finally {
      release();
    }
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "fulfilled")).toMatchObject({
      value: { status: "saved" }
    });
    expect(dispatches).toBe(1);
    await context.withDataContext(owner, async (db) => {
      const receipts = await db.db
        .selectFrom("app.meeting_output_requests")
        .select("request_key")
        .where("meeting_id", "=", meeting.id)
        .execute();
      expect(receipts).toHaveLength(1);
    });
  });

  it("deletes meeting outputs while preserving accepted Task copies", async () => {
    const { meeting, candidate } = await fixture();
    const accepted = await context.withDataContext(owner, (db) =>
      outputs.review(
        db,
        meeting.id,
        candidate.id,
        { requestKey: randomUUID(), decision: "accept", title: "Keep personal Task" },
        (transaction, value) => tasks.create(transaction, value)
      )
    );
    await context.withDataContext(owner, (db) => records.remove(db, meeting.id));
    await context.withDataContext(owner, async (db) => {
      expect(await outputs.getArtifact(db, meeting.id, 1)).toBeNull();
      expect(await outputs.candidates(db, meeting.id)).toEqual([]);
      expect(await tasks.getById(db, accepted.acceptedTaskId!)).not.toBeNull();
    });
  });
});
