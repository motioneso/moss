import { sql, type Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import {
  assertMetadataOnlyPayload,
  sendJob,
  type Job,
  type PgBoss,
  type QueueDefinition
} from "@moss/jobs";

import { GOOGLE_SYNC_QUEUE, type GoogleSyncPayload } from "./sync-jobs.js";
import { reconcileGoogleAccountSchedule } from "./google-schedule.js";

export const GOOGLE_SYNC_SWEEP_QUEUE = "connectors.google-sync-sweep";

/**
 * #792 self-healing sweep. `reconcileGoogleAccountSchedule` (google-schedule.ts) already
 * registers a per-actor 15-min cron on OAuth-connect-complete (routes.ts), but that call is
 * fire-and-forget — a failure is only logged as a warning — and it never ran at all for
 * accounts connected before that mechanism shipped. This is a THIRD, additive trigger: every
 * 30 minutes (matching PROACTIVE_CHECK_CRON's cadence — module-registry/src/index.ts — per the
 * spec's "do not tighten below it" guardrail) it re-enumerates every connected Google calendar
 * account and enqueues GOOGLE_SYNC_QUEUE directly, so a missing or broken per-actor schedule
 * can never leave an account's cache permanently stale. It does not replace or modify the
 * per-actor cron, the manual "Sync now" route, or the OAuth-connect-complete trigger.
 */
export const GOOGLE_SYNC_SWEEP_CRON = "*/30 * * * *";
const GOOGLE_SYNC_SWEEP_TZ = "UTC";
const GOOGLE_SYNC_SWEEP_KEY = "google-sync-sweep";

export const GOOGLE_SYNC_SWEEP_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: GOOGLE_SYNC_SWEEP_QUEUE,
    options: {
      // exclusive: at most one sweep tick in flight/pending at a time.
      policy: "exclusive",
      retryLimit: 0,
      deleteAfterSeconds: 300,
      retentionSeconds: 300
    }
  }
];

export interface GoogleSyncSweepJobPayload {
  readonly kind: "google-sync-sweep";
}

export interface ConnectedGoogleCalendarAccount {
  readonly id: string;
  readonly actorUserId: string;
}

export async function reconcileGoogleSyncSweepSchedule(boss: PgBoss): Promise<void> {
  const data: GoogleSyncSweepJobPayload = { kind: "google-sync-sweep" };
  assertMetadataOnlyPayload(data);
  await boss.schedule(GOOGLE_SYNC_SWEEP_QUEUE, GOOGLE_SYNC_SWEEP_CRON, data, {
    tz: GOOGLE_SYNC_SWEEP_TZ,
    key: GOOGLE_SYNC_SWEEP_KEY
  });
}

/**
 * Bounded, no-actor-gate enumeration of connected Google calendar accounts via
 * app.list_connected_google_calendar_accounts() (sql/0144). Mirrors the
 * app.list_expired_data_export_jobs precedent (packages/settings/src/data-export-jobs.ts):
 * per-actor RLS on app.connector_accounts (0069) blocks a plain cross-user SELECT even under
 * the worker runtime role, and this sweep must legitimately read across all actors to find
 * every connected account. Returns id + actorUserId only — never scopes/tokens/secrets.
 */
export async function listConnectedGoogleCalendarAccounts(
  rootDb: Kysely<MossDatabase>
): Promise<readonly ConnectedGoogleCalendarAccount[]> {
  const result = await sql<{ id: string; actorUserId: string }>`
    SELECT id, "ownerUserId" AS "actorUserId"
    FROM app.list_connected_google_calendar_accounts()
  `.execute(rootDb);
  return result.rows;
}

/**
 * Enqueues GOOGLE_SYNC_QUEUE for every connected account, using the identical payload shape
 * and singletonKey exclusivity as the existing connect/manual-sync triggers (routes.ts), so a
 * sweep-triggered job collapses with any in-flight job for the same actor instead of doubling up.
 */
export async function handleGoogleSyncSweepJob(
  _job: Job<GoogleSyncSweepJobPayload>,
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>
): Promise<void> {
  const accounts = await listConnectedGoogleCalendarAccounts(rootDb);
  for (const account of accounts) {
    const payload: GoogleSyncPayload = {
      actorUserId: account.actorUserId,
      kind: "google-sync",
      idempotencyKey: `sweep:${account.actorUserId}`,
      trigger: "schedule"
    };
    await sendJob(boss, GOOGLE_SYNC_QUEUE, payload, { singletonKey: account.actorUserId });
  }
}

export async function registerGoogleSyncSweepWorker(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>
): Promise<string> {
  const accounts = await listConnectedGoogleCalendarAccounts(rootDb);
  await Promise.all(
    accounts.map(({ actorUserId }) => reconcileGoogleAccountSchedule(boss, actorUserId, true))
  );
  await reconcileGoogleSyncSweepSchedule(boss);
  return boss.work<GoogleSyncSweepJobPayload, void>(
    GOOGLE_SYNC_SWEEP_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) {
        throw new Error(`pg-boss invoked ${GOOGLE_SYNC_SWEEP_QUEUE} without a job`);
      }
      await handleGoogleSyncSweepJob(job, boss, rootDb);
    }
  );
}
