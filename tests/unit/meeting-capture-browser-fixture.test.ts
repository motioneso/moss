import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import type { DataContextDb } from "@moss/db";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import { createCaptureBrowserFixture } from "../uat/specs/meeting-capture-browser-fixture.js";

const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actor = { actorUserId: meetingId, sessionId: meetingId, expiresAt: new Date("2027-01-01") };
afterEach(() => vi.restoreAllMocks());

describe("automatic-summary UAT browser capture requests", () => {
  it("sends the replay fixture request through the guarded registered route", async () => {
    const server = Fastify();
    const resolveBrowser = vi.fn<MeetingCaptureDependencies["resolveBrowser"]>(
      async ({ headers }) => {
        if (headers.cookie !== "session=synthetic")
          throw Error("Missing synthetic browser session");
        return actor;
      }
    );
    const deps: MeetingCaptureDependencies = {
      dataContext: { withDataContext: vi.fn(async (_actor, run) => run({} as DataContextDb)) },
      resolveBrowser,
      resolveCompanion: vi.fn(),
      assertBinding: vi.fn(),
      device: vi.fn(),
      assertModuleAvailable: vi.fn(),
      processingAvailability: vi.fn(),
      transcribe: vi.fn(),
      trustedOrigins: ["https://moss.example"]
    };
    const control = vi
      .spyOn(MeetingCaptureService.prototype, "browserControl")
      .mockImplementation(async (_actor, _meetingId, input) => ({ capture: input as never }));
    registerMeetingCaptureRoutes(server, deps);
    const request = {
      post: vi.fn<APIRequestContext["post"]>()
    };
    const fixture = createCaptureBrowserFixture(
      request,
      "https://moss.example/nested/base?ignored=true"
    );
    const stopInput = {
      grantId: meetingId,
      requestKey: meetingId,
      expectedGeneration: 2,
      command: "stop" as const
    };
    await fixture.replayControl(meetingId, stopInput);
    const [url, options] = request.post.mock.calls[0]!;
    const method = "POST";
    try {
      // Inject the exact request produced by the helper used in the UAT, plus its shared cookie.
      const response = await server.inject({
        method,
        url,
        headers: { cookie: "session=synthetic", ...options?.headers },
        payload: options?.data
      });
      expect(response.statusCode).toBe(200);
      expect(resolveBrowser).toHaveBeenCalledOnce();
      expect(control).toHaveBeenCalledWith(actor, meetingId, stopInput);

      for (const origin of [undefined, "https://untrusted.example"]) {
        resolveBrowser.mockClear();
        control.mockClear();
        const rejected = await server.inject({
          method,
          url,
          headers: { cookie: "session=synthetic", ...(origin ? { origin } : {}) },
          payload: options?.data
        });
        expect(rejected.statusCode).toBe(401);
        expect(resolveBrowser).not.toHaveBeenCalled();
        expect(control).not.toHaveBeenCalled();
      }
    } finally {
      await server.close();
    }
  });
});
