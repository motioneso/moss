import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "@moss/jobs";
import { DataContextRunner } from "@moss/db";
import {
  createMeetingStopSummaryScheduler,
  registerMeetingStopSummaryWorker,
  MEETING_STOP_SUMMARY_QUEUE
} from "../../packages/meetings/src/stop-summary-jobs.js";
import {
  MeetingStopSummaryRepository,
  type MeetingStopSummaryEnqueue
} from "../../packages/meetings/src/stop-summary-repository.js";
import { MeetingOutputService } from "../../packages/meetings/src/output-service.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
const id = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.restoreAllMocks());
describe("automatic summary queue", () => {
  it("uses allowed metadata keys and the caller's transaction adapter", async () => {
    const db = makeRecordingDb();
    const send = vi.fn(
      async (
        _name: string,
        _payload: unknown,
        options: { db: { executeSql(sql: string): Promise<unknown> } }
      ) => {
        await options.db.executeSql("SELECT 'same transaction'");
        return id;
      }
    );
    vi.spyOn(MeetingStopSummaryRepository.prototype, "schedule").mockImplementation(
      async (transaction, actor, _input, enqueue: MeetingStopSummaryEnqueue) => {
        await enqueue(
          transaction,
          { actorUserId: actor.actorUserId, resourceId: id, idempotencyKey: id },
          new Date(1000),
          false
        );
      }
    );
    const schedule = createMeetingStopSummaryScheduler({ send } as unknown as PgBoss);
    await schedule(
      db.scoped,
      { actorUserId: id },
      {
        meetingId: id,
        grantId: id,
        deadline: new Date(1000).toISOString(),
        finalized: false,
        stoppedNow: true
      }
    );
    expect(send).toHaveBeenCalledWith(
      MEETING_STOP_SUMMARY_QUEUE,
      { actorUserId: id, resourceId: id, idempotencyKey: id },
      expect.objectContaining({
        startAfter: new Date(1000),
        singletonKey: `${id}:stop`,
        db: expect.anything()
      })
    );
    expect(db.queries[0]?.sql).toBe("SELECT 'same transaction'");
  });
  it("rejects content-bearing job payloads before invoking the owner-scoped generator", async () => {
    let run!: (jobs: { id: string; data: unknown }[]) => Promise<unknown>;
    const work = vi.fn(async (_queue: string, _options: unknown, handler: typeof run) => {
      run = handler;
      return "worker";
    });
    const generate = vi
      .spyOn(MeetingOutputService.prototype, "generateOnStop")
      .mockResolvedValue(null);
    await registerMeetingStopSummaryWorker(
      { work } as unknown as PgBoss,
      {} as DataContextRunner,
      vi.fn()
    );
    await expect(
      run([
        { id, data: { actorUserId: id, resourceId: id, idempotencyKey: id, transcript: "private" } }
      ])
    ).rejects.toThrow("Invalid automatic meeting summary metadata");
    expect(generate).not.toHaveBeenCalled();
    await run([{ id, data: { actorUserId: id, resourceId: id, idempotencyKey: id } }]);
    expect(generate).toHaveBeenCalledWith({ actorUserId: id, requestId: id }, id, id);
  });
  it("completes a valid queued job when its owner-scoped meeting lookup finds no row", async () => {
    let run!: (jobs: { id: string; data: unknown }[]) => Promise<unknown>;
    const work = vi.fn(async (_queue: string, _options: unknown, handler: typeof run) => {
      run = handler;
      return "worker";
    });
    const db = makeRecordingDb();
    const context = new DataContextRunner(db.scoped.db);
    vi.spyOn(context, "withDataContext").mockImplementation(async (_actor, operation) =>
      operation(db.scoped)
    );
    const generator = vi.fn();
    await registerMeetingStopSummaryWorker({ work } as unknown as PgBoss, context, generator);
    await expect(
      run([{ id, data: { actorUserId: id, resourceId: id, idempotencyKey: id } }])
    ).resolves.toBeUndefined();
    expect(context.withDataContext).toHaveBeenCalledOnce();
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.sql).toContain('"app"."meeting_records"');
    expect(db.queries[0]?.sql).toContain("for update");
    expect(generator).not.toHaveBeenCalled();
  });
});
