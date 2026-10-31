import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { MossDatabase } from "@moss/db";
import { assertMetadataOnlyPayload, sendJob, type Job, type QueueDefinition } from "@moss/jobs";

import { CHAT_HEARTBEAT_BEAT_QUEUE, type HeartbeatBeatPayload } from "./beat-job.js";
import { HEARTBEAT_SWEEP_CRON, HEARTBEAT_SWEEP_MAX_OWNERS } from "./limits.js";

export const CHAT_HEARTBEAT_SWEEP_QUEUE = "chat.heartbeat-sweep";
const HEARTBEAT_SWEEP_KEY = "chat-heartbeat-sweep";

export const CHAT_HEARTBEAT_SWEEP_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_HEARTBEAT_SWEEP_QUEUE,
  options: {
    // At most one sweep tick pending or running at a time.
    policy: "exclusive",
    retryLimit: 0,
    deleteAfterSeconds: 300,
    retentionSeconds: 300
  }
};

export interface HeartbeatSweepPayload {
  readonly kind: "heartbeat-sweep";
}

export interface HeartbeatDueOwner {
  readonly ownerUserId: string;
  readonly settingsRevision: number;
}

/**
 * Owners due for a check, across all owners, through a function that returns IDs and the saved
 * revision only (sql/0343). Each owner's beat then runs scoped to that owner.
 */
export async function listHeartbeatDueOwners(
  rootDb: Kysely<MossDatabase>,
  limit: number = HEARTBEAT_SWEEP_MAX_OWNERS
): Promise<readonly HeartbeatDueOwner[]> {
  const result = await sql<HeartbeatDueOwner>`
    SELECT "ownerUserId", "settingsRevision" FROM app.list_heartbeat_due_owners(${limit})
  `.execute(rootDb);
  return result.rows;
}

export async function handleHeartbeatSweep(
  boss: Pick<PgBoss, "send">,
  rootDb: Kysely<MossDatabase>
): Promise<number> {
  const owners = await listHeartbeatDueOwners(rootDb);
  for (const owner of owners) {
    const occurrenceId = randomUUID();
    const payload: HeartbeatBeatPayload = {
      actorUserId: owner.ownerUserId,
      kind: "heartbeat-beat",
      resourceId: occurrenceId,
      version: owner.settingsRevision,
      idempotencyKey: `heartbeat:${occurrenceId}`
    };
    await sendJob(boss, CHAT_HEARTBEAT_BEAT_QUEUE, payload, { singletonKey: owner.ownerUserId });
  }
  return owners.length;
}

export async function registerHeartbeatSweepWorker(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>
): Promise<string> {
  const data: HeartbeatSweepPayload = { kind: "heartbeat-sweep" };
  assertMetadataOnlyPayload(data);
  await boss.schedule(CHAT_HEARTBEAT_SWEEP_QUEUE, HEARTBEAT_SWEEP_CRON, data, {
    tz: "UTC",
    key: HEARTBEAT_SWEEP_KEY
  });
  return boss.work<HeartbeatSweepPayload, void>(
    CHAT_HEARTBEAT_SWEEP_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]: Job<HeartbeatSweepPayload>[]) => {
      if (!job) throw new Error(`pg-boss invoked ${CHAT_HEARTBEAT_SWEEP_QUEUE} without a job`);
      await handleHeartbeatSweep(boss, rootDb);
    }
  );
}
