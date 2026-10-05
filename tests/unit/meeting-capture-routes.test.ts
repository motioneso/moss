import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";
const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function dependencies(): MeetingCaptureDependencies {
  return {
    dataContext: { withDataContext: vi.fn() },
    resolveBrowser: vi.fn(async () => {
      throw Error("synthetic unavailable");
    }),
    resolveCompanion: vi.fn(async () => {
      throw Error("synthetic unavailable");
    }),
    assertBinding: vi.fn(),
    device: vi.fn(),
    assertModuleAvailable: vi.fn(),
    processingAvailability: vi.fn(),
    transcribe: vi.fn(),
    trustedOrigins: ["https://moss.example"]
  };
}
describe("capture route credential boundaries", () => {
  it("pins every capture rate bucket to peer IP despite rotating junk credentials", async () => {
    const server = Fastify();
    const limits = new Map<
      string,
      { max: number; keyGenerator: (request: FastifyRequest) => string }
    >();
    server.addHook("onRoute", (route) => {
      if (route.method === "POST" || route.method === "GET")
        limits.set(
          route.url,
          route.config?.rateLimit as {
            max: number;
            keyGenerator: (request: FastifyRequest) => string;
          }
        );
    });
    registerMeetingCaptureRoutes(server, dependencies());
    try {
      await server.ready();
      expect(limits.get("/api/meetings/capture/link")?.max).toBe(20);
      expect(limits.get("/api/meetings/capture/status")?.max).toBe(600);
      expect(limits.get("/api/meetings/capture/audio")?.max).toBe(120);
      expect(limits.size).toBe(8);
      for (const limiter of limits.values())
        expect(
          limiter.keyGenerator({
            ip: "192.0.2.10",
            headers: { authorization: "Bearer one" }
          } as FastifyRequest)
        ).toBe(
          limiter.keyGenerator({
            ip: "192.0.2.10",
            headers: { authorization: "Bearer two", cookie: "rotated" }
          } as FastifyRequest)
        );
    } finally {
      await server.close();
    }
  });
  it("registers all schemas and denies browser bearer/cross-site requests before resolution", async () => {
    const server = Fastify(),
      deps = dependencies();
    registerMeetingCaptureRoutes(server, deps);
    try {
      await server.ready();
      for (const headers of [
        { authorization: "Bearer tm1_synthetic", origin: "https://moss.example" },
        { cookie: "session=synthetic", origin: "https://untrusted.example" }
      ]) {
        const response = await server.inject({
          method: "POST",
          url: `/api/meetings/records/${meetingId}/capture/control`,
          headers,
          payload: {
            grantId: meetingId,
            requestKey: meetingId,
            expectedGeneration: 0,
            command: "stop"
          }
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(deps.resolveBrowser).not.toHaveBeenCalled();
      expect(deps.dataContext.withDataContext).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("rejects cookie substitution and general session bearer on native controls", async () => {
    const server = Fastify(),
      deps = dependencies();
    registerMeetingCaptureRoutes(server, deps);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/meetings/capture/control",
        headers: { cookie: "session=synthetic", authorization: `Bearer ${meetingId}` },
        payload: {
          meetingId,
          grantId: meetingId,
          requestKey: meetingId,
          expectedGeneration: 0,
          command: "stop"
        }
      });
      expect(response.statusCode).toBe(401);
      expect(deps.resolveBrowser).not.toHaveBeenCalled();
      expect(deps.dataContext.withDataContext).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("rejects malformed or unrecognized metadata before any authentication port", async () => {
    const server = Fastify(),
      deps = dependencies();
    registerMeetingCaptureRoutes(server, deps);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/meetings/capture/link",
        headers: { authorization: "Bearer tm1_synthetic" },
        payload: { meetingId, verifierHash: "not-a-sha256-digest" }
      });
      expect(response.statusCode).toBe(400);
      expect(deps.resolveCompanion).not.toHaveBeenCalled();
      const missingGrant = await server.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/capture/control`,
        headers: { cookie: "session=synthetic", origin: "https://moss.example" },
        payload: { requestKey: meetingId, expectedGeneration: 0, command: "stop" }
      });
      expect(missingGrant.statusCode).toBe(400);
      expect(deps.resolveBrowser).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
