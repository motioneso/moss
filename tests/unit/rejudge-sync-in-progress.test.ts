import { describe, expect, it } from "vitest";

import {
  SYNC_ASSUMED_ENDED_AFTER_SECONDS,
  findRunningGoogleSync,
  planRejudgeSync,
  syncRunInProgress
} from "../../packages/connectors/src/sync-in-progress.js";

/**
 * #2271 round 3. Running the reset on dev while a Google sync chain was already going produced
 * nothing: the chain walks the 30-day window one page at a time and never returns to a page it has
 * finished, and the sync queue keeps a single run per actor, so the job the script queued behind it
 * finished in a fraction of a second with nothing upserted. The script now detects that state and
 * says re-judging happens on the next sync instead of implying it is already under way.
 *
 * The detection reads the account's own health stamps: a start time with no outcome recorded is
 * exactly the window between the first chunk and the last. A start older than the job's expiry is
 * treated as over, so a crashed run cannot block re-judging for good.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");

function secondsBefore(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    provider_id: "google",
    status: "active",
    last_sync_started_at: secondsBefore(60),
    last_sync_status: null,
    ...overrides
  } as {
    provider_id: string;
    status: string;
    last_sync_started_at: Date | string | null;
    last_sync_status: string | null;
  };
}

describe("is a sync run still going", () => {
  it("says yes while a run has started and recorded no outcome", () => {
    expect(syncRunInProgress(account(), NOW)).toBe(true);
  });

  it("says no once the run has recorded an outcome", () => {
    expect(syncRunInProgress(account({ last_sync_status: "success" }), NOW)).toBe(false);
    expect(syncRunInProgress(account({ last_sync_status: "failed" }), NOW)).toBe(false);
  });

  it("says no when the account has never synced", () => {
    expect(syncRunInProgress(account({ last_sync_started_at: null }), NOW)).toBe(false);
  });

  it("says yes right up to the point the job itself would expire", () => {
    const stamp = secondsBefore(SYNC_ASSUMED_ENDED_AFTER_SECONDS - 1);
    expect(syncRunInProgress(account({ last_sync_started_at: stamp }), NOW)).toBe(true);
  });

  it("says no for a start so old the run cannot still exist", () => {
    // A crash between the start stamp and the finish stamp leaves an account looking busy for
    // ever. Past the expiry we call it over, so re-judging is never blocked permanently.
    const stamp = secondsBefore(SYNC_ASSUMED_ENDED_AFTER_SECONDS + 1);
    expect(syncRunInProgress(account({ last_sync_started_at: stamp }), NOW)).toBe(false);
  });

  it("treats a start stamped in the future as still going", () => {
    // Clock skew between the worker and this script must not read as an expired run.
    const stamp = new Date(NOW.getTime() + 30_000);
    expect(syncRunInProgress(account({ last_sync_started_at: stamp }), NOW)).toBe(true);
  });

  it("reads a start time that arrives as text", () => {
    const stamp = secondsBefore(60).toISOString();
    expect(syncRunInProgress(account({ last_sync_started_at: stamp }), NOW)).toBe(true);
  });

  it("says no for an unreadable start time rather than blocking", () => {
    expect(syncRunInProgress(account({ last_sync_started_at: "not a date" }), NOW)).toBe(false);
  });
});

describe("which account the re-judge script looks at", () => {
  it("finds the running Google account", () => {
    const found = findRunningGoogleSync([account()], NOW);
    expect(found).toBeDefined();
  });

  it("ignores a mailbox connected another way", () => {
    // Only the Google sync is chained and only the Google sync is what this script can queue.
    expect(findRunningGoogleSync([account({ provider_id: "imap-fastmail" })], NOW)).toBeUndefined();
  });

  it("ignores a disconnected Google account", () => {
    expect(findRunningGoogleSync([account({ status: "revoked" })], NOW)).toBeUndefined();
  });

  it("finds nothing when every sync has finished", () => {
    const accounts = [
      account({ last_sync_status: "success" }),
      account({ provider_id: "imap-fastmail" })
    ];
    expect(findRunningGoogleSync(accounts, NOW)).toBeUndefined();
  });
});

describe("what the re-judge command does after clearing", () => {
  it("asks for a sync when nothing is running", () => {
    const plan = planRejudgeSync([account({ last_sync_status: "success" })], NOW);
    expect(plan.queueSync).toBe(true);
    expect(plan.message).toContain("Queued a Google sync");
  });

  it("asks for a sync when there is no mailbox connected at all", () => {
    const plan = planRejudgeSync([], NOW);
    expect(plan.queueSync).toBe(true);
  });

  it("does not ask for a sync while one is running, and says why", () => {
    const plan = planRejudgeSync([account()], NOW);
    expect(plan.queueSync).toBe(false);
    expect(plan.message).toContain("still running");
    expect(plan.message).toContain("does not go back over mail it has already been through");
    expect(plan.message).toContain("next sync after this one finishes");
    expect(plan.message).toContain(secondsBefore(60).toISOString());
  });

  it("asks for a sync again once the stuck run is past its expiry", () => {
    const stamp = secondsBefore(SYNC_ASSUMED_ENDED_AFTER_SECONDS + 1);
    expect(planRejudgeSync([account({ last_sync_started_at: stamp })], NOW).queueSync).toBe(true);
  });
});
