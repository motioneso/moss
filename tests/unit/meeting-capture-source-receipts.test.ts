import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureSelection } from "@moss/shared";
import {
  addRecording,
  at,
  audio,
  fixture,
  grantId,
  inventory,
  meetingId
} from "./helpers/meeting-capture-fixture.js";

const selection: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: null,
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
const change = (requestKey = randomUUID(), expectedGeneration = 1) => ({
  meetingId,
  grantId,
  requestKey,
  command: "change-sources" as const,
  expectedGeneration,
  expectedEpoch: 1,
  selection
});

function clearMutationCalls(f: ReturnType<typeof fixture>) {
  vi.mocked(f.repository.save).mockClear();
  vi.mocked(f.repository.reserve).mockClear();
  vi.mocked(f.repository.admitAudio).mockClear();
  vi.mocked(f.deps.transcribe).mockClear();
  f.ingest.mockClear();
}

function expectNoMutation(f: ReturnType<typeof fixture>, before: string | null) {
  expect(f.grant.state_json).toBe(before);
  expect(f.repository.save).not.toHaveBeenCalled();
  expect(f.repository.reserve).not.toHaveBeenCalled();
  expect(f.repository.admitAudio).not.toHaveBeenCalled();
  expect(f.deps.transcribe).not.toHaveBeenCalled();
  expect(f.ingest).not.toHaveBeenCalled();
}

describe("source-change receipt identity", () => {
  it.each(["pause", "audio"] as const)(
    "rejects a source change reusing a successful %s request UUID before mutation",
    async (kind) => {
      const f = fixture();
      const requestKey = randomUUID();
      if (kind === "pause") {
        await f.service.nativeControl(f.headers, "original-control", {
          meetingId,
          grantId,
          requestKey,
          command: "pause",
          expectedGeneration: 1
        });
      } else {
        expect(
          await f.service.audio(f.headers, "original-audio", { ...audio(), requestKey })
        ).toMatchObject({ status: "saved" });
      }
      const before = f.grant.state_json;
      const receipt = JSON.stringify(f.receipts.get(requestKey));
      clearMutationCalls(f);
      await expect(
        f.service.nativeControl(
          f.headers,
          "source-key-collision",
          change(requestKey, kind === "pause" ? 2 : 1)
        )
      ).rejects.toMatchObject({ code: "meeting_capture_conflict", httpStatus: 409 });
      expectNoMutation(f, before);
      expect(JSON.stringify(f.receipts.get(requestKey))).toBe(receipt);
      expect(f.receipts.size).toBe(1);
    }
  );

  it.each(["pause", "stop", "record", "audio"] as const)(
    "rejects %s reusing a source-change request UUID before mutation or dispatch",
    async (kind) => {
      let now = at(2000);
      const f = fixture(undefined, () => now);
      if (kind === "record") {
        await f.service.nativeControl(f.headers, "initial-pause", {
          meetingId,
          grantId,
          requestKey: randomUUID(),
          command: "pause",
          expectedGeneration: 1
        });
      }
      const input = change(randomUUID(), kind === "record" ? 2 : 1);
      const accepted = await f.service.nativeControl(f.headers, "original-source", input);
      if (kind === "audio") {
        now = at(4000);
        await f.service.status(f.headers, "acknowledge-source", {
          meetingId,
          grantId,
          inventory,
          observed: { generation: accepted.capture.generation, phase: "recording" }
        });
      }
      const before = f.grant.state_json;
      const receipts = JSON.stringify([...f.receipts]);
      clearMutationCalls(f);
      const request =
        kind === "audio"
          ? f.service.audio(f.headers, "audio-key-collision", {
              ...audio(),
              requestKey: input.requestKey,
              generation: accepted.capture.generation,
              epoch: accepted.capture.epoch,
              sourceId: "output",
              startMs: 2000,
              endMs: 3000
            })
          : f.service.nativeControl(f.headers, "control-key-collision", {
              meetingId,
              grantId,
              requestKey: input.requestKey,
              command: kind,
              expectedGeneration: accepted.capture.generation
            });
      await expect(request).rejects.toMatchObject({
        code: "meeting_capture_conflict",
        httpStatus: 409
      });
      expectNoMutation(f, before);
      expect(JSON.stringify([...f.receipts])).toBe(receipts);
    }
  );

  it("scopes the same source-change request UUID to each authenticated recording grant", async () => {
    const f = fixture();
    const other = addRecording(f);
    const input = change();
    const otherInput = { ...input, meetingId: other.grant.meeting_id, grantId: other.grant.id };
    const first = await f.service.nativeControl(f.headers, "first-grant", input);
    const second = await f.service.nativeControl(other.headers, "other-grant", otherInput);
    expect(first.capture).toMatchObject({ grantId, epoch: 2, generation: 2 });
    expect(second.capture).toMatchObject({ grantId: other.grant.id, epoch: 2, generation: 2 });
    expect(f.receipts.size).toBe(1);
    expect(f.receiptsFor(other.grant.id).size).toBe(1);
    expect(f.receipts.get(input.requestKey)?.fingerprint).not.toBe(
      f.receiptsFor(other.grant.id).get(input.requestKey)?.fingerprint
    );
    expect(await f.service.nativeControl(f.headers, "first-replay", input)).toEqual(first);
    expect(await f.service.nativeControl(other.headers, "other-replay", otherInput)).toEqual(
      second
    );
    expect(f.repository.save).toHaveBeenCalledTimes(2);
    expect(f.repository.reserve).toHaveBeenCalledTimes(2);
  });
});
