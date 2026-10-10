import { CaptureWaiters } from "../../packages/meetings/src/capture-waiters.js";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
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
    acquireRecordingBinding: async () => ({ release: async () => {} }),
    scheduleMaintenance: async () => {},
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
      expect(limits.get("/api/meetings/capture/connection")?.max).toBe(120);
      expect(limits.get("/api/meetings/capture/status")?.max).toBe(600);
      expect(limits.get("/api/meetings/capture/audio")?.max).toBe(120);
      expect(limits.size).toBe(11);
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
        url: "/api/meetings/capture/connection",
        headers: { authorization: "Bearer tm1_synthetic" },
        payload: { connectionId: meetingId, verifierHash: "not-a-sha256-digest" }
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

describe("native recovery status", () => {
  it("preserves recovering as a distinct non-recording observation", async () => {
    const server = Fastify();
    const status = vi
      .spyOn(MeetingCaptureService.prototype, "status")
      .mockImplementation(async (_headers, _request, body) => ({
        capture: body as never,
        changed: true
      }));
    registerMeetingCaptureRoutes(server, dependencies());
    const observed = { generation: 1, phase: "recovering" };
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/meetings/capture/status",
        payload: {
          meetingId,
          grantId: meetingId,
          observed,
          inventory: {
            microphones: [],
            applications: [],
            computerAudio: { available: false, excludedProcessTreeIds: [] },
            microphonePermission: "granted",
            systemAudioPermission: "granted"
          }
        }
      });
      expect(response.statusCode).toBe(200);
      expect(status.mock.calls[0]![2].observed).toEqual(observed);
    } finally {
      status.mockRestore();
      await server.close();
    }
  });
});

describe("native default microphone inventory", () => {
  it.each([undefined, null, "os-default"])(
    "accepts the optional exact default UID %s",
    async (defaultMicrophoneId) => {
      const server = Fastify();
      const register = vi
        .spyOn(MeetingCaptureConnectionService.prototype, "register")
        .mockResolvedValue({
          connectionId: meetingId,
          revision: 1,
          leaseMs: 30000,
          expiresAt: "2027-01-01T00:00:00Z"
        });
      registerMeetingCaptureRoutes(server, dependencies());
      const inventory = {
        microphones: [{ deviceId: "os-default", sourceId: "mic", label: "Default microphone" }],
        applications: [],
        computerAudio: { available: true, excludedProcessTreeIds: ["moss"] },
        microphonePermission: "granted",
        systemAudioPermission: "granted",
        ...(defaultMicrophoneId !== undefined ? { defaultMicrophoneId } : {})
      };
      try {
        const response = await server.inject({
          method: "POST",
          url: "/api/meetings/capture/connection",
          payload: { connectionId: meetingId, verifierHash: "a".repeat(64), inventory }
        });
        expect(response.statusCode).toBe(200);
        expect(register.mock.calls[0]![2].inventory).toEqual(inventory);
      } finally {
        register.mockRestore();
        await server.close();
      }
    }
  );
});

describe("capture source envelope regression", () => {
  const computerOnly = {
    mode: "computer-audio",
    microphone: null,
    outputSourceId: "output",
    scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
  };
  it.each([
    {
      name: "explicit computer audio without a microphone",
      command: "change-sources",
      selection: computerOnly,
      status: 200
    },
    {
      name: "microphone-only without a microphone",
      command: "change-sources",
      selection: { mode: "microphone-only", microphone: null },
      status: 400
    },
    {
      name: "Resume carrying a source selection",
      command: "record",
      selection: computerOnly,
      status: 400
    },
    {
      name: "computer audio with the microphone field omitted",
      command: "change-sources",
      selection: { mode: "computer-audio", outputSourceId: "output", scope: computerOnly.scope },
      status: 400
    }
  ])("validates $name at native route ingress", async ({ command, selection, status }) => {
    const server = Fastify();
    const deps = dependencies();
    const control = vi
      .spyOn(MeetingCaptureService.prototype, "nativeControl")
      .mockImplementation(async (_headers, _requestId, input) => ({ capture: input as never }));
    registerMeetingCaptureRoutes(server, deps);
    const payload = {
      meetingId,
      grantId: meetingId,
      requestKey: meetingId,
      expectedGeneration: 2,
      command,
      ...(command === "change-sources" ? { expectedEpoch: 1 } : {}),
      selection
    };
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/meetings/capture/control",
        payload
      });
      expect(response.statusCode).toBe(status);
      if (status === 200) {
        expect(control).toHaveBeenCalledOnce();
        expect(control.mock.calls[0]?.[2]).toEqual(payload);
      } else {
        expect(control).not.toHaveBeenCalled();
        expect(deps.resolveCompanion).not.toHaveBeenCalled();
        expect(deps.dataContext.withDataContext).not.toHaveBeenCalled();
      }
    } finally {
      control.mockRestore();
      await server.close();
    }
  });
  it.each([
    { mode: "microphone-only", microphone: { deviceId: "mic", sourceId: "mic" } },
    {
      mode: "selected-app",
      microphone: { deviceId: "mic", sourceId: "mic" },
      outputSourceId: "output",
      appProcessTreeId: "app"
    },
    {
      mode: "computer-audio",
      microphone: { deviceId: "mic", sourceId: "mic" },
      outputSourceId: "output",
      scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
    }
  ])("preserves the exact $mode body with Fastify default AJV", async (selection) => {
    const server = Fastify();
    const browser = vi.spyOn(MeetingCaptureService.prototype, "browser").mockResolvedValue({
      actorUserId: meetingId,
      sessionId: meetingId,
      expiresAt: new Date("2027-01-01")
    });
    const control = vi
      .spyOn(MeetingCaptureService.prototype, "browserControl")
      .mockImplementation(async (_actor, _meetingId, input) => ({ capture: input as never }));
    registerMeetingCaptureRoutes(server, dependencies());
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/capture/control`,
        payload: {
          grantId: meetingId,
          requestKey: meetingId,
          expectedGeneration: 0,
          command: "record",
          selection
        }
      });
      expect(response.statusCode).toBe(200);
      expect(control.mock.calls[0]?.[2].selection).toEqual(selection);
    } finally {
      browser.mockRestore();
      control.mockRestore();
      await server.close();
    }
  });
});

describe("exact capture source branch guards", () => {
  it.each([
    {
      mode: "microphone-only",
      microphone: { deviceId: "mic", sourceId: "mic" },
      outputSourceId: "hidden"
    },
    {
      mode: "selected-app",
      microphone: { deviceId: "mic", sourceId: "mic" },
      outputSourceId: "output",
      appProcessTreeId: "app",
      scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
    }
  ])("rejects mixed branch metadata before identity resolution", async (selection) => {
    const server = Fastify(),
      deps = dependencies();
    registerMeetingCaptureRoutes(server, deps);
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/capture/control`,
        payload: {
          grantId: meetingId,
          requestKey: meetingId,
          expectedGeneration: 0,
          command: "record",
          selection
        }
      });
      expect(response.statusCode).toBe(400);
      expect(deps.resolveBrowser).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("does not expose obsolete per-meeting approval or legacy tm1 redemption", async () => {
    const server = Fastify();
    registerMeetingCaptureRoutes(server, dependencies());
    try {
      for (const route of [
        "/api/meetings/capture/link",
        "/api/meetings/capture/redeem",
        `/api/meetings/records/${meetingId}/capture/approve`
      ])
        expect(
          (
            await server.inject({
              method: "POST",
              url: route,
              payload: {},
              headers: { authorization: "Bearer tm1_legacy" }
            })
          ).statusCode
        ).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("explicit recording route boundary", () => {
  it.each(["start", "control"])(
    "allows %s with valid capture metadata and rejects unknown fields",
    async (kind) => {
      const server = Fastify();
      const browser = vi.spyOn(MeetingCaptureService.prototype, "browser").mockResolvedValue({
        actorUserId: meetingId,
        sessionId: meetingId,
        expiresAt: new Date("2027-01-01")
      });
      const start = vi
        .spyOn(MeetingCaptureConnectionService.prototype, "start")
        .mockResolvedValue({ capture: {} as never, wakeConnectionId: undefined });
      const control = vi
        .spyOn(MeetingCaptureService.prototype, "browserControl")
        .mockResolvedValue({ capture: {} as never });
      registerMeetingCaptureRoutes(server, dependencies());
      const common = {
        requestKey: meetingId,
        selection: { mode: "microphone-only", microphone: { deviceId: "mic", sourceId: "mic" } }
      };
      const payload =
        kind === "start"
          ? { ...common, deviceId: meetingId, connectionId: meetingId, expectedRevision: 1 }
          : { ...common, grantId: meetingId, expectedGeneration: 0, command: "record" };
      try {
        const response = await server.inject({
          method: "POST",
          url: `/api/meetings/records/${meetingId}/capture/${kind}`,
          payload: { ...payload, unknownField: true }
        });
        expect(response.statusCode).toBe(400);
        expect(start).not.toHaveBeenCalled();
        expect(control).not.toHaveBeenCalled();
        const accepted = await server.inject({
          method: "POST",
          url: `/api/meetings/records/${meetingId}/capture/${kind}`,
          payload
        });
        expect(accepted.statusCode).toBe(200);
        expect(kind === "start" ? start : control).toHaveBeenCalledOnce();
      } finally {
        browser.mockRestore();
        start.mockRestore();
        control.mockRestore();
        await server.close();
      }
    }
  );
});

describe("saved-source wake routing", () => {
  it("wakes only the resolved connection and never returns internal wake metadata", async () => {
    const server = Fastify();
    const connectionA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      connectionB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const browser = vi.spyOn(MeetingCaptureService.prototype, "browser").mockResolvedValue({
      actorUserId: meetingId,
      sessionId: meetingId,
      expiresAt: new Date("2027-01-01")
    });
    const start = vi.spyOn(MeetingCaptureConnectionService.prototype, "start").mockResolvedValue({
      capture: { grantId: meetingId } as never,
      wakeConnectionId: connectionA
    });
    const notify = vi.spyOn(CaptureWaiters.prototype, "notify");
    registerMeetingCaptureRoutes(server, dependencies());
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/capture/start`,
        payload: { requestKey: meetingId }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ capture: { grantId: meetingId } });
      expect(notify).toHaveBeenCalledWith(`device:${connectionA}`);
      expect(notify).not.toHaveBeenCalledWith(`device:${connectionB}`);
      expect(notify.mock.calls.filter(([key]) => key.startsWith("device:"))).toHaveLength(1);
    } finally {
      browser.mockRestore();
      start.mockRestore();
      notify.mockRestore();
      await server.close();
    }
  });
});
