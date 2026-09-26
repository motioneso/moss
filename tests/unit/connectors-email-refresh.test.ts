import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_REFRESH_ACCOUNT_QUEUE,
  dispatchPendingEmailRefreshJobs,
  type EmailRefreshDispatchRepository,
  type PendingEmailRefreshDispatch
} from "../../packages/connectors/src/email-refresh.js";
import { toRefreshOutcome } from "../../packages/connectors/src/email-refresh-jobs.js";

const actorUserId = "11111111-1111-4111-8111-111111111111";

describe("email refresh worker dispatch", () => {
  it("sends metadata-only account jobs and counts singleton deduplication as already queued", async () => {
    const pending: PendingEmailRefreshDispatch[] = [
      {
        refresh_id: "22222222-2222-4222-8222-222222222222",
        account_id: "33333333-3333-4333-8333-333333333333",
        provider_type: "google",
        dispatch_attempts: 0
      },
      {
        refresh_id: "44444444-4444-4444-8444-444444444444",
        account_id: "55555555-5555-4555-8555-555555555555",
        provider_type: "imap",
        dispatch_attempts: 0
      }
    ];
    const repository: EmailRefreshDispatchRepository = {
      listPendingDispatch: vi.fn(async () => [...pending]),
      markDispatched: vi.fn(async (_scopedDb, refreshId, accountId) => {
        const index = pending.findIndex(
          (row) => row.refresh_id === refreshId && row.account_id === accountId
        );
        if (index >= 0) pending.splice(index, 1);
      }),
      recordDispatchFailure: vi.fn()
    };
    const send = vi.fn().mockResolvedValueOnce("job-1").mockResolvedValueOnce(null);
    const boss = { send };

    const enqueued = await dispatchPendingEmailRefreshJobs(
      {} as never,
      boss as never,
      actorUserId,
      repository
    );

    expect(enqueued).toBe(1);
    expect(send).toHaveBeenNthCalledWith(
      1,
      EMAIL_REFRESH_ACCOUNT_QUEUE,
      {
        actorUserId,
        connectorAccountId: "33333333-3333-4333-8333-333333333333",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
        kind: "email-refresh-account",
        trigger: "manual"
      },
      { singletonKey: "22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333" }
    );
    expect(Object.keys(send.mock.calls[0]![1] as object)).toEqual([
      "actorUserId",
      "connectorAccountId",
      "idempotencyKey",
      "kind",
      "trigger"
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(repository.markDispatched).toHaveBeenCalledTimes(2);
    expect(repository.recordDispatchFailure).not.toHaveBeenCalled();

    // Once the durable rows are marked, a second dispatcher pass has nothing to enqueue.
    expect(
      await dispatchPendingEmailRefreshJobs({} as never, boss as never, actorUserId, repository)
    ).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("toRefreshOutcome", () => {
  it("preserves message counts and maps mixed provider errors to partial", () => {
    expect(
      toRefreshOutcome({
        errors: ["email-message-error"],
        emailUpserted: 8,
        emailFailures: 2
      })
    ).toEqual({
      status: "partial",
      errorCode: "email-message-error",
      emailUpserted: 8,
      emailFailures: 2
    });
  });

  it("maps authentication failures to failed", () => {
    expect(
      toRefreshOutcome({ errors: ["auth-error"], emailUpserted: 0, emailFailures: 0 })
    ).toEqual({
      status: "failed",
      errorCode: "auth-error",
      emailUpserted: 0,
      emailFailures: 0
    });
  });
});
