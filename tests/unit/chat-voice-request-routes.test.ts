import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import type { VoiceRequest } from "@moss/chat";
import { registerVoiceRequestRoutes } from "../../packages/chat/src/voice-request-routes.js";

const id = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const actor = { actorUserId: "33333333-3333-4333-8333-333333333333" };

function fixture(android = false) {
  const row: VoiceRequest = {
    id,
    thread_id: threadId,
    source_device_id: "ring",
    recording_id: "recording",
    transcript: "Review my next meeting",
    state: "ready-to-send",
    captured_at: new Date("2026-10-20T20:00:00.000Z"),
    dispatch_boot_id: "private-boot",
    fingerprint: "private-fingerprint",
    user_message_id: "reserved-user",
    assistant_message_id: "reserved-assistant",
    owner_user_id: actor.actorUserId,
    transcript_revision: 1,
    automatic: false,
    auto_send: false,
    turn_id: "44444444-4444-4444-8444-444444444444",
    confirmed_at: null,
    dispatched_at: null,
    created_at: new Date("2026-10-20T20:00:00.000Z"),
    updated_at: new Date("2026-10-20T20:00:00.000Z")
  };
  const service = {
    list: vi.fn(async () => [row]),
    status: vi.fn(async (_actor: unknown, requestId: string) =>
      requestId === id ? row : undefined
    ),
    send: vi.fn(async () => ({ ...row, state: "queued" as const }))
  };
  const server = Fastify();
  registerVoiceRequestRoutes(server, {
    resolveAccessContext: async (request) => {
      if (request.headers.cookie !== "session=owner") throw new HttpError(401, "Session required");
      return actor;
    },
    ...(android
      ? {
          resolveRingRecordingAccessContext: async (request: {
            headers: { authorization?: string };
          }) => {
            if (request.headers.authorization !== "Bearer synthetic-ring")
              throw new HttpError(401, "Ring required");
            return actor;
          }
        }
      : {}),
    service
  });
  return { server, service, row };
}

describe("voice request status and explicit Send", () => {
  it("uses Android auth only for individual status, keeping list and Send on ordinary auth", async () => {
    const { server, service } = fixture(true);
    try {
      const headers = { authorization: "Bearer synthetic-ring" };
      expect(
        (await server.inject({ url: `/api/chat/voice-requests/${id}`, headers })).statusCode
      ).toBe(200);
      expect((await server.inject({ url: "/api/chat/voice-requests", headers })).statusCode).toBe(
        401
      );
      expect(
        (
          await server.inject({
            method: "POST",
            url: `/api/chat/voice-requests/${id}/send`,
            headers
          })
        ).statusCode
      ).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("lists a bounded public projection without reserved/dispatch internals", async () => {
    const { server } = fixture();
    try {
      const response = await server.inject({
        url: "/api/chat/voice-requests",
        headers: { cookie: "session=owner" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().requests[0]).toEqual({
        id,
        threadId,
        turnId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-10-20T20:00:00.000Z",
        sourceDeviceId: "ring",
        recordingId: "recording",
        transcript: "Review my next meeting",
        state: "ready-to-send",
        capturedAt: "2026-10-20T20:00:00.000Z",
        userMessageId: null,
        assistantMessageId: null,
        statusMessage: "Review this transcript and choose Send to send it to Main chat."
      });
    } finally {
      await server.close();
    }
  });

  it("validates cursor pairs and forwards a bounded keyset cursor", async () => {
    const { server, service } = fixture();
    try {
      const headers = { cookie: "session=owner" };
      expect(
        (await server.inject({ url: `/api/chat/voice-requests?beforeId=${id}`, headers }))
          .statusCode
      ).toBe(400);
      const createdAt = "2026-10-20T20:00:00.000Z";
      const query = new URLSearchParams({ beforeId: id, beforeCreatedAt: createdAt });
      expect(
        (await server.inject({ url: `/api/chat/voice-requests?${query}`, headers })).statusCode
      ).toBe(200);
      expect(service.list).toHaveBeenCalledWith(actor, { id, createdAt });
    } finally {
      await server.close();
    }
  });
  it("sends the authenticated owner's retained request without accepting replacement text", async () => {
    const { server, service } = fixture();
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/chat/voice-requests/${id}/send`,
        headers: { cookie: "session=owner" }
      });
      expect(response.statusCode).toBe(200);
      expect(service.send).toHaveBeenCalledExactlyOnceWith(actor, id);
      expect(response.json()).toMatchObject({
        state: "queued",
        statusMessage: "Waiting until Main chat is available."
      });
      const rejected = await server.inject({
        method: "POST",
        url: `/api/chat/voice-requests/${id}/send`,
        headers: { cookie: "session=owner" },
        payload: { transcript: "replace it" }
      });
      expect(rejected.statusCode).toBe(400);
      expect(service.send).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    "/api/chat/voice-requests",
    `/api/chat/voice-requests/${id}`,
    `/api/chat/voice-requests/${id}/send`
  ])("requires a session for %s", async (url) => {
    const { server, service } = fixture();
    try {
      const response = await server.inject({ method: url.endsWith("/send") ? "POST" : "GET", url });
      expect(response.statusCode).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.status).not.toHaveBeenCalled();
      expect(service.send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    "/api/chat/voice-requests",
    `/api/chat/voice-requests/${id}`,
    `/api/chat/voice-requests/${id}/send`
  ])("rejects delegated model access for %s", async (url) => {
    const { server, service } = fixture();
    try {
      const response = await server.inject({
        method: url.endsWith("/send") ? "POST" : "GET",
        url,
        headers: { cookie: "session=owner", [ACT_AS_GRANT_HEADER]: "delegated" }
      });
      expect(response.statusCode).toBe(403);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.status).not.toHaveBeenCalled();
      expect(service.send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns not found instead of exposing a missing owner's request", async () => {
    const { server } = fixture();
    try {
      const response = await server.inject({
        url: `/api/chat/voice-requests/${threadId}`,
        headers: { cookie: "session=owner" }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
