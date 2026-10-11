import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import { CaptureWaiters } from "../../packages/meetings/src/capture-waiters.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import { MeetingCaptureError } from "../../packages/meetings/src/capture-domain.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("bounded capture transport", () => {
  it("limits parallel subscriptions and releases waiters on notification or abort", async () => {
    const state = new CaptureWaiters();
    const abort = new AbortController();
    const waits = [
      state.wait("owner", 1000, abort.signal),
      state.wait("owner", 1000),
      state.wait("owner", 1000),
      state.wait("owner", 1000)
    ];
    await expect(state.wait("owner", 1000)).rejects.toMatchObject({ httpStatus: 429 });
    abort.abort();
    state.notify("owner");
    await Promise.all(waits);
    const again = state.wait("owner", 1000);
    state.notify("owner");
    await again;
  });
  it("reauthenticates an unchanged conditional browser snapshot after waiting", async () => {
    const server = Fastify();
    const browser = vi
      .spyOn(MeetingCaptureService.prototype, "browser")
      .mockResolvedValueOnce({ actorUserId: id, sessionId: id, expiresAt: new Date("2027-01-01") })
      .mockRejectedValueOnce(new MeetingCaptureError());
    const status = vi.spyOn(MeetingCaptureService.prototype, "browserStatus").mockResolvedValue({
      capture: null,
      pendingLinks: [],
      processingReady: true,
      revision: "none",
      retryAfterMs: 1000
    });
    registerMeetingCaptureRoutes(server, {} as MeetingCaptureDependencies);
    try {
      const response = await server.inject({
        url: `/api/meetings/records/${id}/capture?revision=none&waitMs=10`
      });
      expect(response.statusCode).toBe(401);
      expect(browser).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenCalledOnce();
    } finally {
      browser.mockRestore();
      status.mockRestore();
      await server.close();
    }
  });
  it("redacts the independent recording proof while preserving caller logger configuration", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      }
    });
    const logger = recordingLoggerOptions({ stream, redact: ["otherSecret"] });
    const server = Fastify({ logger });
    server.get("/synthetic", async (request) => {
      request.log.info(
        { headers: request.headers, otherSecret: "other-private" },
        "synthetic diagnostic"
      );
      return { ok: true };
    });
    try {
      expect(
        (
          await server.inject({
            url: "/synthetic",
            headers: { "x-moss-recording-proof": "private-proof-value" }
          })
        ).statusCode
      ).toBe(200);
      expect(output).not.toContain("private-proof-value");
      expect(output).not.toContain("other-private");
      expect(output).toContain("synthetic diagnostic");
    } finally {
      await server.close();
    }
  });
});
