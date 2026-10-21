import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import { RecordingImportInputError, RecordingImportConflictError } from "@moss/meetings";
import { registerRecordingVoiceRoutes } from "../../packages/meetings/src/recording-voice-routes.js";

const id = "a0000000-0000-4000-8000-000000000001";
function fixture() {
  const receipt = {
    id,
    state: "complete" as const,
    intent: "voice-request" as const,
    voiceRequestId: id,
    code: null,
    retryable: false
  };
  const service = {
    enableVoice: vi.fn(async () => ({
      id,
      sourceDeviceId: id,
      enabled: true,
      enabledAt: new Date(0).toISOString()
    })),
    disableVoice: vi.fn(async () => ({
      id,
      sourceDeviceId: id,
      enabled: false,
      enabledAt: new Date(0).toISOString()
    })),
    acceptVoice: vi.fn(async () => ({ ...receipt, created: true })),
    voiceStatus: vi.fn(async () => receipt),
    retryVoice: vi.fn(async () => receipt)
  };
  const server = Fastify();
  registerRecordingVoiceRoutes(server, {
    service,
    resolveAccessContext: async () => ({ actorUserId: id })
  });
  return { server, service, receipt };
}

describe("versioned voice receiver routes", () => {
  it.each([
    ["POST", "/voice-enablement"],
    ["POST", `/voice-enablement/${id}/disable`],
    ["POST", "/voice-recordings"],
    ["GET", `/voice-recordings/${id}`],
    ["POST", `/voice-recordings/${id}/retry`]
  ] as const)(
    "rejects delegated model access to %s %s before invoking the receiver",
    async (method, path) => {
      const f = fixture();
      try {
        const response = await f.server.inject({
          method,
          url: `/api/meetings${path}`,
          headers: { [ACT_AS_GRANT_HEADER]: "delegated" }
        });
        expect(response.statusCode).toBe(403);
        for (const operation of Object.values(f.service)) expect(operation).not.toHaveBeenCalled();
      } finally {
        await f.server.close();
      }
    }
  );
  it("returns an explicit receipt and maps source conflicts and validation failures", async () => {
    const f = fixture();
    try {
      const response = await f.server.inject({
        method: "POST",
        url: "/api/meetings/voice-recordings",
        payload: { version: 2 }
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(f.receipt);
      f.service.acceptVoice.mockRejectedValueOnce(new RecordingImportConflictError());
      expect(
        (await f.server.inject({ method: "POST", url: "/api/meetings/voice-recordings" }))
          .statusCode
      ).toBe(409);
      f.service.acceptVoice.mockRejectedValueOnce(new RecordingImportInputError());
      expect(
        (await f.server.inject({ method: "POST", url: "/api/meetings/voice-recordings" }))
          .statusCode
      ).toBe(400);
    } finally {
      await f.server.close();
    }
  });
  it("rejects replacement bodies and invalid resource IDs before retrying transcription", async () => {
    const f = fixture();
    try {
      for (const path of [`/voice-recordings/${id}/retry`, `/voice-enablement/${id}/disable`]) {
        expect(
          (
            await f.server.inject({
              method: "POST",
              url: `/api/meetings${path}`,
              payload: { transcript: "replacement" }
            })
          ).statusCode
        ).toBe(400);
      }
      expect(
        (await f.server.inject({ method: "GET", url: "/api/meetings/voice-recordings/not-an-id" }))
          .statusCode
      ).toBe(400);
      expect(f.service.retryVoice).not.toHaveBeenCalled();
      expect(f.service.disableVoice).not.toHaveBeenCalled();
      expect(f.service.voiceStatus).not.toHaveBeenCalled();
    } finally {
      await f.server.close();
    }
  });
});
