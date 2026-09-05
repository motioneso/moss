import type { PgBoss } from "pg-boss";

import { assertMetadataOnlyPayload } from "@moss/jobs";

import { GOOGLE_SYNC_QUEUE, type GoogleSyncPayload } from "./sync-jobs.js";

export const GOOGLE_SYNC_CRON = "*/15 * * * *";
const GOOGLE_SYNC_TZ = "UTC";

/**
 * Additive recurring schedule for the Google sync queue, alongside the existing on-demand
 * sendJob triggers (connect + manual "Sync now"). Keyed by actorUserId — one Google account
 * per actor today (GoogleConnectionService is single-account), matching GOOGLE_SYNC_QUEUE's
 * existing per-actor singletonKey exclusivity.
 */
export async function reconcileGoogleAccountSchedule(
  boss: PgBoss,
  actorUserId: string,
  connected: boolean
): Promise<void> {
  if (connected) {
    const data: GoogleSyncPayload = {
      actorUserId,
      kind: "google-sync",
      idempotencyKey: `schedule:${actorUserId}`,
      trigger: "schedule"
    };
    assertMetadataOnlyPayload(data);
    await boss.schedule(GOOGLE_SYNC_QUEUE, GOOGLE_SYNC_CRON, data, {
      tz: GOOGLE_SYNC_TZ,
      key: actorUserId,
      singletonKey: actorUserId
    });
    return;
  }
  await boss.unschedule(GOOGLE_SYNC_QUEUE, actorUserId);
}
