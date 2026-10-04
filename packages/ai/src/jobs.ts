import type { PgBoss } from "pg-boss";

import type { Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import { type QueueDefinition } from "@moss/jobs";

import { AiRepository } from "./repository.js";

export const AI_PURGE_AUDIT_LOG_QUEUE = "ai-purge-audit-log";

// #2956: daily expiry of quoted activity detail. The payload is empty apart from job kind
// and idempotency key -- no ids of private content, no text.
export const AI_PURGE_ACTIVITY_DETAIL_QUEUE = "ai-purge-activity-detail";

export const AI_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: AI_PURGE_AUDIT_LOG_QUEUE,
    options: { retryLimit: 3, retryDelay: 300, retryBackoff: true }
  },
  {
    name: AI_PURGE_ACTIVITY_DETAIL_QUEUE,
    options: { retryLimit: 3, retryDelay: 300, retryBackoff: true }
  }
];

export async function registerAiMaintenanceWorkers(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>
): Promise<string[]> {
  const repository = new AiRepository();

  await boss.schedule(AI_PURGE_AUDIT_LOG_QUEUE, "0 3 * * *", {}, { tz: "UTC" });
  await boss.schedule(AI_PURGE_ACTIVITY_DETAIL_QUEUE, "0 3 * * *", {}, { tz: "UTC" });

  const workId = await boss.work(AI_PURGE_AUDIT_LOG_QUEUE, async () => {
    // #2682: the worker role only has EXECUTE on the no-argument, fixed-retention purge
    // function -- it cannot call the app-runtime purge function with a caller-supplied cutoff.
    const count = await repository.purgeExpiredActionAuditLog(rootDb);
    return { purgedRows: count };
  });

  const detailWorkId = await boss.work(AI_PURGE_ACTIVITY_DETAIL_QUEUE, async () => {
    // #2956: same shape -- the worker only has EXECUTE on the no-argument purge function.
    const count = await repository.purgeExpiredActivityDetail(rootDb);
    return { purgedRows: count };
  });

  return [workId, detailWorkId];
}
