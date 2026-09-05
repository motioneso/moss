import { CompiledQuery } from "kysely";
import type { SendOptions } from "pg-boss";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  PUSH_DELIVER_QUEUE,
  PUSH_SUMMARY_QUEUE,
  type PushDeliverJobPayload,
  type PushQueuePort,
  type PushSummaryJobPayload
} from "@moss/notifications";

import { sendJob, type PgBoss } from "./pg-boss.js";

type JobDatabase = NonNullable<SendOptions["db"]>;

/**
 * Adapts a data-context transaction to pg-boss's `db` send option, so the job insert runs
 * on the caller's own transaction instead of pg-boss's pool (#743 security finding 7). The
 * job row therefore becomes visible to workers only when the notification commits, and
 * disappears with it on rollback.
 */
export function scopedJobDatabase(scopedDb: DataContextDb): JobDatabase {
  assertDataContextDb(scopedDb);
  return {
    async executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
      const result = await scopedDb.db.executeQuery(CompiledQuery.raw(text, values ?? []));
      return { rows: [...result.rows] };
    }
  };
}

/**
 * Real `PushQueuePort` implementation, enqueuing metadata-only jobs. Lives here rather than
 * in `@moss/notifications` because this package already depends on notifications
 * (upgrade-notify); the reverse import would form a package cycle. The recipient's id doubles
 * as `actorUserId` so the worker's data context (`toAccessContext`) scopes to the recipient,
 * not whichever actor's write triggered the notification. Every send carries the caller's
 * transaction as pg-boss's `db` option (see {@link scopedJobDatabase}).
 */
export function createPushQueuePort(boss: PgBoss): PushQueuePort {
  return {
    async enqueueDeliver(
      scopedDb: DataContextDb,
      notificationId: string,
      recipientUserId: string
    ): Promise<void> {
      await sendJob<PushDeliverJobPayload>(
        boss,
        PUSH_DELIVER_QUEUE,
        {
          actorUserId: recipientUserId,
          notificationId,
          recipientUserId
        },
        { db: scopedJobDatabase(scopedDb) }
      );
    },

    async enqueueSummary(
      scopedDb: DataContextDb,
      recipientUserId: string,
      releaseAt: Date
    ): Promise<void> {
      const releaseAtIso = releaseAt.toISOString();
      await sendJob<PushSummaryJobPayload>(
        boss,
        PUSH_SUMMARY_QUEUE,
        {
          actorUserId: recipientUserId,
          recipientUserId,
          releaseAt: releaseAtIso
        },
        {
          singletonKey: `${recipientUserId}:${releaseAtIso}`,
          startAfter: releaseAt,
          db: scopedJobDatabase(scopedDb)
        }
      );
    }
  };
}
