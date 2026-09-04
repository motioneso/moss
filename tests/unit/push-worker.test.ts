import { beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type { Job } from "@moss/jobs";
import type { PushDeliverJobPayload, PushSummaryJobPayload } from "@moss/notifications";
import type * as PushCryptoModule from "../../packages/notifications/src/push-crypto.js";

const FIXED_SIGNING_KEY = {
  subject: "mailto:push@jarv1s.local",
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

function deliverJob(data: PushDeliverJobPayload): Job<PushDeliverJobPayload> {
  return {
    id: "job-1",
    name: "notifications.push.deliver",
    data
  } as unknown as Job<PushDeliverJobPayload>;
}

function summaryJob(data: PushSummaryJobPayload): Job<PushSummaryJobPayload> {
  return {
    id: "job-2",
    name: "notifications.push.summary",
    data
  } as unknown as Job<PushSummaryJobPayload>;
}

function fakeSubscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sub-1",
    owner_user_id: "user-1",
    endpoint: "https://push.example/ep",
    p256dh: "p256dh-key",
    auth: "auth-key",
    user_agent_label: "Chrome on Mac OS X",
    created_at: new Date(),
    last_used_at: null,
    failure_count: 0,
    disabled_at: null,
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
    const listActiveForActor = vi.fn();
    const getById = vi.fn().mockResolvedValue(undefined);
    const sendWebPush = vi.fn();

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: { listActiveForActor } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(listActiveForActor).not.toHaveBeenCalled();
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("does nothing when the recipient has no active subscriptions", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForActor = vi.fn().mockResolvedValue([]);
    const sendWebPush = vi.fn();

    await runPushDeliverJob(
      deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
      fakeScopedDb,
      {
        notificationsRepository: { getById } as never,
        subscriptionsRepository: { listActiveForActor } as never,
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
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
          recordDeliverySuccess,
          recordDeliveryFailure,
          delete: del
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(recordDeliverySuccess).toHaveBeenCalledWith(fakeScopedDb, "sub-1");
    expect(recordDeliveryFailure).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the subscription when the push service reports it gone (404)", async () => {
    const { runPushDeliverJob } = await import("@moss/notifications");
    const subscription = fakeSubscription();
    const getById = vi.fn().mockResolvedValue({ id: "n1", title: "Hi", body: "there", href: null });
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
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
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
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
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
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
    const listActiveForActor = vi.fn().mockResolvedValue([subA, subB]);
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
          listActiveForActor,
          recordDeliverySuccess,
          recordDeliveryFailure,
          delete: vi.fn()
        } as never,
        cipher: {} as never,
        sendWebPush
      }
    );

    expect(recordDeliveryFailure).toHaveBeenCalledWith(fakeScopedDb, "sub-a");
    expect(recordDeliverySuccess).toHaveBeenCalledWith(fakeScopedDb, "sub-b");
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
    const listActiveForActor = vi.fn();
    const sendWebPush = vi.fn();

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      { subscriptionsRepository: { listActiveForActor } as never, cipher: {} as never, sendWebPush }
    );

    expect(listActiveForActor).not.toHaveBeenCalled();
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("sends nothing when the count is positive but there are no active subscriptions", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "2" }];
    const listActiveForActor = vi.fn().mockResolvedValue([]);
    const sendWebPush = vi.fn();

    await runPushSummaryJob(
      summaryJob({
        actorUserId: "u1",
        recipientUserId: "u1",
        releaseAt: "2026-09-04T08:00:00.000Z"
      }),
      fakeScopedDb,
      { subscriptionsRepository: { listActiveForActor } as never, cipher: {} as never, sendWebPush }
    );

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("sends one summary payload with the singular wording for exactly one notification", async () => {
    const { runPushSummaryJob } = await import("@moss/notifications");
    mockCountRows = [{ count: "1" }];
    const subscription = fakeSubscription();
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
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
    const listActiveForActor = vi.fn().mockResolvedValue([subscription]);
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
          listActiveForActor,
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
