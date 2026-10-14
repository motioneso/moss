import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { PushDeliverJobPayload, PushSummaryJobPayload } from "@moss/notifications";

const fakeScopedDb = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
const deliverJob = (data: PushDeliverJobPayload) => ({ data });
const summaryJob = (data: PushSummaryJobPayload) => ({ data });

describe("live quiet-hours allowance at push dispatch", () => {
  it.each([false, true])(
    "checks the current choice in individual and summary workers (summary=%s)",
    async (summary) => {
      const { runPushDeliverJob, runPushSummaryJob } = await import("@moss/notifications");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-11T09:00:00Z"));
      try {
        const row = {
          id: "n1",
          module_id: "chat",
          urgency: "normal",
          recipient_user_id: "u1",
          metadata: {}
        };
        const listActiveForDelivery = vi.fn().mockResolvedValue([]);
        const enqueueDeliver = vi.fn();
        const enqueueSummary = vi.fn();
        const deferDelivery = vi.fn();
        const isAllowedDuringQuietHours = vi.fn().mockResolvedValue(true);
        const deps = {
          notificationsRepository: {
            getById: async () => row,
            listUnreadDeferred: async () => [row],
            deferDelivery
          } as never,
          subscriptionsRepository: { listActiveForDelivery } as never,
          quietHoursPort: {
            getSettings: async () => ({
              enabled: true,
              start: "08:00",
              end: "10:00",
              timezone: "UTC"
            }),
            getLocaleTimezone: async () => null
          },
          pushQueuePort: { enqueueDeliver, enqueueSummary },
          isAllowedDuringQuietHours
        };
        const run = () =>
          summary
            ? runPushSummaryJob(
                summaryJob({
                  actorUserId: "u1",
                  recipientUserId: "u1",
                  releaseAt: "2026-10-11T08:00:00Z"
                }),
                fakeScopedDb,
                deps
              )
            : runPushDeliverJob(
                deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
                fakeScopedDb,
                deps
              );
        await run();
        expect(isAllowedDuringQuietHours).toHaveBeenCalledWith(fakeScopedDb, row);
        expect(listActiveForDelivery).toHaveBeenCalledOnce();
        expect(enqueueDeliver).not.toHaveBeenCalled();
        expect(enqueueSummary).not.toHaveBeenCalled();
        isAllowedDuringQuietHours.mockResolvedValue(false);
        await run();
        expect(listActiveForDelivery).toHaveBeenCalledOnce();
        expect(summary ? enqueueSummary : enqueueDeliver).toHaveBeenCalledOnce();
        expect(deferDelivery).toHaveBeenCalledTimes(summary ? 1 : 0);
      } finally {
        vi.useRealTimers();
      }
    }
  );
  it.each(["muted", "inactive", "sensitivity"])(
    "an allowance never overrides %s",
    async (block) => {
      const { runPushDeliverJob } = await import("@moss/notifications");
      const listActiveForDelivery = vi.fn();
      const isAllowedDuringQuietHours = vi.fn().mockResolvedValue(true);
      await runPushDeliverJob(
        deliverJob({ actorUserId: "u1", notificationId: "n1", recipientUserId: "u1" }),
        fakeScopedDb,
        {
          notificationsRepository: {
            getById: async () => ({ id: "n1", module_id: "chat", urgency: "normal", metadata: {} })
          } as never,
          subscriptionsRepository: { listActiveForDelivery } as never,
          notificationPreferencePort: {
            isModuleEnabled: async () => block !== "muted",
            getSensitivity: async () => (block === "sensitivity" ? "quiet" : "balanced")
          },
          isNotificationActive: async () => block !== "inactive",
          isAllowedDuringQuietHours
        }
      );
      expect(listActiveForDelivery).not.toHaveBeenCalled();
      expect(isAllowedDuringQuietHours).not.toHaveBeenCalled();
    }
  );
});
