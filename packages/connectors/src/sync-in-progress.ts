import { GOOGLE_PROVIDER_ID } from "./repository.js";
import { GOOGLE_SYNC_EXPIRE_SECONDS } from "./sync-jobs.js";

/**
 * Is a sync run for this account still walking its way through the mailbox?
 *
 * A Google sync is not one job: the first chunk stamps the account with a start time and clears
 * the outcome, then hands itself on through a chain of continuations, each taking one page of the
 * 30-day window from oldest to newest. Only the last chunk stamps an outcome. So "started, no
 * outcome yet" is exactly the in-flight window.
 *
 * Why this matters to re-judging (#2271 round 3): each chunk re-reads what it may skip for the
 * page it is about to handle, but a chain never goes back over pages it has already walked. Clear
 * the stored verdicts halfway through a chain and the messages on the earlier pages are simply not
 * looked at again by that chain - they wait for the next one.
 *
 * A run whose start stamp is older than the job's own expiry can no longer be in flight: the queue
 * has expired it. Treating that as finished keeps a crashed run from blocking re-judging for good.
 */
export const SYNC_ASSUMED_ENDED_AFTER_SECONDS = GOOGLE_SYNC_EXPIRE_SECONDS;

export interface SyncRunHealth {
  readonly last_sync_started_at: Date | string | null;
  readonly last_sync_status: string | null;
}

export interface GoogleSyncCandidateAccount extends SyncRunHealth {
  readonly provider_id: string;
  readonly status: string;
}

export function syncRunInProgress(account: SyncRunHealth, now: Date): boolean {
  if (account.last_sync_status !== null) return false;
  const startedAt = account.last_sync_started_at;
  if (startedAt === null) return false;
  const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(started.getTime())) return false;
  const elapsedSeconds = (now.getTime() - started.getTime()) / 1000;
  if (elapsedSeconds < 0) return true;
  return elapsedSeconds <= SYNC_ASSUMED_ENDED_AFTER_SECONDS;
}

/**
 * The Google account whose sync chain is still running, if any. Only an active Google account
 * matters here: the Google sync stamps its health on that row, and it is the only run the
 * re-judge script can queue. IMAP accounts run on their own schedule and are unaffected.
 */
export function findRunningGoogleSync<T extends GoogleSyncCandidateAccount>(
  accounts: readonly T[],
  now: Date
): T | undefined {
  return accounts.find(
    (account) =>
      account.provider_id === GOOGLE_PROVIDER_ID &&
      account.status === "active" &&
      syncRunInProgress(account, now)
  );
}

export interface RejudgeSyncPlan {
  /** Whether asking for a sync now would actually re-judge anything. */
  readonly queueSync: boolean;
  /** Plain-English explanation for whoever ran the re-judge command. */
  readonly message: string;
}

/**
 * What the re-judge script should do after emptying the stored verdicts.
 *
 * When a chain is already running, queuing is pointless twice over: the chain will not revisit the
 * pages it has already walked, and the sync queue holds one run per actor, so the new job lands on
 * an account whose chain is still going and returns having done nothing (observed on dev, #2271
 * round 3). Say that plainly rather than reporting a sync that will not re-judge anything.
 */
export function planRejudgeSync(
  accounts: readonly GoogleSyncCandidateAccount[],
  now: Date
): RejudgeSyncPlan {
  const running = findRunningGoogleSync(accounts, now);
  if (!running) {
    return {
      queueSync: true,
      message:
        "Queued a Google sync; the cleared messages are re-judged as it works through them. " +
        "A mailbox connected over IMAP re-judges on its own next scheduled sync."
    };
  }
  const startedAt = running.last_sync_started_at;
  const started = startedAt instanceof Date ? startedAt.toISOString() : String(startedAt);
  return {
    queueSync: false,
    message:
      `A sync for this mailbox is still running (it started at ${started}). It works through the ` +
      "mailbox oldest first and does not go back over mail it has already been through, and only " +
      "one sync runs at a time, so nothing was queued. These messages are re-judged by the next " +
      "sync after this one finishes - either the next scheduled one, or run this command again " +
      "once it is done."
  };
}
