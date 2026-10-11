import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeetingCaptureSelection } from "@moss/shared";
import {
  applyCaptureSourceChange,
  assertCaptureAudioAdmission,
  type CaptureStoredState
} from "../../packages/meetings/src/capture-domain.js";
import {
  at,
  audio,
  fixture,
  grantId,
  inventory,
  meetingId,
  recording
} from "./helpers/meeting-capture-fixture.js";

const microphone: MeetingCaptureSelection = {
  mode: "microphone-only",
  microphone: { deviceId: "mic-device", sourceId: "mic" }
};
const system: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: microphone.microphone,
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
const selectedApp: MeetingCaptureSelection = {
  mode: "selected-app",
  microphone: microphone.microphone,
  outputSourceId: "output",
  appProcessTreeId: "selected-app"
};
const recover = (selection: MeetingCaptureSelection = microphone) => ({
  meetingId,
  grantId,
  requestKey: randomUUID(),
  expectedGeneration: 1,
  expectedEpoch: 1,
  command: "recover-sources" as const,
  selection
});
const stored = (f: ReturnType<typeof fixture>): CaptureStoredState =>
  JSON.parse(f.grant.state_json!) as CaptureStoredState;

describe("identical-source native recovery", () => {
  it.each([microphone, system, { ...system, microphone: null }, selectedApp])(
    "creates one immutable same-selection epoch for $mode without renewing authority or rerouting",
    async (selection) => {
      const f = fixture(selection),
        input = recover(selection);
      const original = stored(f),
        authority = { ...f.grant, state_json: undefined };
      f.connection.inventory_json = JSON.stringify({
        ...inventory,
        microphones: [{ ...inventory.microphones[0]!, label: "Current label" }]
      });
      const result = await f.service.nativeControl(f.headers, "recover", input);
      expect(result.capture).toMatchObject({
        generation: 2,
        epoch: 2,
        desired: "recording",
        selection,
        epochStartMs: 2000,
        epochEndMs: null,
        observed: original.observed
      });
      expect(stored(f).epochs[0]).toEqual({ ...original.epochs[0]!, endMs: 2000 });
      expect(stored(f).epochs[1]).toMatchObject({ modelRoute: "route", selection });
      expect(stored(f).originAt).toBe(original.originAt);
      expect(stored(f).lastSeenAt).toBe(original.lastSeenAt);
      expect({ ...f.grant, state_json: undefined }).toEqual(authority);
      expect(f.preferences.get).not.toHaveBeenCalled();
      expect(f.deps.processingAvailability).not.toHaveBeenCalled();
      expect(await f.service.nativeControl(f.headers, "replay", input)).toEqual(result);
      expect(stored(f).epochs).toHaveLength(2);
      expect(f.repository.reserve).toHaveBeenCalledTimes(1);
    }
  );

  it("accepts JSON field ordering but not source identity or exclusion changes", async () => {
    const f = fixture(system);
    const reordered = {
      scope: { excludedProcessTreeIds: ["moss"], kind: "process-exclusion" as const },
      outputSourceId: "output",
      microphone: { sourceId: "mic", deviceId: "mic-device" },
      mode: "computer-audio" as const
    };
    expect(
      (await f.service.nativeControl(f.headers, "ordered", recover(reordered))).capture.epoch
    ).toBe(2);
  });

  it.each<MeetingCaptureSelection>([
    microphone,
    { ...system, microphone: null },
    { ...system, outputSourceId: "other-output" },
    { ...system, microphone: { deviceId: "other-mic", sourceId: "other-source" } },
    { ...system, scope: { kind: "process-exclusion", excludedProcessTreeIds: ["other"] } },
    selectedApp
  ])("refuses recovery that changes the authorized selection: %j", async (selection) => {
    const f = fixture(system),
      before = f.grant.state_json;
    // Every proposed choice is currently available. Recovery must still keep the old choice.
    f.connection.inventory_json = JSON.stringify({
      ...inventory,
      microphones: [
        ...inventory.microphones,
        {
          deviceId: "other-mic",
          sourceId: "other-source",
          label: "Other microphone"
        }
      ],
      computerAudio: {
        available: true,
        excludedProcessTreeIds:
          selection.mode === "computer-audio" && selection.scope.kind === "process-exclusion"
            ? selection.scope.excludedProcessTreeIds
            : ["moss"]
      }
    });
    await expect(
      f.service.nativeControl(f.headers, "scope", recover(selection))
    ).rejects.toMatchObject({ code: "meeting_capture_invalid_input", httpStatus: 400 });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.reserve).not.toHaveBeenCalled();
  });

  it.each([
    { microphonePermission: "denied" },
    { systemAudioPermission: "denied" },
    { microphones: [] },
    { computerAudio: { available: false, excludedProcessTreeIds: ["moss"] } },
    { computerAudio: { available: true, excludedProcessTreeIds: ["replacement"] } }
  ])("checks the unchanged selection against current source availability: %j", async (patch) => {
    const f = fixture(system),
      before = f.grant.state_json;
    f.connection.inventory_json = JSON.stringify({ ...inventory, ...patch });
    await expect(
      f.service.nativeControl(f.headers, "source-unavailable", recover(system))
    ).rejects.toMatchObject({ code: "meeting_capture_invalid_input" });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.reserve).not.toHaveBeenCalled();
  });

  it.each(["idle", "paused", "stopped", "revoked"] as const)(
    "cannot supply Record or Resume intent while %s",
    async (desired) => {
      const f = fixture(),
        state = stored(f);
      state.desired = desired;
      f.grant.state_json = JSON.stringify(state);
      const before = f.grant.state_json;
      await expect(
        f.service.nativeControl(f.headers, "not-recording", recover())
      ).rejects.toMatchObject({ code: "meeting_capture_invalid_input" });
      expect(f.grant.state_json).toBe(before);
      expect(f.repository.reserve).not.toHaveBeenCalled();
    }
  );

  it.each(["approved", "finalizing", "complete"] as const)(
    "requires an active claimed grant rather than %s",
    async (status) => {
      const f = fixture();
      f.grant.status = status;
      await expect(
        f.service.nativeControl(f.headers, "inactive-grant", recover())
      ).rejects.toThrow();
      expect(stored(f).epochs).toHaveLength(1);
      expect(f.repository.reserve).not.toHaveBeenCalled();
    }
  );

  it.each([{ expectedGeneration: 2 }, { expectedEpoch: 2 }])(
    "rejects stale recovery counters: %j",
    async (patch) => {
      const f = fixture(),
        before = f.grant.state_json;
      await expect(
        f.service.nativeControl(f.headers, "stale", { ...recover(), ...patch })
      ).rejects.toMatchObject({ code: "meeting_capture_conflict", httpStatus: 409 });
      expect(f.grant.state_json).toBe(before);
      expect(f.repository.reserve).not.toHaveBeenCalled();
    }
  );

  it("never reopens a closed epoch even if its desired state is inconsistent", () => {
    const state = recording();
    state.epochs[0]!.endMs = 1000;
    const before = structuredClone(state);
    expect(() => applyCaptureSourceChange(state, recover(), at(2000))).toThrow(
      expect.objectContaining({ code: "meeting_capture_invalid_input" })
    );
    expect(state).toEqual(before);
  });

  it.each(["epochs", "gaps", "lease"])("preserves the %s bound", (bound) => {
    const state = recording();
    if (bound === "epochs")
      state.epochs = Array.from({ length: 64 }, (_, index) => ({
        ...state.epochs[0]!,
        epoch: index + 1
      }));
    if (bound === "gaps") state.gapLimitReached = true;
    const before = structuredClone(state);
    expect(() =>
      applyCaptureSourceChange(
        state,
        {
          ...recover(),
          expectedEpoch: state.epochs.length
        },
        at(bound === "lease" ? 32001 : 2000)
      )
    ).toThrow(
      expect.objectContaining({
        code: bound === "lease" ? "meeting_capture_interrupted" : "meeting_capture_limit"
      })
    );
    expect(state).toEqual(before);
  });

  it("replays the accepted request after Pause without resuming or appending an epoch", async () => {
    const f = fixture(),
      input = recover();
    await f.service.nativeControl(f.headers, "recover", input);
    await f.service.nativeControl(f.headers, "pause", {
      meetingId,
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "pause"
    });
    const before = f.grant.state_json;
    expect((await f.service.nativeControl(f.headers, "late-replay", input)).capture).toMatchObject({
      desired: "paused",
      generation: 3,
      epoch: 2
    });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.reserve).toHaveBeenCalledTimes(2);
    await expect(
      f.service.nativeControl(f.headers, "late-new-request", {
        ...input,
        requestKey: randomUUID(),
        expectedGeneration: 3,
        expectedEpoch: 2
      })
    ).rejects.toMatchObject({ code: "meeting_capture_invalid_input" });
  });

  it.each([
    { command: "change-sources" as const },
    { expectedEpoch: 2 },
    { expectedGeneration: 2 },
    { selection: system }
  ])("binds a recovery receipt to the exact command, counters and selection: %j", async (patch) => {
    const f = fixture(),
      input = recover();
    await f.service.nativeControl(f.headers, "recover", input);
    const before = f.grant.state_json;
    await expect(
      f.service.nativeControl(f.headers, "changed-retry", { ...input, ...patch })
    ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.reserve).toHaveBeenCalledTimes(1);
  });

  it("reports recovery without auto-pausing and requires the replacement recording acknowledgment", async () => {
    let now = at(2000);
    const f = fixture(undefined, () => now);
    const status = (generation: number, phase: "recovering" | "recording") =>
      f.service.status(f.headers, "status", {
        meetingId,
        grantId,
        inventory,
        observed: { generation, phase }
      });
    expect((await status(1, "recovering")).capture).toMatchObject({
      desired: "recording",
      generation: 1,
      observed: { phase: "recovering" }
    });
    expect(() => assertCaptureAudioAdmission(stored(f), audio(), now)).toThrow();
    await f.service.nativeControl(f.headers, "recover", recover());
    now = at(4000);
    const next = { ...audio(), epoch: 2, generation: 2, startMs: 2000, endMs: 3000 };
    expect(() => assertCaptureAudioAdmission(stored(f), next, now)).toThrow();
    expect((await status(2, "recovering")).capture).toMatchObject({
      desired: "recording",
      generation: 2,
      observed: { phase: "recovering" }
    });
    expect(() => assertCaptureAudioAdmission(stored(f), next, now)).toThrow();
    await status(1, "recording");
    expect(stored(f).observed).toEqual({ generation: 2, phase: "recovering" });
    expect(() => assertCaptureAudioAdmission(stored(f), next, now)).toThrow();
    await status(2, "recording");
    expect(assertCaptureAudioAdmission(stored(f), next, now).epoch).toBe(2);
    expect(assertCaptureAudioAdmission(stored(f), audio(), now).epoch).toBe(1);
    expect(() =>
      assertCaptureAudioAdmission(stored(f), { ...audio(), endMs: 2001 }, now)
    ).toThrow();
  });
});
