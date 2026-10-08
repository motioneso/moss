import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCaptureControl,
  applyCaptureSourceChange,
  type CaptureStoredState
} from "../../packages/meetings/src/capture-domain.js";
import {
  at,
  command,
  fixture,
  grantId,
  inventory,
  meetingId,
  recording
} from "./helpers/meeting-capture-fixture.js";

const stored = (f: ReturnType<typeof fixture>): CaptureStoredState =>
  JSON.parse(f.grant.state_json!) as CaptureStoredState;
const recover = (state: CaptureStoredState) => ({
  meetingId,
  grantId,
  requestKey: randomUUID(),
  command: "recover-sources" as const,
  expectedGeneration: state.generation,
  expectedEpoch: state.epochs.at(-1)!.epoch,
  selection: state.epochs.at(-1)!.selection
});

describe("recording-wide automatic recovery limits", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, Number.NaN])(
    "rejects a malformed persisted recovery count without changing state: %j",
    (automaticRecoveryCount) => {
      const state = Object.assign(recording(), { automaticRecoveryCount });
      const before = structuredClone(state);
      expect(() => applyCaptureSourceChange(state, recover(state), at(2000))).toThrow(
        expect.objectContaining({ code: "meeting_capture_invalid_input", httpStatus: 400 })
      );
      expect(state).toEqual(before);
    }
  );

  it("caps repeated healthy recoveries at eight and does not charge stable request replays", async () => {
    let now = at(2000);
    const f = fixture(undefined, () => now);
    for (let count = 1; count <= 8; count++) {
      const input = recover(stored(f));
      const accepted = await f.service.nativeControl(f.headers, "recover", input);
      expect(await f.service.nativeControl(f.headers, "replay", input)).toEqual(accepted);
      expect(stored(f).automaticRecoveryCount).toBe(count);
      expect(stored(f).epochs).toHaveLength(count + 1);
      // More than the native healthy-audio reset window must not renew the server budget.
      now = new Date(now.getTime() + 3000);
      await f.service.status(f.headers, "healthy-recording", {
        meetingId,
        grantId,
        inventory,
        observed: { generation: accepted.capture.generation, phase: "recording" }
      });
    }
    const before = f.grant.state_json;
    await expect(
      f.service.nativeControl(f.headers, "ninth-recovery", recover(stored(f)))
    ).rejects.toMatchObject({ code: "meeting_capture_limit", httpStatus: 413 });
    expect(f.grant.state_json).toBe(before);
    expect(f.repository.reserve).toHaveBeenCalledTimes(8);
  });

  it("preserves the recovery cap through explicit Pause, Resume and source edits", async () => {
    const f = fixture();
    for (let count = 0; count < 8; count++)
      await f.service.nativeControl(f.headers, "recover", recover(stored(f)));
    const control = async (intent: "pause" | "record") =>
      f.service.nativeControl(f.headers, intent, {
        meetingId,
        grantId,
        requestKey: randomUUID(),
        command: intent,
        expectedGeneration: stored(f).generation
      });
    await control("pause");
    expect((await control("record")).capture).toMatchObject({ desired: "recording", epoch: 10 });
    const sourceChange = { ...recover(stored(f)), command: "change-sources" as const };
    expect(
      (await f.service.nativeControl(f.headers, "manual-edit", sourceChange)).capture.epoch
    ).toBe(11);
    expect(stored(f).automaticRecoveryCount).toBe(8);
    const before = f.grant.state_json;
    await expect(
      f.service.nativeControl(f.headers, "still-capped", recover(stored(f)))
    ).rejects.toMatchObject({ code: "meeting_capture_limit" });
    expect(f.grant.state_json).toBe(before);
    const fresh = fixture();
    await fresh.service.nativeControl(fresh.headers, "fresh-grant", recover(stored(fresh)));
    expect(stored(fresh).automaticRecoveryCount).toBe(1);
  });

  it("reserves the last eight epochs for manual controls even on legacy state", () => {
    const state = recording();
    expect(state.automaticRecoveryCount).toBeUndefined();
    for (let count = 1; count < 55; count++)
      applyCaptureSourceChange(state, { ...recover(state), command: "change-sources" }, at(2000));
    applyCaptureSourceChange(state, recover(state), at(2000));
    expect(state.epochs).toHaveLength(56);
    expect(state.automaticRecoveryCount).toBe(1);
    const before = structuredClone(state);
    expect(() => applyCaptureSourceChange(state, recover(state), at(2000))).toThrow(
      expect.objectContaining({ code: "meeting_capture_limit", httpStatus: 413 })
    );
    expect(state).toEqual(before);
    for (let count = 0; count < 8; count++) {
      applyCaptureControl(state, command("pause", state.generation), at(2000));
      applyCaptureControl(state, command("record", state.generation), at(2000), "route");
    }
    expect(state.epochs).toHaveLength(64);
    expect(state.automaticRecoveryCount).toBe(1);
    applyCaptureControl(state, command("pause", state.generation), at(2000));
    const full = structuredClone(state);
    expect(() =>
      applyCaptureControl(state, command("record", state.generation), at(2000), "route")
    ).toThrow(expect.objectContaining({ code: "meeting_capture_limit" }));
    expect(state).toEqual(full);
  });
});
