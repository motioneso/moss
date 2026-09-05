import { beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type { Job } from "@moss/jobs";
import type { PushDeliverJobPayload, PushSummaryJobPayload } from "@moss/notifications";
import type * as PushCryptoModule from "../../packages/notifications/src/push-crypto.js";

const FIXED_SIGNING_KEY = {
  publicKey: "fixed-public-key",
  privateKey: "fixed-private-key"
};

const { mockGetOrGeneratePushSigningKey } = vi.hoisted(() => ({
  mockGetOrGeneratePushSigningKey: vi.fn()
}));

// push-worker.ts calls getOrGeneratePushSigningKey directly (it is not an injectable
// dependency) — mocked here so these tests never touch a real database.
vi.mock("../../packages/notifications/src/push-crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PushCryptoModule>();
  return {
    ...actual,
    getOrGeneratePushSigningKey: mockGetOrGeneratePushSigningKey
  };
});

// runPushSummaryJob issues one raw sql`` count query directly (also not injectable).
let mockCountRows: readonly { count: string }[] = [];
vi.mock("kysely", () => ({
  sql: Object.assign(
    vi.fn(() => ({
      execute: vi.fn(async () => ({ rows: mockCountRows }))
    })),
    {}
  )
}));

const fakeScopedDb = {
  [dataContextBrand]: true as const,
  db: {}
} as unknown as DataContextDb;

// `attempt` mirrors the retry metadata pg-boss attaches when a worker is registered with
// includeMetadata; a job without it is treated as its final attempt (#743 finding 8).
function deliverJob(
  data: PushDeliverJobPayload,
  attempt: { retryCount: number; retryLimit: number } | undefined = undefined
): Job<PushDeliverJobPayload> {
  return {
    id: "job-1",
    name: "notifications.push.deliver",
    data,
    ...attempt
  } as unknown as Job<PushDeliverJobPayload>;
}

function summaryJob(data: PushSummaryJobPayload): Job<PushSummaryJobPayload> {
  return {
    id: "job-2",
    name: "notifications.push.summary",
    data
  } as unknown as Job<PushSummaryJobPayload>;
}

// The worker sees decrypted delivery targets (listActiveForDelivery), never the stored row.
function fakeSubscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sub-1",
    endpoint: "https://push.example/ep",
    p256dh: "p256dh-key",
    auth: "auth-key",
    ...overrides
  };
}

describe("runPushDeliverJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrGeneratePushSigningKey.mockResolvedValue(FIXED_SIGNING_KEY);
  });

  it("does nothing when the notification no longer exists (deleted or RLS-invisible)", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const listActiveForDelivery = vi.fn();
    const getById = vi.fn().mockResolvedValue(undefined);
    const sendWebPush = vi.fn();

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: { listActiveForDelivery } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(listActiveForDelivery).not.toHaveBeenCalled();
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("does nothing when the recipient has no active subscriptions", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([]);
    const sendWebPush = vi.fn();

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: { listActiveForDelivery } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("records success and never touches the subscription row on a clean send", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subscription = fakeSubscription();
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const recordDeliverySuccess = vi.fn();
    const recordDeliveryFailure = vi.fn();
    const del = vi.fn();
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess,
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(recordDeliverySuccess).toHaveBeenCalledWith(fakeScopedDb, "sub-1", "n1");
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // #743 security finding 5: the VAPID subject comes from configuration at send time, not
  // from the stored key row and not from whatever Host header first enabled push.
  it("signs with a configuration-derived VAPID subject, never a stored or request one", async () => {
    vi.stubEnv("JARVIS_PUBLIC_BASE_URL", "https://moss.example.com/app");
    const { runPushDeliverJob } = await import("@moss/notifications");
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    try {
      await runPushDeliverJob(
        deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
        fakeScopedDb,
        {
          notificationsRepository: {
            getById: vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null })
          } as never,
          subscriptionsRepository: {
            listActiveForDelivery: vi.fn().mockResolvedValue([fakeSubscription()]),
            recordDeliverySuccess: vi.fn(),
            recordDeliveryFailure: vi.fn(),
            delete: vi.fn()
          } as never,
          cipher: {} as never,
          sendWebPush
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const options = sendWebPush.mock.calls[0]?.[2] as { vapidDetails: Record<string, string> };
    expect(options.vapidDetails).toEqual({
      subject: "https://moss.example.com",
      publicKey: "fixed-public-key",
      privateKey: "fixed-private-key"
    });
  });

  // #743 security finding 1: every send goes through the guarded https agent with a
  // bounded socket timeout, so a hostile address can neither reach the box's network
  // (DNS rebinding) nor hold a worker open forever.
  it("sends through the guarded https agent with a bounded timeout", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const httpsAgent = { fake: "agent" } as never;
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: {
          getById: vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null })
        } as never,
        subscriptionsRepository: {
          listActiveForDelivery: vi.fn().mockResolvedValue([fakeSubscription()]),
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure: vi.fn(),
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush,
        httpsAgent
      }
    );

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const options = sendWebPush.mock.calls[0]?.[2] as { timeout?: number; agent?: unknown };
    expect(options.timeout).toBe(10_000);
    expect(options.agent).toBe(httpsAgent);
  });

  it("uses a real guarded agent when none is injected", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: {
          getById: vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null })
        } as never,
        subscriptionsRepository: {
          listActiveForDelivery: vi.fn().mockResolvedValue([fakeSubscription()]),
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure: vi.fn(),
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    const options = sendWebPush.mock.calls[0]?.[2] as {
      agent?: { options?: { lookup?: unknown } };
    };
    expect(typeof options.agent?.options?.lookup).toBe("function");
  });

  it("drops a stored address that fails the send-time policy without contacting it", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const sendWebPush = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn();
    const recordDeliveryFailure = vi.fn();

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: {
          getById: vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null })
        } as never,
        subscriptionsRepository: {
          listActiveForDelivery: vi
            .fn()
            .mockResolvedValue([fakeSubscription({ endpoint: "http://192.168.50.36:3000/ep" })]),
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("deletes the subscription when the push service reports it gone (404)", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subscription = fakeSubscription();
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const recordDeliverySuccess = vi.fn();
    const recordDeliveryFailure = vi.fn();
    const del = vi.fn();
    const sendWebPush = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 404 }));

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess,
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(del).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
    expect(recordDeliverySuccess).not.toHaveBeenCalled();
  });

  it("deletes the subscription when the push service reports it gone (410)", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subscription = fakeSubscription();
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const del = vi.fn();
    const recordDeliveryFailure = vi.fn();
    const sendWebPush = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(del).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("records a failure (not a delete) for any other send error", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subscription = fakeSubscription();
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const del = vi.fn();
    const recordDeliveryFailure = vi.fn();
    const sendWebPush = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("service unavailable"), { statusCode: 503 }));

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(del).not.toHaveBeenCalled();
  });

  it("delivers to every active subscription independently — one failure doesn't block another", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subA = fakeSubscription({ id: "sub-a", endpoint: "https://push.example/a" });
    const subB = fakeSubscription({ id: "sub-b", endpoint: "https://push.example/b" });
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForDelivery = vi.fn().mockResolvedValue([subA, subB]);
    const recordDeliverySuccess = vi.fn();
    const recordDeliveryFailure = vi.fn();
    const sendWebPush = vi.fn().mockImplementation(async (target: { endpoint: string }) => {
      if (target.endpoint.endsWith("/a")) {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      }
    });

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess,
          recordDeliveryFailure,
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-a");
    expect(recordDeliverySuccess).toHaveBeenCalledWith(fakeScopedDb, "sub-b", "n1");
  });
});

describe("runPushSummaryJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrGeneratePushSigningKey.mockResolvedValue(FIXED_SIGNING_KEY);
    mockCountRows = [];
  });

  it("sends nothing when no unread notification matches this release window", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "0" }];
    const listActiveForDelivery = vi.fn();
    const sendWebPush = vi.fn();

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      {
        subscriptionsRepository: { listActiveForDelivery } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(listActiveForDelivery).not.toHaveBeenCalled();
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("sends nothing when the count is positive but there are no active subscriptions", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "2" }];
    const listActiveForDelivery = vi.fn().mockResolvedValue([]);
    const sendWebPush = vi.fn();

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      {
        subscriptionsRepository: { listActiveForDelivery } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("sends one summary payload with the singular wording for exactly one notification", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "1" }];
    const subscription = fakeSubscription();
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      {
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure: vi.fn(),
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const [, payloadJson] = sendWebPush.mock.calls[0] as [unknown, string];
    const payload = JSON.parse(payloadJson);
    expect(payload.body).toBe("1 notification while you were away");
    expect(payload.href).toBe("/notifications");
  });

  it("uses plural wording and includes the release time in the payload id for multiple notifications", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "3" }];
    const subscription = fakeSubscription();
    const listActiveForDelivery = vi.fn().mockResolvedValue([subscription]);
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      {
        subscriptionsRepository: {
          listActiveForDelivery,
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure: vi.fn(),
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    const [, payloadJson] = sendWebPush.mock.calls[0] as [unknown, string];
    const payload = JSON.parse(payloadJson);
    expect(payload.body).toBe("3 notifications while you were away");
    expect(payload.id).toBe("summary:2026-09-04T08:00:00.000Z");
  });
});

// #743 security finding 8: temporary push-service failures are retried by pg-boss instead of
// being swallowed; a device only earns a failure mark on the final attempt; a retry never
// sends a payload twice to a device that already received it; a send that never answers is
// a temporary failure, not a hang.
describe("push delivery retries (#743 security finding 8)", () => {
  const JOB = { actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockGetOrGeneratePushSigningKey.mockResolvedValue(FIXED_SIGNING_KEY);
  });

  function repositoryWith(targets: readonly Record<string, unknown>[]) {
    return {
      listActiveForDelivery: vi.fn().mockResolvedValue(targets),
      recordDeliverySuccess: vi.fn(),
      recordDeliveryFailure: vi.fn(),
      delete: vi.fn()
    };
  }

  async function run(
    job: Job<PushDeliverJobPayload>,
    repository: ReturnType<typeof repositoryWith>,
    sendWebPush: ReturnType<typeof vi.fn>
  ) {
    const { runPushDeliverJob } = await import("@moss/notifications");
    return runPushDeliverJob(job, fakeScopedDb, {
      notificationsRepository: {
        getById: vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null })
      } as never,
      subscriptionsRepository: repository as never,
      cipher: {} as never,
      sendWebPush: sendWebPush as never
    });
  }

  const rejectWith = (statusCode: number) =>
    vi.fn().mockRejectedValue(Object.assign(new Error("push service said no"), { statusCode }));

  it("leaves the device untouched after a temporary failure while attempts remain", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 0, retryLimit: 3 }),
      repository,
      rejectWith(503)
    );

    expect(outcome.temporaryFailures).toBe(1);
    expect(outcome.reasons).toEqual(["503"]);
    expect(repository.recordDeliveryFailure).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.recordDeliverySuccess).not.toHaveBeenCalled();
  });

  it("treats service throttling (429) as temporary", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 1, retryLimit: 3 }),
      repository,
      rejectWith(429)
    );

    expect(outcome.temporaryFailures).toBe(1);
    expect(repository.recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("counts the device failure on the final attempt", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 3, retryLimit: 3 }),
      repository,
      rejectWith(503)
    );

    expect(outcome.temporaryFailures).toBe(1);
    expect(repository.recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
  });

  it("treats a job without retry metadata as its final attempt", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    await run(deliverJob(JOB), repository, rejectWith(503));

    expect(repository.recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
  });

  it("still removes a gone subscription (410) while attempts remain", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 0, retryLimit: 3 }),
      repository,
      rejectWith(410)
    );

    expect(outcome.temporaryFailures).toBe(0);
    expect(repository.delete).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(repository.recordDeliveryFailure).not.toHaveBeenCalled();
  });

  it("counts a rejection the service will never accept (403) against the device at once", async () => {
    const repository = repositoryWith([fakeSubscription()]);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 0, retryLimit: 3 }),
      repository,
      rejectWith(403)
    );

    expect(outcome.temporaryFailures).toBe(0);
    expect(repository.recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("records the payload id as the delivered key, and a retry skips a device that has it", async () => {
    const repository = repositoryWith([
      fakeSubscription({ id: "sub-1", lastDeliveredKey: "n1" }),
      fakeSubscription({
        id: "sub-2",
        endpoint: "https://push.example/ep2",
        lastDeliveredKey: null
      })
    ]);
    const sendWebPush = vi.fn().mockResolvedValue(undefined);

    const outcome = await run(
      deliverJob(JOB, { retryCount: 1, retryLimit: 3 }),
      repository,
      sendWebPush
    );

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect((sendWebPush.mock.calls[0]?.[0] as { endpoint: string }).endpoint).toBe(
      "https://push.example/ep2"
    );
    expect(repository.recordDeliverySuccess).toHaveBeenCalledTimes(1);
    expect(repository.recordDeliverySuccess).toHaveBeenCalledWith(fakeScopedDb, "sub-2", "n1");
    expect(outcome).toEqual({
      delivered: 1,
      alreadyDelivered: 1,
      temporaryFailures: 0,
      reasons: []
    });
  });

  it("counts a send that never answers as a temporary failure", async () => {
    const { PUSH_SEND_DEADLINE_MS } = await import("@moss/notifications");
    const repository = repositoryWith([fakeSubscription()]);
    const sendWebPush = vi.fn().mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();

    const pending = run(deliverJob(JOB, { retryCount: 0, retryLimit: 3 }), repository, sendWebPush);
    await vi.advanceTimersByTimeAsync(PUSH_SEND_DEADLINE_MS + 1);
    const outcome = await pending;

    expect(outcome.temporaryFailures).toBe(1);
    expect(outcome.reasons).toEqual(["timeout"]);
    expect(repository.recordDeliveryFailure).not.toHaveBeenCalled();
    expect(repository.recordDeliverySuccess).not.toHaveBeenCalled();
  });

  it("the retry signal carries counts and status codes only, never an address or body", async () => {
    const { PushDeliveryRetryError, throwIfPushRetryNeeded } = await import("@moss/notifications");

    expect(() =>
      throwIfPushRetryNeeded({
        delivered: 1,
        alreadyDelivered: 0,
        temporaryFailures: 0,
        reasons: []
      })
    ).not.toThrow();

    let thrown: unknown;
    try {
      throwIfPushRetryNeeded({
        delivered: 0,
        alreadyDelivered: 0,
        temporaryFailures: 2,
        reasons: ["503", "timeout"]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushDeliveryRetryError);
    expect((thrown as Error).message).toBe(
      "push delivery: 2 device(s) failed temporarily (503, timeout)"
    );
    expect(Object.keys(thrown as object)).not.toContain("endpoint");
    expect(Object.keys(thrown as object)).not.toContain("body");
  });

  it("the summary push records summary:<releaseAt> as the delivered key", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "2" }];
    const repository = repositoryWith([fakeSubscription()]);

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      {
        subscriptionsRepository: repository as never,
        cipher: {} as never,
        sendWebPush: vi.fn().mockResolvedValue(undefined)
      }
    );

    expect(repository.recordDeliverySuccess).toHaveBeenCalledWith(
      fakeScopedDb,
      "sub-1",
      "summary:2026-09-04T08:00:00.000Z"
    );
  });
});
