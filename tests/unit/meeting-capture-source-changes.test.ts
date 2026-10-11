import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  MeetingCaptureControlInput,
  MeetingCaptureNativeControlInput,
  MeetingCaptureSelection
} from "@moss/shared";
import {
  MeetingCaptureError,
  applyCaptureSourceChange,
  assertCaptureAudioAdmission,
  expireCaptureLease,
  retainCaptureGap,
  type CaptureStoredState
} from "../../packages/meetings/src/capture-domain.js";
import { choiceFromCapture } from "../../packages/meetings/src/web/capture-presentation.js";
import {
  at,
  audio,
  command,
  fixture,
  grantId,
  inventory,
  meetingId,
  recording
} from "./helpers/meeting-capture-fixture.js";

const systemOnly: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: null,
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
const microphoneOnly: MeetingCaptureSelection = {
  mode: "microphone-only",
  microphone: { deviceId: "mic-device", sourceId: "mic" }
};
function change(
  selection: MeetingCaptureSelection = systemOnly,
  expectedGeneration = 1,
  expectedEpoch = 1
) {
  return {
    meetingId,
    grantId,
    requestKey: randomUUID(),
    command: "change-sources" as const,
    expectedGeneration,
    expectedEpoch,
    selection
  };
}
function stored(f: ReturnType<typeof fixture>): CaptureStoredState {
  return JSON.parse(f.grant.state_json!) as CaptureStoredState;
}

describe("explicit native source changes", () => {
  it.each<MeetingCaptureSelection>([
    systemOnly,
    { ...systemOnly, microphone: microphoneOnly.microphone },
    { mode: "microphone-only", microphone: { deviceId: "other-device", sourceId: "other-mic" } }
  ])(
    "creates an acknowledged source epoch for $mode without renewing authority",
    async (selection) => {
      const f = fixture();
      f.connection.inventory_json = JSON.stringify({
        ...inventory,
        microphones: [
          ...inventory.microphones,
          { deviceId: "other-device", sourceId: "other-mic", label: "Other microphone" }
        ]
      });
      f.grant.claim_expires_at = at(60000);
      const authority = { ...f.grant, state_json: undefined };
      const renew = vi.spyOn(f.repository, "renewClaim");
      const input = change(selection);
      const result = await f.service.nativeControl(f.headers, "change", input);
      expect(result.capture).toMatchObject({
        generation: 2,
        epoch: 2,
        desired: "recording",
        selection,
        epochStartMs: 2000,
        epochEndMs: null,
        expiresAt: authority.expires_at.toISOString(),
        observed: { generation: 1 }
      });
      expect(stored(f).epochs[0]).toMatchObject({
        epoch: 1,
        generation: 1,
        endMs: 2000,
        selection: microphoneOnly
      });
      expect(stored(f).epochs[1]?.modelRoute).toBe("route");
      expect({ ...f.grant, state_json: undefined }).toEqual(authority);
      expect(renew).not.toHaveBeenCalled();
      expect(f.preferences.get).not.toHaveBeenCalled();
      expect(f.deps.processingAvailability).not.toHaveBeenCalled();
      expect(await f.service.nativeControl(f.headers, "retry", input)).toEqual(result);
      expect(f.repository.reserve).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps a paused source edit paused and ordinary Resume copies the exact choice", async () => {
    const f = fixture();
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    const changed = await f.service.nativeControl(f.headers, "change", change(systemOnly, 2));
    expect(changed.capture).toMatchObject({
      generation: 3,
      epoch: 2,
      desired: "paused",
      selection: systemOnly,
      epochStartMs: 2000,
      epochEndMs: 2000
    });
    const paused = stored(f);
    expect(() =>
      assertCaptureAudioAdmission(
        paused,
        { ...audio(), epoch: 2, generation: 3, sourceId: "output", startMs: 2000, endMs: 2100 },
        at(2100)
      )
    ).toThrow();
    const result = await f.service.nativeControl(f.headers, "resume", {
      meetingId,
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 3,
      command: "record"
    });
    expect(result.capture).toMatchObject({
      generation: 4,
      epoch: 3,
      desired: "recording",
      selection: systemOnly
    });
    expect(stored(f).epochs[1]?.endMs).toBe(2000);
    expect(f.preferences.get).not.toHaveBeenCalled();
  });

  it("binds source-change receipts to the entire body, including selection and both counters", async () => {
    const f = fixture(),
      input = change();
    await f.service.nativeControl(f.headers, "change", input);
    const accepted = f.grant.state_json;
    for (const patch of [
      { selection: microphoneOnly },
      { expectedEpoch: 2 },
      { expectedGeneration: 2 },
      { selection: { ...systemOnly, outputSourceId: "other-output" } }
    ]) {
      await expect(
        f.service.nativeControl(f.headers, "changed-retry", { ...input, ...patch })
      ).rejects.toThrow("conflict");
      expect(f.grant.state_json).toBe(accepted);
    }
    expect(f.repository.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([{ expectedEpoch: 2 }, { expectedGeneration: 2 }])(
    "rejects stale source intent without mutation: %j",
    async (patch) => {
      const f = fixture(),
        before = f.grant.state_json;
      await expect(
        f.service.nativeControl(f.headers, "stale", { ...change(), ...patch })
      ).rejects.toMatchObject({ code: "meeting_capture_conflict", httpStatus: 409 });
      expect(f.grant.state_json).toBe(before);
      expect(f.repository.save).not.toHaveBeenCalled();
      expect(f.repository.reserve).not.toHaveBeenCalled();
    }
  );

  it.each<MeetingCaptureSelection>([
    { ...microphoneOnly, microphone: { deviceId: "mic-device", sourceId: "wrong-source" } },
    { ...microphoneOnly, microphone: { deviceId: "wrong-device", sourceId: "mic" } },
    { ...systemOnly, outputSourceId: "mic" },
    { ...systemOnly, scope: { kind: "process-exclusion", excludedProcessTreeIds: [] } },
    { ...systemOnly, scope: { kind: "process-exclusion", excludedProcessTreeIds: ["other"] } },
    { ...systemOnly, scope: { kind: "endpoint", endpointId: "implicit-output" } },
    {
      mode: "selected-app",
      microphone: microphoneOnly.microphone,
      outputSourceId: "output",
      appProcessTreeId: "missing"
    }
  ])("rejects unverified source selection without mutation: %j", async (selection) => {
    const f = fixture(),
      before = f.grant.state_json;
    await expect(
      f.service.nativeControl(f.headers, "bad-selection", change(selection))
    ).rejects.toMatchObject({ code: "meeting_capture_invalid_input", httpStatus: 400 });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([
    { selection: systemOnly, patch: { systemAudioPermission: "denied" } },
    { selection: microphoneOnly, patch: { microphonePermission: "denied" } },
    {
      selection: systemOnly,
      patch: { computerAudio: { available: false, excludedProcessTreeIds: ["moss"] } }
    }
  ])("rejects unavailable or denied selected sources", async ({ selection, patch }) => {
    const f = fixture(),
      before = f.grant.state_json;
    f.connection.inventory_json = JSON.stringify({ ...inventory, ...patch });
    await expect(
      f.service.nativeControl(f.headers, "denied", change(selection))
    ).rejects.toMatchObject({ code: "meeting_capture_invalid_input" });
    expect(f.grant.state_json).toBe(before);
  });

  it("allows system-only capture when microphone access is denied and renders None", async () => {
    const f = fixture();
    f.connection.inventory_json = JSON.stringify({
      ...inventory,
      microphones: [],
      microphonePermission: "denied"
    });
    const result = await f.service.nativeControl(f.headers, "change", change());
    expect(result.capture.selection).toEqual(systemOnly);
    expect(stored(f).epochs[1]?.microphoneLabel).toBeNull();
    expect(choiceFromCapture(result.capture).microphoneId).toBe("");
  });

  it("rejects both-off and missing microphone fields without choosing a default", async () => {
    const f = fixture(),
      before = f.grant.state_json;
    for (const selection of [
      { mode: "microphone-only", microphone: null },
      { mode: "computer-audio", outputSourceId: "output", scope: systemOnly.scope }
    ]) {
      await expect(
        f.service.nativeControl(
          f.headers,
          "none",
          change(selection as unknown as MeetingCaptureSelection)
        )
      ).rejects.toMatchObject({ code: "meeting_capture_invalid_input" });
      expect(f.grant.state_json).toBe(before);
    }
  });

  it("does not grant browser controls native source-change permission", async () => {
    const f = fixture();
    await expect(
      f.service.browserControl(
        f.browser,
        meetingId,
        change() as unknown as MeetingCaptureControlInput
      )
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect(f.repository.grant).not.toHaveBeenCalled();
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it.each(["record", "pause", "stop"] as const)(
    "prohibits source fields on native %s",
    async (command) => {
      const f = fixture();
      await expect(
        f.service.nativeControl(f.headers, "hidden-selection", {
          ...change(),
          command
        } as unknown as MeetingCaptureNativeControlInput)
      ).rejects.toMatchObject({ httpStatus: 401 });
      expect(f.repository.grant).not.toHaveBeenCalled();
    }
  );

  it("lets Stop supersede stale source intent and never reopens capture", async () => {
    const f = fixture();
    await f.service.nativeControl(f.headers, "stop", {
      meetingId,
      ...command("stop", 1)
    } as MeetingCaptureNativeControlInput);
    const stopped = f.grant.state_json;
    f.grant.status = "finalizing";
    const lateFailure = await f.service.nativeControl(f.headers, "late-change", change()).then(
      () => null,
      (error: unknown) => error
    );
    expect(lateFailure).toBeInstanceOf(MeetingCaptureError);
    expect((lateFailure as MeetingCaptureError).code, "source-stop-finalization-conflict").toBe(
      "meeting_capture_conflict"
    );
    await expect(
      f.service.nativeControl(f.headers, "stopped-change", change(systemOnly, 2))
    ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
    expect(f.grant.state_json).toBe(stopped);
    expect(f.grant.status).toBe("finalizing");
  });
});

describe("source-change audio and gap boundaries", () => {
  it("admits exact new source and bounded old tails only after the current acknowledgment", () => {
    const value = recording();
    applyCaptureSourceChange(value, change(), at(2000));
    const next = {
      ...audio(),
      sourceId: "output",
      epoch: 2,
      generation: 2,
      startMs: 2000,
      endMs: 3000
    };
    expect(() => assertCaptureAudioAdmission(value, next, at(4000))).toThrow();
    expect(() => assertCaptureAudioAdmission(value, audio(), at(4000))).toThrow();
    value.observed = { generation: 2, phase: "recording" };
    expect(assertCaptureAudioAdmission(value, next, at(4000)).selection).toEqual(systemOnly);
    expect(assertCaptureAudioAdmission(value, audio(), at(4000)).epoch).toBe(1);
    for (const patch of [{ sourceId: "mic" }, { generation: 1 }, { startMs: 1999 }])
      expect(() => assertCaptureAudioAdmission(value, { ...next, ...patch }, at(4000))).toThrow();
    expect(() =>
      assertCaptureAudioAdmission(value, { ...audio(), endMs: 2001 }, at(4000))
    ).toThrow();
    const gap = {
      id: randomUUID(),
      sourceId: "mic",
      epoch: 1,
      startMs: 1000,
      endMs: 2000,
      reason: "interrupted" as const
    };
    retainCaptureGap(value, gap, at(4000));
    expect(() =>
      retainCaptureGap(value, { ...gap, id: randomUUID(), endMs: 2001 }, at(4000))
    ).toThrow();
    expect(() =>
      retainCaptureGap(
        value,
        { ...gap, id: randomUUID(), epoch: 2, startMs: 2000, endMs: 3000 },
        at(4000)
      )
    ).toThrow();
  });

  it("keeps the 64 epoch and gap exhaustion limits on source edits", () => {
    for (const kind of ["epochs", "gaps"]) {
      const value = recording();
      if (kind === "gaps") value.gapLimitReached = true;
      else
        value.epochs = Array.from({ length: 64 }, (_, index) => ({
          ...value.epochs[0]!,
          epoch: index + 1
        }));
      const before = structuredClone(value);
      expect(() =>
        applyCaptureSourceChange(value, change(systemOnly, 1, value.epochs.length), at(2000))
      ).toThrow(expect.objectContaining({ code: "meeting_capture_limit" }));
      expect(value).toEqual(before);
    }
  });

  it("keeps system-only lease expiry gaps on the selected output", () => {
    const value = recording(systemOnly);
    expireCaptureLease(value, at(32001));
    expect(value.desired).toBe("paused");
    expect(value.gaps.map((gap) => gap.sourceId)).toEqual(["output"]);
  });
});
