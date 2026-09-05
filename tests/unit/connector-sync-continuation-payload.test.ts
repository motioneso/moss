import { describe, expect, it } from "vitest";

import { assertGoogleSyncContinuationPayload } from "../../packages/connectors/src/google-sync-payload.js";
import type { GoogleSyncContinuationPayload } from "../../packages/connectors/src/sync-jobs.js";

/**
 * A job queued before this release is already sitting in the queue when the new worker
 * starts. It must still run.
 */
const OLD_QUEUED_JOB = {
  kind: "google-sync-continuation",
  actorUserId: "00000000-0000-0000-0000-0000000000aa",
  idempotencyKey: "run-1",
  connectorAccountId: "00000000-0000-0000-0000-0000000000bb",
  phase: "email",
  cursor: "page-2",
  chunkIndex: 1,
  startedAt: "2026-09-04T10:00:00.000Z",
  calendarSeenSince: "2026-09-04T09:00:00.000Z",
  calendarUpserted: 3,
  calendarReconciled: 0,
  emailUpserted: 40,
  emailFailures: 0,
  escalations: 0,
  errors: []
} as unknown as GoogleSyncContinuationPayload;

describe("assertGoogleSyncContinuationPayload", () => {
  it("accepts a job queued before the deferred count existed", () => {
    expect(() => assertGoogleSyncContinuationPayload(OLD_QUEUED_JOB)).not.toThrow();
  });

  it("still rejects a deferred count that is present and nonsense", () => {
    for (const bad of [-1, 1.5, 2_000_000, Number.NaN]) {
      expect(() =>
        assertGoogleSyncContinuationPayload({
          ...OLD_QUEUED_JOB,
          emailDeferred: bad
        } as GoogleSyncContinuationPayload)
      ).toThrow("invalid continuation count");
    }
  });

  it("accepts a new job carrying its set-aside message list and reason", () => {
    expect(() =>
      assertGoogleSyncContinuationPayload({
        ...OLD_QUEUED_JOB,
        emailDeferred: 1,
        deferredKeys: ["message-1"],
        deferredReason: "assistant-login-expired"
      } as GoogleSyncContinuationPayload)
    ).not.toThrow();
  });

  it("rejects a set-aside list that is not a list of short ids", () => {
    expect(() =>
      assertGoogleSyncContinuationPayload({
        ...OLD_QUEUED_JOB,
        deferredKeys: [""]
      } as GoogleSyncContinuationPayload)
    ).toThrow("invalid continuation deferred keys");
    expect(() =>
      assertGoogleSyncContinuationPayload({
        ...OLD_QUEUED_JOB,
        deferredKeys: Array.from({ length: 501 }, (_unused, index) => `m${index}`)
      } as GoogleSyncContinuationPayload)
    ).toThrow("invalid continuation deferred keys");
  });

  it("rejects a reason that is not one of the fixed codes", () => {
    expect(() =>
      assertGoogleSyncContinuationPayload({
        ...OLD_QUEUED_JOB,
        deferredReason: "whatever-the-model-said"
      } as unknown as GoogleSyncContinuationPayload)
    ).toThrow("invalid continuation deferred reason");
  });
});
