import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureNativeControlInput, MeetingCaptureSelection } from "@moss/shared";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import { MeetingCaptureService } from "../../packages/meetings/src/capture-service.js";
import {
  addRecording,
  at,
  deviceId,
  fixture,
  grantId,
  meetingId,
  owner
} from "./helpers/meeting-capture-fixture.js";

const selection: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: null,
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
describe.each(["change-sources", "recover-sources"] as const)("%s native boundaries", (command) => {
  const change = (): MeetingCaptureNativeControlInput => ({
    meetingId,
    grantId,
    requestKey: randomUUID(),
    command,
    expectedGeneration: 1,
    expectedEpoch: 1,
    selection:
      command === "recover-sources"
        ? { mode: "microphone-only", microphone: { deviceId: "mic-device", sourceId: "mic" } }
        : selection
  });

  describe("source-change route boundaries", () => {
    it("preserves the exact explicit source body and rejects browser authority", async () => {
      const f = fixture(),
        server = Fastify();
      const native = vi
        .spyOn(MeetingCaptureService.prototype, "nativeControl")
        .mockImplementation(async (_headers, _request, body) => ({ capture: body as never }));
      registerMeetingCaptureRoutes(server, f.deps);
      try {
        const payload = change();
        const response = await server.inject({
          method: "POST",
          url: "/api/meetings/capture/control",
          payload
        });
        expect(response.statusCode).toBe(200);
        expect(native.mock.calls[0]?.[2]).toEqual(payload);
        const { meetingId: _meetingId, ...browserBody } = payload;
        const browser = await server.inject({
          method: "POST",
          url: `/api/meetings/records/${meetingId}/capture/control`,
          payload: browserBody
        });
        expect(browser.statusCode).toBe(400);
        expect(f.deps.resolveBrowser).not.toHaveBeenCalled();
        expect(native).toHaveBeenCalledTimes(1);
      } finally {
        native.mockRestore();
        await server.close();
      }
    });

    it.each([
      { expectedEpoch: undefined },
      { selection: undefined },
      { expectedEpoch: "1" },
      { expectedEpoch: 0 },
      { expectedEpoch: 65 },
      { expectedEpoch: 1.5 },
      { expectedGeneration: "1" },
      { expectedGeneration: -1 },
      { expectedGeneration: 1.5 },
      { selection: { ...selection, microphone: undefined } },
      { selection: { mode: "microphone-only", microphone: null } },
      { selection: { ...selection, extra: "unknown" } },
      ...["record", "pause", "stop"].map((command) => ({ command })),
      { command: "revoke" },
      { ownerUserId: randomUUID() },
      { deviceId: randomUUID() },
      { sessionId: randomUUID() },
      { unexpected: true }
    ])(
      "rejects incomplete, coerced, both-off, and source-bearing ordinary controls: %j",
      async (patch) => {
        const f = fixture(),
          server = Fastify();
        const native = vi.spyOn(MeetingCaptureService.prototype, "nativeControl");
        registerMeetingCaptureRoutes(server, f.deps);
        try {
          const response = await server.inject({
            method: "POST",
            url: "/api/meetings/capture/control",
            payload: { ...change(), ...patch }
          });
          expect(response.statusCode).toBe(400);
          expect(native).not.toHaveBeenCalled();
        } finally {
          native.mockRestore();
          await server.close();
        }
      }
    );
  });

  describe("source-change recording proof admission", () => {
    it.each(["meeting", "grant", "owner"] as const)(
      "rejects a valid credential retargeted to another %s before source mutation",
      async (target) => {
        const f = fixture();
        const other = addRecording(f, target === "owner" ? { owner_user_id: randomUUID() } : {});
        const before = f.grantRows.map((grant) => grant.state_json);
        const input = {
          ...change(),
          ...(target === "meeting"
            ? { meetingId: other.grant.meeting_id }
            : target === "grant"
              ? { grantId: other.grant.id }
              : { meetingId: other.grant.meeting_id, grantId: other.grant.id })
        };
        await expect(f.service.nativeControl(f.headers, "retarget", input)).rejects.toMatchObject({
          httpStatus: 401
        });
        expect(f.grantRows.map((grant) => grant.state_json)).toEqual(before);
        expect(f.repository.save).not.toHaveBeenCalled();
        expect(f.repository.reserve).not.toHaveBeenCalled();
        const result = await f.service.nativeControl(f.headers, "original", change());
        expect(result.capture).toMatchObject({ grantId, deviceId, generation: 2, epoch: 2 });
        expect(other.grant.state_json).toBe(before[1]);
      }
    );

    it("does not use another owner's grant when the token owner is substituted", async () => {
      const f = fixture();
      const other = addRecording(f, { owner_user_id: randomUUID() });
      const contexts = vi.spyOn(f.deps.dataContext, "withDataContext");
      const before = f.grantRows.map((grant) => grant.state_json);
      const headers = {
        authorization: f.headers.authorization.replace(owner, other.grant.owner_user_id)
      };
      await expect(
        f.service.nativeControl(headers, "owner-substitution", change())
      ).rejects.toMatchObject({ httpStatus: 401 });
      expect(contexts).toHaveBeenCalledExactlyOnceWith(
        { actorUserId: other.grant.owner_user_id, requestId: "owner-substitution" },
        expect.any(Function)
      );
      expect(f.repository.grant).toHaveBeenCalledExactlyOnceWith(expect.anything(), grantId);
      expect(f.deps.assertBinding).not.toHaveBeenCalled();
      expect(f.grantRows.map((grant) => grant.state_json)).toEqual(before);
      expect(f.repository.save).not.toHaveBeenCalled();
      expect(f.repository.reserve).not.toHaveBeenCalled();
    });

    it("does not reuse the original secret when the token and body name another grant", async () => {
      const f = fixture();
      const other = addRecording(f);
      const before = f.grantRows.map((grant) => grant.state_json);
      await expect(
        f.service.nativeControl(
          { authorization: f.headers.authorization.replace(grantId, other.grant.id) },
          "grant-substitution",
          { ...change(), meetingId: other.grant.meeting_id, grantId: other.grant.id }
        )
      ).rejects.toMatchObject({ httpStatus: 401 });
      expect(f.repository.grant).toHaveBeenCalledExactlyOnceWith(expect.anything(), other.grant.id);
      expect(f.deps.assertBinding).not.toHaveBeenCalled();
      expect(f.grantRows.map((grant) => grant.state_json)).toEqual(before);
      expect(f.repository.save).not.toHaveBeenCalled();
      expect(f.repository.reserve).not.toHaveBeenCalled();
    });

    it("cannot substitute another connected device when the claimed connection is absent", async () => {
      const f = fixture();
      const other = addRecording(f);
      const otherBefore = other.grant.state_json;
      f.connectionRows.splice(0, 1);
      await expect(
        f.service.nativeControl(f.headers, "device-substitution", change())
      ).rejects.toMatchObject({ httpStatus: 401 });
      expect(f.connections.connection).toHaveBeenCalledExactlyOnceWith(expect.anything(), deviceId);
      expect(f.connections.lock).toHaveBeenCalledWith(expect.anything(), deviceId);
      expect(f.repository.receipt).not.toHaveBeenCalled();
      expect(f.repository.reserve).not.toHaveBeenCalled();
      expect(other.grant.state_json).toBe(otherBefore);
      expect(JSON.parse(f.grant.state_json!)).toMatchObject({
        desired: "revoked",
        epochs: [{ epoch: 1, selection: { mode: "microphone-only" } }]
      });
    });

    it("rechecks the original session after preflight and before reserving a source change", async () => {
      const f = fixture();
      const acquire = vi.spyOn(f.deps, "acquireRecordingBinding");
      vi.mocked(f.deps.assertBinding)
        .mockResolvedValueOnce()
        .mockRejectedValueOnce({ httpStatus: 401, bindingReason: "session-ended" });
      await expect(
        f.service.nativeControl(f.headers, "ended-session", change())
      ).rejects.toMatchObject({ httpStatus: 401, revocationReason: "session-ended" });
      const binding = { actorUserId: owner, sessionId: f.grant.session_id, deviceId };
      expect(f.deps.assertBinding).toHaveBeenNthCalledWith(1, binding);
      expect(f.deps.assertBinding).toHaveBeenNthCalledWith(2, binding);
      expect(acquire).not.toHaveBeenCalled();
      expect(f.repository.receipt).not.toHaveBeenCalled();
      expect(f.repository.reserve).not.toHaveBeenCalled();
      expect(JSON.parse(f.grant.state_json!)).toMatchObject({
        desired: "revoked",
        revocationReason: "session-ended",
        epochs: [{ epoch: 1, selection: { mode: "microphone-only" } }]
      });
    });

    it.each([
      {},
      { authorization: "Bearer tm1_general" },
      { cookie: "session=browser" },
      { authorization: `Bearer mm1_${owner}.${grantId}.${"x".repeat(43)}` }
    ])(
      "requires the claimed mm1 credential and rejects cookie substitution: %j",
      async (headers) => {
        const f = fixture();
        await expect(
          f.service.nativeControl(headers, "credential", change())
        ).rejects.toMatchObject({
          httpStatus: 401
        });
        expect(f.repository.reserve).not.toHaveBeenCalled();
        expect(f.repository.save).not.toHaveBeenCalled();
        await expect(
          f.service.nativeControl({ ...f.headers, cookie: "session=browser" }, "cookie", change())
        ).rejects.toMatchObject({ httpStatus: 401 });
      }
    );

    it.each(["connection_id", "capability_revision", "verifier_hash"] as const)(
      "rechecks the locked recording connection %s before source admission",
      async (field) => {
        const f = fixture();
        if (field === "capability_revision") f.connection.capability_revision = 2;
        else f.connection[field] = randomUUID();
        await expect(f.service.nativeControl(f.headers, "proof", change())).rejects.toMatchObject({
          httpStatus: 401
        });
        expect(f.repository.reserve).not.toHaveBeenCalled();
        expect(JSON.parse(f.grant.state_json!).epochs).toHaveLength(1);
      }
    );

    it("rejects a credential rotated while waiting for the recording lock", async () => {
      const f = fixture();
      vi.mocked(f.repository.grant).mockImplementation(async (_db, _grantId, lock) => {
        if (lock) return { ...f.grant, credential_hash: "f".repeat(64) };
        return f.grant;
      });
      await expect(f.service.nativeControl(f.headers, "rotated", change())).rejects.toMatchObject({
        httpStatus: 401
      });
      expect(f.repository.reserve).not.toHaveBeenCalled();
      expect(JSON.parse(f.grant.state_json!).epochs).toHaveLength(1);
    });

    it.each(["device-unavailable", "recording-permission-revoked", "session-ended"])(
      "holds the recording binding fence for source changes: %s",
      async (bindingReason) => {
        const f = fixture();
        vi.spyOn(f.deps, "acquireRecordingBinding").mockImplementation(async () => {
          throw { httpStatus: 401, bindingReason };
        });
        await expect(f.service.nativeControl(f.headers, "fence", change())).rejects.toMatchObject({
          httpStatus: 401
        });
        expect(f.deps.acquireRecordingBinding).toHaveBeenCalledWith({
          actorUserId: owner,
          sessionId: f.grant.session_id,
          deviceId: f.grant.device_id,
          capabilityRevision: 1
        });
        expect(f.repository.reserve).not.toHaveBeenCalled();
        expect(JSON.parse(f.grant.state_json!).epochs).toHaveLength(1);
      }
    );

    it("rechecks the immutable grant deadline after acquiring the source-change fence", async () => {
      let now = at(2000);
      const f = fixture(undefined, () => now);
      f.grant.expires_at = at(3000);
      vi.spyOn(f.deps, "acquireRecordingBinding").mockImplementation(async () => {
        now = at(3000);
        return { release: async () => {} };
      });
      await expect(f.service.nativeControl(f.headers, "deadline", change())).rejects.toMatchObject({
        httpStatus: 401
      });
      expect(f.repository.reserve).not.toHaveBeenCalled();
      expect(JSON.parse(f.grant.state_json!).epochs).toHaveLength(1);
    });

    it.each(["expired-grant", "revoked-grant", "expired-connection", "stale-connection"])(
      "refuses stale recording authority: %s",
      async (kind) => {
        const f = fixture();
        if (kind === "expired-grant") f.grant.expires_at = at(2000);
        if (kind === "revoked-grant") f.grant.status = "revoked";
        if (kind === "expired-connection") f.connection.expires_at = at(2000);
        if (kind === "stale-connection") f.connection.last_seen_at = at(-30000);
        await expect(f.service.nativeControl(f.headers, "stale", change())).rejects.toThrow();
        expect(f.repository.reserve).not.toHaveBeenCalled();
        expect(JSON.parse(f.grant.state_json!).epochs).toHaveLength(1);
      }
    );
  });
});
