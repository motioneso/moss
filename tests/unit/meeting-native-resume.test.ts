import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureSelection } from "@moss/shared";
import { captureState } from "../../packages/meetings/src/capture-repository.js";
import { MeetingCaptureError } from "../../packages/meetings/src/capture-domain.js";
import {
  at,
  command,
  deviceId,
  fixture,
  grantId,
  meetingId,
  owner
} from "./helpers/meeting-capture-fixture.js";

async function paused(selection?: MeetingCaptureSelection) {
  const f = fixture(selection);
  await f.service.browserControl(f.browser, meetingId, command("pause", 1));
  vi.spyOn(f.repository, "renewClaim").mockResolvedValue();
  vi.mocked(f.repository.save).mockClear();
  vi.mocked(f.repository.receipt).mockClear();
  return f;
}
const resume = () => ({
  meetingId,
  grantId,
  requestKey: randomUUID(),
  expectedGeneration: 2,
  command: "record" as const
});
const selections: MeetingCaptureSelection[] = [
  { mode: "microphone-only", microphone: { deviceId: "mic-device", sourceId: "mic" } },
  {
    mode: "selected-app",
    microphone: { deviceId: "mic-device", sourceId: "mic" },
    outputSourceId: "app-output",
    appProcessTreeId: "selected-app"
  },
  {
    mode: "computer-audio",
    microphone: { deviceId: "mic-device", sourceId: "mic" },
    outputSourceId: "computer-output",
    scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
  }
];
describe("narrow native Resume", () => {
  it.each(selections)(
    "resumes only the retained $mode source with unchanged authority and idempotent replay",
    async (selection) => {
      const f = await paused(selection);
      const before = { ...f.grant };
      const input = resume();
      const binding = vi.spyOn(f.deps, "acquireRecordingBinding");
      const result = await f.service.nativeControl(f.headers, "resume", input);
      expect(result.capture.selection).toEqual(selection);
      expect(captureState(f.grant)).toMatchObject({ generation: 3, desired: "recording" });
      expect(captureState(f.grant).epochs).toHaveLength(2);
      expect(binding).toHaveBeenCalledWith({
        actorUserId: owner,
        sessionId: before.session_id,
        deviceId,
        capabilityRevision: 1
      });
      expect({ ...f.grant, state_json: before.state_json }).toEqual(before);
      expect(f.repository.renewClaim).not.toHaveBeenCalled();
      expect(f.preferences.get).not.toHaveBeenCalled();
      vi.mocked(f.deps.processingAvailability).mockRejectedValue(new Error("Provider unavailable"));
      expect(await f.service.nativeControl(f.headers, "retry", input)).toEqual(result);
      expect(captureState(f.grant).epochs).toHaveLength(2);
      expect(f.repository.save).toHaveBeenCalledOnce();
    }
  );

  it.each(["tm1", "cookie", "wrong-mm1", "wrong-grant", "wrong-owner"])(
    "denies %s proof before native Resume",
    async (kind) => {
      const f = await paused();
      const headers =
        kind === "cookie"
          ? { ...f.headers, cookie: "session=synthetic" }
          : {
              authorization:
                kind === "tm1"
                  ? `Bearer tm1_${"t".repeat(43)}`
                  : kind === "wrong-mm1"
                    ? f.headers.authorization.replace("s".repeat(43), "x".repeat(43))
                    : f.headers.authorization.replace(
                        kind === "wrong-grant" ? grantId : owner,
                        randomUUID()
                      )
            };
      await expect(f.service.nativeControl(headers, "denied", resume())).rejects.toMatchObject({
        httpStatus: 401
      });
      expect(f.repository.save).not.toHaveBeenCalled();
    }
  );

  it.each([
    "ready",
    "unclaimed",
    "finalizing",
    "complete",
    "idle",
    "recording",
    "stopped",
    "revoked",
    "expired",
    "missing-epoch"
  ])("denies %s without creating or renewing native recording authority", async (kind) => {
    const f = await paused();
    const state = captureState(f.grant);
    if (kind === "ready" || kind === "unclaimed") {
      f.grant.status = "approved";
      f.grant.credential_hash = null;
    }
    if (kind === "idle" || kind === "recording" || kind === "stopped" || kind === "revoked")
      state.desired = kind;
    if (kind === "finalizing" || kind === "complete") f.grant.status = kind;
    if (kind === "expired") f.grant.expires_at = at(2000);
    if (kind === "missing-epoch" || kind === "ready") state.epochs = [];
    if (kind === "stopped") f.grant.status = "finalizing";
    if (kind === "revoked") f.grant.status = "revoked";
    f.grant.state_json = JSON.stringify(state);
    await expect(f.service.nativeControl(f.headers, "denied", resume())).rejects.toMatchObject({
      httpStatus: 401
    });
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.repository.renewClaim).not.toHaveBeenCalled();
  });

  it("denies native initial Start even with an active claimed credential", async () => {
    const f = await paused();
    const state = captureState(f.grant);
    state.desired = "idle";
    f.grant.state_json = JSON.stringify(state);
    await expect(f.service.nativeControl(f.headers, "denied", resume())).rejects.toMatchObject({
      httpStatus: 401
    });
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it("requires the exact paused generation", async () => {
    const f = await paused();
    await expect(
      f.service.nativeControl(f.headers, "denied", { ...resume(), expectedGeneration: 1 })
    ).rejects.toMatchObject({ code: "meeting_capture_conflict", httpStatus: 409 });
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it.each(["record", "pause", "stop"] as const)(
    "rejects explicit selection at native %s ingress even when a matching browser receipt exists",
    async (action) => {
      const f = await paused();
      const input = { ...resume(), command: action, selection: selections[0] };
      // A prior receipt must never widen native ingress, even for an otherwise valid control.
      vi.mocked(f.repository.receipt).mockResolvedValue({
        request_key: input.requestKey,
        kind: "control",
        fingerprint: "synthetic",
        metadata_json: "{}",
        result_json: "{}",
        created_at: at(2000)
      });
      await expect(f.service.nativeControl(f.headers, "denied", input)).rejects.toMatchObject({
        httpStatus: 401
      });
      expect(f.repository.receipt).not.toHaveBeenCalled();
      expect(f.repository.save).not.toHaveBeenCalled();
    }
  );

  it("rejects native revoke even with a committed receipt", async () => {
    const f = await paused();
    vi.mocked(f.repository.receipt).mockResolvedValue({
      request_key: randomUUID(),
      kind: "control",
      fingerprint: "synthetic",
      metadata_json: "{}",
      result_json: "{}",
      created_at: at(2000)
    });
    await expect(
      f.service.nativeControl(f.headers, "denied", { ...resume(), command: "revoke" })
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect(f.repository.receipt).not.toHaveBeenCalled();
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it.each(["session", "device", "capability", "fence"])(
    "denies revoked %s binding before resuming",
    async (kind) => {
      const f = await paused();
      const failure = Object.assign(new Error("Synthetic binding revoked"), {
        httpStatus: kind === "capability" ? 403 : 401,
        bindingReason:
          kind === "capability"
            ? "recording-permission-revoked"
            : kind === "device"
              ? "device-unavailable"
              : "session-ended"
      });
      if (kind === "session" || kind === "device")
        vi.mocked(f.deps.assertBinding).mockRejectedValue(failure);
      else if (kind === "capability")
        vi.mocked(f.deps.assertRecordingBinding!).mockRejectedValue(failure);
      else vi.spyOn(f.deps, "acquireRecordingBinding").mockRejectedValue(failure);
      await expect(f.service.nativeControl(f.headers, "denied", resume())).rejects.toMatchObject({
        httpStatus: 401
      });
      expect(captureState(f.grant).epochs).toHaveLength(1);
      expect(captureState(f.grant).desired).not.toBe("recording");
      expect(f.repository.renewClaim).not.toHaveBeenCalled();
    }
  );

  it.each(["connection", "capability", "verifier", "expired", "stale", "source", "provider"])(
    "denies unavailable or changed %s without falling back to defaults",
    async (kind) => {
      const f = await paused();
      if (kind === "connection") f.connection.connection_id = randomUUID();
      if (kind === "capability") f.connection.capability_revision++;
      if (kind === "verifier") f.connection.verifier_hash = "b".repeat(64);
      if (kind === "expired") f.connection.expires_at = at(2000);
      if (kind === "stale") f.connection.last_seen_at = at(-30001);
      if (kind === "source")
        f.connection.inventory_json = JSON.stringify({
          ...JSON.parse(f.connection.inventory_json),
          microphones: []
        });
      if (kind === "provider")
        vi.mocked(f.deps.processingAvailability).mockResolvedValue({
          ready: false,
          modelRoute: null
        });
      await expect(f.service.nativeControl(f.headers, "denied", resume())).rejects.toBeInstanceOf(
        MeetingCaptureError
      );
      expect(f.repository.save).not.toHaveBeenCalled();
      expect(f.preferences.get).not.toHaveBeenCalled();
      expect(f.repository.renewClaim).not.toHaveBeenCalled();
    }
  );

  it("checks the paused-only guard inside the auth-fenced transaction", async () => {
    const f = await paused();
    vi.spyOn(f.deps, "acquireRecordingBinding").mockImplementation(async () => {
      const current = captureState(f.grant);
      current.desired = "idle";
      f.grant.state_json = JSON.stringify(current);
      return { release: async () => {} };
    });
    await expect(f.service.nativeControl(f.headers, "denied", resume())).rejects.toMatchObject({
      httpStatus: 401
    });
    expect(f.repository.save).not.toHaveBeenCalled();
  });
});
