import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { MEETING_RECORDING_NOTICE } from "@moss/shared";
import { MeetingRecordingNoticeRepository } from "../../packages/meetings/src/recording-notice.js";
import { registerMeetingRecordingNoticeRoutes } from "../../packages/meetings/src/recording-notice-routes.js";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";

const current = { currentNotice: MEETING_RECORDING_NOTICE, acknowledgement: null };
describe("account recording notice", () => {
  it.each([null, { policyVersion: "previous-text", acknowledgedAt: new Date().toISOString() }])(
    "requires exact stored policy version (%s)",
    async (acknowledgement) => {
      const notices = new MeetingRecordingNoticeRepository();
      vi.spyOn(notices, "get").mockResolvedValue({ ...current, acknowledgement });
      await expect(notices.requireCurrent({} as DataContextDb)).rejects.toMatchObject({
        code: "meeting_capture_notice_required",
        httpStatus: 409
      });
    }
  );
  it("rejects acknowledgement for a version the server no longer displays before writing", async () => {
    const notices = new MeetingRecordingNoticeRepository();
    const scoped = { [dataContextBrand]: true, db: {} } as DataContextDb;
    await expect(notices.acknowledge(scoped, "previous-text")).rejects.toMatchObject({
      code: "meeting_capture_notice_required",
      httpStatus: 409
    });
  });
  it("does not accept caller-authored timestamps, owner identity, or acknowledgement objects", async () => {
    const server = Fastify();
    const repository = new MeetingRecordingNoticeRepository();
    const acknowledge = vi.spyOn(repository, "acknowledge").mockResolvedValue(current);
    const get = vi.spyOn(repository, "get").mockResolvedValue(current);
    registerMeetingRecordingNoticeRoutes(
      server,
      {
        resolveAccessContext: async () => ({ actorUserId: "owner" }),
        dataContext: { withDataContext: async (_actor, run) => run({} as DataContextDb) }
      },
      repository
    );
    try {
      expect((await server.inject("/api/meetings/recording-notice")).json()).toEqual(current);
      expect(get).toHaveBeenCalledOnce();
      for (const extra of [
        { acknowledgedAt: "2026-10-06T00:00:00Z" },
        { ownerUserId: "someone" },
        { acknowledgement: { policyVersion: "fake" } }
      ]) {
        expect(
          (
            await server.inject({
              method: "PUT",
              url: "/api/meetings/recording-notice",
              payload: { policyVersion: MEETING_RECORDING_NOTICE.policyVersion, ...extra }
            })
          ).statusCode
        ).toBe(400);
      }
      expect(acknowledge).not.toHaveBeenCalled();
      const response = await server.inject({
        method: "PUT",
        url: "/api/meetings/recording-notice",
        payload: { policyVersion: MEETING_RECORDING_NOTICE.policyVersion }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(acknowledge).toHaveBeenCalledExactlyOnceWith(
        {},
        MEETING_RECORDING_NOTICE.policyVersion
      );
    } finally {
      await server.close();
    }
  });
  it.each([
    {
      method: "PUT" as const,
      headers: { authorization: "Bearer tm1_other", origin: "https://moss.example" }
    },
    {
      method: "PUT" as const,
      headers: { cookie: "session=synthetic", origin: "https://untrusted.example" }
    },
    { method: "PUT" as const, headers: { cookie: "session=synthetic" } },
    { method: "GET" as const, headers: { authorization: "Bearer tm1_other" } }
  ])(
    "rejects invalid notice route credentials/origin before any store access",
    async ({ method, headers }) => {
      const server = Fastify();
      const deps: MeetingCaptureDependencies = {
        dataContext: { withDataContext: vi.fn() },
        resolveBrowser: vi.fn(),
        resolveCompanion: vi.fn(),
        acquireRecordingBinding: async () => ({ release: async () => {} }),
        scheduleMaintenance: async () => {},
        assertBinding: vi.fn(),
        device: vi.fn(),
        assertModuleAvailable: vi.fn(),
        processingAvailability: vi.fn(),
        transcribe: vi.fn(),
        trustedOrigins: ["https://moss.example"]
      };
      registerMeetingCaptureRoutes(server, deps);
      try {
        const response = await server.inject({
          method,
          url: "/api/meetings/recording-notice",
          headers,
          ...(method === "PUT"
            ? { payload: { policyVersion: MEETING_RECORDING_NOTICE.policyVersion } }
            : {})
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(deps.resolveBrowser).not.toHaveBeenCalled();
        expect(deps.dataContext.withDataContext).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    }
  );
});
