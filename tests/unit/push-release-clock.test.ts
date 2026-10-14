import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { runPushDeliverJob, runPushSummaryJob } from "@moss/notifications";
import type * as PushCryptoModule from "../../packages/notifications/src/push-crypto.js";

vi.mock("../../packages/notifications/src/push-crypto.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PushCryptoModule>()),
  getOrGeneratePushSigningKey: vi
    .fn()
    .mockResolvedValue({ publicKey: "public", privateKey: "private" }),
  createPushSigningCipher: vi.fn()
}));
const scopedDb = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("push release clock skew", () => {
  for (const kind of ["summary", "deliver"] as const) {
    it(`releases ${kind} once when the worker clock is slightly behind the database`, async () => {
      vi.stubEnv("JARVIS_PUBLIC_BASE_URL", "https://moss.example.com");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-12T09:59:59.900Z"));
      const releaseAt = "2026-10-12T10:00:00.000Z";
      const row = {
        id: "n1",
        recipient_user_id: "u1",
        module_id: "tasks",
        urgency: "normal",
        title: "Task",
        metadata: {},
        deferred_until: kind === "summary" ? new Date(releaseAt) : null
      };
      const deferDelivery = vi.fn();
      const enqueueSummary = vi.fn();
      const enqueueDeliver = vi.fn();
      const sendWebPush = vi.fn().mockResolvedValue(undefined);
      const deps = {
        notificationsRepository: {
          getById: vi.fn().mockResolvedValue(row),
          listUnreadDeferred: vi.fn().mockResolvedValue([row]),
          deferDelivery
        } as never,
        subscriptionsRepository: {
          listActiveForDelivery: vi
            .fn()
            .mockResolvedValue([
              { id: "s1", endpoint: "https://push.example/ep", p256dh: "key", auth: "auth" }
            ]),
          recordDeliverySuccess: vi.fn(),
          recordDeliveryFailure: vi.fn(),
          delete: vi.fn()
        } as never,
        quietHoursPort: {
          getSettings: async () => ({
            enabled: true,
            start: "08:00",
            end: "10:00",
            timezone: "UTC"
          }),
          getLocaleTimezone: async () => null
        },
        pushQueuePort: { enqueueSummary, enqueueDeliver },
        sendWebPush
      };
      const data = { actorUserId: "u1", recipientUserId: "u1", notificationId: "n1", releaseAt };
      const job = { id: "j1", name: kind, data };
      const outcome = await (kind === "summary" ? runPushSummaryJob : runPushDeliverJob)(
        job,
        scopedDb,
        deps
      );
      expect(outcome.delivered).toBe(1);
      expect(sendWebPush).toHaveBeenCalledTimes(1);
      expect(deferDelivery).not.toHaveBeenCalled();
      expect(enqueueSummary).not.toHaveBeenCalled();
      expect(enqueueDeliver).not.toHaveBeenCalled();
    });
  }
});
