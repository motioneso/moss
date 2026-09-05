import type { PgBoss } from "pg-boss";

import { assertMetadataOnlyPayload } from "@moss/jobs";

import { IMAP_SYNC_QUEUE, type ImapSyncPayload } from "./imap-sync-jobs.js";

export const IMAP_SYNC_CRON = "*/15 * * * *";
const IMAP_SYNC_TZ = "UTC";

/**
 * Reconcile the per-account IMAP sync schedule. The pg-boss *schedule key* is the
 * connectorAccountId (not the actor id) — one actor may connect several IMAP presets at once,
 * each syncing on its own schedule row.
 *
 * The payload carries actorUserId as well: the worker's `toAccessContext` boundary
 * (registerDataContextWorker) derives the RLS principal from `job.data.actorUserId` and throws
 * `missing actorUserId` before the handler runs if it is absent — so a schedule keyed only by
 * connectorAccountId would enqueue jobs that can never load their account. actorUserId + kind +
 * connectorAccountId are all metadata-only (ALLOWED_PAYLOAD_KEYS); the IMAP password never
 * appears here. assertMetadataOnlyPayload is defense-in-depth (boss.schedule bypasses sendJob's
 * guard).
 */
export async function reconcileImapAccountSchedule(
  boss: PgBoss,
  actorUserId: string,
  connectorAccountId: string,
  connected: boolean
): Promise<void> {
  if (connected) {
    const data: ImapSyncPayload = {
      actorUserId,
      connectorAccountId,
      kind: "imap-sync",
      trigger: "schedule"
    };
    assertMetadataOnlyPayload(data);
    await boss.schedule(IMAP_SYNC_QUEUE, IMAP_SYNC_CRON, data, {
      tz: IMAP_SYNC_TZ,
      key: connectorAccountId
    });
    return;
  }
  await boss.unschedule(IMAP_SYNC_QUEUE, connectorAccountId);
}
