import type { PgBoss } from "pg-boss";

import type { Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import { type QueueDefinition } from "@moss/jobs";

import { AiRepository } from "./repository.js";

export const AI_PURGE_AUDIT_LOG_QUEUE = "ai-purge-audit-log";

export const AI_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: AI_PURGE_AUDIT_LOG_QUEUE,
    options: { retryLimit: 3, retryDelay: 300, retryBackoff: true }
  }
];

export async function registerAiMaintenanceWorkers(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>
): Promise<string[]> {
  const repository = new AiRepository();

  await boss.schedule(AI_PURGE_AUDIT_LOG_QUEUE, "0 3 * * *", {}, { tz: "UTC" });

  const workId = await boss.work(AI_PURGE_AUDIT_LOG_QUEUE, async () => {
    // #2682: the worker role only has EXECUTE on the no-argument, fixed-retention purge
    // function -- it cannot call the app-runtime purge function with a caller-supplied cutoff.
    const count = await repository.purgeExpiredActionAuditLog(rootDb);
    return { purgedRows: count };
  });

  return [workId];
}
