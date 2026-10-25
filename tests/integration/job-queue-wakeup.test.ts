import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, startJobQueueWakeup, type PgBoss } from "@moss/jobs";
import { createVoiceRequestScheduler, CHAT_VOICE_REQUEST_QUEUE } from "@moss/chat";
import { createRecordingImportScheduler, RECORDING_IMPORT_QUEUE } from "@moss/meetings";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>, context: DataContextRunner, producer: PgBoss, consumer: PgBoss;
beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app });
  context = new DataContextRunner(db);
  producer = createPgBossClient(connectionStrings.app);
  consumer = createPgBossClient(connectionStrings.worker);
  await producer.start();
  await consumer.start();
});
afterAll(async () => {
  await consumer?.stop({ graceful: true });
  await producer?.stop({ graceful: true });
  await db?.destroy();
});
const actor = { actorUserId: ids.userA };

describe("committed voice work wakes durable queue consumers", () => {
  it("still delivers through polling when no listener is available", async () => {
    const id = randomUUID();
    const received: unknown[] = [];
    await consumer.work(CHAT_VOICE_REQUEST_QUEUE, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      received.push(...jobs.map((job) => job.data));
    });
    try {
      await context.withDataContext(actor, (scopedDb) =>
        createVoiceRequestScheduler(producer)(scopedDb, actor, id)
      );
      await expect
        .poll(() => received, { timeout: 2000 })
        .toEqual([{ actorUserId: actor.actorUserId, resourceId: id }]);
    } finally {
      await consumer.offWork(CHAT_VOICE_REQUEST_QUEUE, { wait: true });
    }
  });

  it.each([CHAT_VOICE_REQUEST_QUEUE, RECORDING_IMPORT_QUEUE])(
    "%s runs after commit without waiting for its polling interval",
    async (queue) => {
      const id = randomUUID();
      const received: unknown[] = [];
      const worker = await consumer.work(queue, { pollingIntervalSeconds: 30 }, async (jobs) => {
        received.push(...jobs.map((job) => job.data));
      });
      const listener = startJobQueueWakeup(connectionStrings.worker, queue, consumer, [worker]);
      try {
        await listener.ready;
        // The initial empty fetch has finished before the scheduling transaction opens.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await context.withDataContext(actor, async (scopedDb) => {
          if (queue === CHAT_VOICE_REQUEST_QUEUE)
            await createVoiceRequestScheduler(producer)(scopedDb, actor, id);
          else
            await createRecordingImportScheduler(producer)(scopedDb, {
              actorUserId: actor.actorUserId,
              resourceId: id,
              kind: "transcribe"
            });
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(received).toEqual([]);
        });
        await expect
          .poll(() => received, { timeout: 2000 })
          .toEqual([
            {
              actorUserId: actor.actorUserId,
              resourceId: id,
              ...(queue === RECORDING_IMPORT_QUEUE ? { kind: "transcribe" } : {})
            }
          ]);
      } finally {
        await listener.stop();
        await consumer.offWork(queue, { wait: true });
      }
    }
  );

  it("does not wake for rolled-back or delayed work", async () => {
    const wakeups: string[] = [];
    const listener = startJobQueueWakeup(
      connectionStrings.worker,
      CHAT_VOICE_REQUEST_QUEUE,
      {
        notifyWorker: (id) => {
          wakeups.push(id);
        }
      },
      ["waiting"]
    );
    try {
      await listener.ready;
      wakeups.length = 0;
      await expect(
        context.withDataContext(actor, async (scopedDb) => {
          await createVoiceRequestScheduler(producer)(scopedDb, actor, randomUUID());
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      await context.withDataContext(actor, (scopedDb) =>
        createVoiceRequestScheduler(producer)(scopedDb, actor, randomUUID(), 60)
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(wakeups).toEqual([]);
      // An unrelated queue cannot wake this consumer.
      await context.withDataContext(actor, (scopedDb) =>
        createRecordingImportScheduler(producer)(scopedDb, {
          actorUserId: actor.actorUserId,
          resourceId: randomUUID(),
          kind: "transcribe"
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(wakeups).toEqual([]);
    } finally {
      await listener.stop();
    }
  });
});
