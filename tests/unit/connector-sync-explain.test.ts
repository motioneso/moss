import { describe, expect, it } from "vitest";

import {
  explainConnectorSync,
  type ExplainConnectorSyncInput
} from "../../packages/shared/src/connector-sync-explain.js";

const NOW = new Date("2026-09-04T14:45:00.000Z");

const base: ExplainConnectorSyncInput = {
  providerType: "google",
  status: "active",
  lastSyncStartedAt: "2026-09-04T14:30:00.000Z",
  lastSyncFinishedAt: "2026-09-04T14:33:00.000Z",
  lastSyncStatus: "success",
  lastSyncError: null,
  lastSyncCounts: { calendarUpserted: 3, emailUpserted: 40 },
  pending: null,
  nextRunAt: null,
  deferredAi: null
};

describe("explainConnectorSync", () => {
  it("revoked wins over every other fact", () => {
    const result = explainConnectorSync(
      { ...base, status: "revoked", lastSyncStatus: "failed", lastSyncError: "auth-error" },
      NOW
    );
    expect(result.code).toBe("revoked");
    expect(result.label).toBe("Revoked");
    expect(result.reason).toBeNull();
    expect(result.next).toBeNull();
    expect(result.canReconnect).toBe(false);
  });

  it("a synced account names the counts and the next check time", () => {
    const result = explainConnectorSync(
      { ...base, nextRunAt: "2026-09-04T14:45:00.000Z" },
      NOW
    );
    expect(result.code).toBe("synced");
    expect(result.label).toBe("Synced");
    expect(result.summary).toContain("3 calendar events");
    expect(result.summary).toContain("40 emails");
    expect(result.next).toBe("Next check at 14:45.");
    expect(result.canSyncNow).toBe(true);
  });

  it("a run in progress says syncing, not the stale prior status", () => {
    const result = explainConnectorSync(
      {
        ...base,
        lastSyncStatus: "failed",
        lastSyncError: "auth-error",
        pending: { state: "active", since: "2026-09-04T14:44:40.000Z" }
      },
      NOW
    );
    expect(result.code).toBe("syncing");
    expect(result.label).toBe("Syncing");
    expect(result.reason).toBeNull();
    expect(result.next).toBe("Started 20 seconds ago.");
  });

  it("a freshly queued job says queued and waits", () => {
    const result = explainConnectorSync(
      { ...base, pending: { state: "queued", since: "2026-09-04T14:44:00.000Z" } },
      NOW
    );
    expect(result.code).toBe("queued");
    expect(result.next).toBe("Waiting for the background worker to pick it up.");
  });

  it("a job the worker never picked up says waiting for worker, with how long", () => {
    const result = explainConnectorSync(
      { ...base, pending: { state: "waiting-for-worker", since: "2026-09-04T14:04:00.000Z" } },
      NOW
    );
    expect(result.code).toBe("waiting-for-worker");
    expect(result.label).toBe("Waiting for worker");
    expect(result.reason).toBe("Queued 41 minutes ago and not picked up.");
    expect(result.next).toBe("The background worker may not be running.");
  });

  it("an expired Google sign-in asks for reconnect, not a generic connection error", () => {
    const result = explainConnectorSync(
      { ...base, lastSyncStatus: "failed", lastSyncError: "auth-error" },
      NOW
    );
    expect(result.code).toBe("sign-in-expired");
    expect(result.label).toBe("Sign-in expired");
    expect(result.reason).toBe("Google no longer accepts the saved sign-in.");
    expect(result.next).toBe("Press Reconnect.");
    expect(result.canReconnect).toBe(true);
  });

  it("a failed run with a non-auth error names the error code's plain sentence", () => {
    const result = explainConnectorSync(
      { ...base, lastSyncStatus: "failed", lastSyncError: "calendar-error" },
      NOW
    );
    expect(result.code).toBe("connection-error");
    expect(result.reason).toBe("Calendar could not be read.");
    expect(result.canReconnect).toBe(true);
  });

  it("an account-level connection error is reported even without a failed run", () => {
    const result = explainConnectorSync({ ...base, status: "error" }, NOW);
    expect(result.code).toBe("connection-error");
    expect(result.label).toBe("Connection error");
    expect(result.canReconnect).toBe(true);
  });

  it("a partial run explains the error code and promises a retry", () => {
    const result = explainConnectorSync(
      {
        ...base,
        lastSyncStatus: "partial",
        lastSyncError: "email-message-error",
        lastSyncCounts: { emailFailures: 2 }
      },
      NOW
    );
    expect(result.code).toBe("partial");
    expect(result.label).toBe("Partial sync");
    expect(result.reason).toBe(
      "2 messages could not be read; usually the provider refused them one at a time."
    );
    expect(result.next).toBe("The next run will retry what failed.");
  });

  it("a partial run capped by the message limit says so, not a made-up item error", () => {
    const result = explainConnectorSync(
      {
        ...base,
        lastSyncStatus: "partial",
        lastSyncError: null,
        lastSyncCounts: { emailUpserted: 148, truncated: true }
      },
      NOW
    );
    expect(result.code).toBe("capped");
    expect(result.label).toBe("More to fetch");
    expect(result.reason).toBe("Stopped at the message cap; 148 emails so far.");
    expect(result.next).toBe("Continues automatically in the next run.");
  });

  it("no run yet, but a schedule exists, says first sync pending", () => {
    const result = explainConnectorSync(
      { ...base, lastSyncStatus: null, lastSyncFinishedAt: null, nextRunAt: "2026-09-04T14:45:00.000Z" },
      NOW
    );
    expect(result.code).toBe("first-run-pending");
    expect(result.label).toBe("First sync pending");
    expect(result.next).toBe("Scheduled for 14:45.");
  });

  it("no run and no schedule says not scheduled instead of guessing", () => {
    const result = explainConnectorSync(
      { ...base, lastSyncStatus: null, lastSyncFinishedAt: null, nextRunAt: null },
      NOW
    );
    expect(result.code).toBe("not-scheduled");
    expect(result.label).toBe("Not scheduled");
    expect(result.next).toBe("Reconnect to schedule syncing.");
  });

  it("an unknown error code falls back to the code with dashes replaced by spaces", () => {
    const result = explainConnectorSync(
      { ...base, lastSyncStatus: "partial", lastSyncError: "some-new-code" },
      NOW
    );
    expect(result.reason).toBe("some new code");
  });
});
