import { describe, expect, it, vi } from "vitest";
import { captureView } from "../../packages/meetings/src/capture-repository.js";
import { applyMeetingTranscriptBatch } from "../../packages/meetings/src/transcript-batch.js";
import { audio, at, fixture, owner } from "./helpers/meeting-capture-fixture.js";

function pcm(amplitude: number, durationMs = 1000, burstMs = durationMs) {
  const bytes = Buffer.alloc(durationMs * 32);
  for (let offset = 0; offset < burstMs * 32; offset += 2)
    bytes.writeInt16LE((offset % 4 === 0 ? 1 : -1) * amplitude, offset);
  return bytes.toString("base64");
}

describe("meeting capture near-silence", () => {
  it.each([0, 1, 32])(
    "acknowledges output at peak %i without sending it to a provider",
    async (peak) => {
      const f = fixture({
        mode: "computer-audio",
        microphone: { deviceId: "mic-device", sourceId: "mic" },
        outputSourceId: "output",
        scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
      });
      const input = { ...audio(), sourceId: "output", pcmBase64: pcm(peak) };
      expect(await f.service.audio(f.headers, "silent-output", input)).toMatchObject({
        status: "saved"
      });
      expect(f.deps.transcribe).not.toHaveBeenCalled();
      expect(f.ingest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          events: [],
          sources: expect.arrayContaining([
            expect.objectContaining({ sourceId: "output", epoch: 1, startMs: 0, endMs: 1000 })
          ])
        })
      );
      expect(JSON.parse(f.grant.state_json!).gaps).toEqual([]);
      expect(await f.service.audio(f.headers, "silent-replay", input)).toMatchObject({
        status: "saved",
        replayed: true
      });
      expect(f.ingest).toHaveBeenCalledTimes(1);
      await expect(
        f.service.audio(f.headers, "changed-replay", { ...input, pcmBase64: pcm(peak + 1) })
      ).rejects.toThrow();
    }
  );

  it.each([false, true])(
    "clears stale microphone delay but retains pending other audio=%s",
    async (pending) => {
      const f = fixture();
      const state = JSON.parse(f.grant.state_json!);
      state.processing = {
        status: "delayed",
        reason: "transport",
        stage: "dispatch",
        retryable: true
      };
      f.grant.state_json = JSON.stringify(state);
      const input = { ...audio(), pcmBase64: pcm(0) };
      vi.mocked(f.repository.hasPendingAudio).mockImplementation(async () => {
        expect(JSON.parse(f.receipts.get(input.requestKey)!.result_json!).status).toBe("saved");
        return pending;
      });
      await f.service.audio(f.headers, "silent-mic", input);
      expect(f.deps.transcribe).not.toHaveBeenCalled();
      expect(f.ingest.mock.calls[0]![1].events).toEqual([]);
      expect(JSON.parse(f.grant.state_json!).processing).toEqual(
        pending ? state.processing : { status: "ready" }
      );
    }
  );

  it.each([33, -33, 64])(
    "keeps a short quiet signal at peak %i inside ten seconds of silence, including 'you'",
    async (peak) => {
      const f = fixture(undefined, () => at(11000));
      const state = JSON.parse(f.grant.state_json!);
      state.lastSeenAt = at(11000).toISOString();
      f.grant.state_json = JSON.stringify(state);
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) =>
        input.dispatch(async () => ({
          segments: [{ startMs: 0, endMs: 100, text: "you" }],
          modelRoute: "route"
        }))
      );
      await f.service.audio(f.headers, "quiet-speech", {
        ...audio(),
        endMs: 10000,
        pcmBase64: pcm(peak, 10000, 100)
      });
      expect(f.deps.transcribe).toHaveBeenCalledTimes(1);
      expect(f.ingest.mock.calls[0]![1].events[0]!.segment).toMatchObject({
        sourceId: "mic",
        epoch: 1,
        startMs: 0,
        endMs: 100,
        text: "you"
      });
    }
  );

  it.each([{ generation: 2 }, { epoch: 2 }, { sourceId: "unselected" }])(
    "rejects unauthorized silent chunk %j",
    async (change) => {
      const f = fixture();
      await expect(
        f.service.audio(f.headers, "invalid-silence", { ...audio(), pcmBase64: pcm(0), ...change })
      ).rejects.toThrow();
      expect(f.deps.transcribe).not.toHaveBeenCalled();
      expect(f.ingest).not.toHaveBeenCalled();
    }
  );
  it.each([2, 3])(
    "rechecks revoked binding at silent admission/persistence lock %i",
    async (targetLock) => {
      const f = fixture();
      let locks = 0;
      let revoked = false;
      vi.mocked(f.repository.lockMeeting).mockImplementation(async () => {
        if (++locks === targetLock) revoked = true;
      });
      vi.mocked(f.deps.assertBinding).mockImplementation(async () => {
        if (revoked) throw Object.assign(new Error("revoked"), { httpStatus: 403 });
      });
      await expect(
        f.service.audio(f.headers, "revoked-silence", { ...audio(), pcmBase64: pcm(0) })
      ).rejects.toThrow();
      expect(f.deps.transcribe).not.toHaveBeenCalled();
      expect(f.ingest).not.toHaveBeenCalled();
    }
  );

  it("keeps silent final flush inside the stop boundary and rejects later samples", async () => {
    const f = fixture();
    const state = JSON.parse(f.grant.state_json!);
    state.processing = {
      status: "delayed",
      reason: "provider-network",
      stage: "dispatch",
      retryable: false
    };
    state.desired = "stopped";
    state.generation = 2;
    state.observed = { generation: 2, phase: "stopped" };
    state.stopCutoffMs = 1000;
    state.epochs[0].endMs = 1000;
    state.finalizationDeadline = at(60000).toISOString();
    f.grant.state_json = JSON.stringify(state);
    expect(
      await f.service.audio(f.headers, "silent-final-flush", { ...audio(), pcmBase64: pcm(0) })
    ).toMatchObject({ status: "saved" });
    expect(f.ingest.mock.calls[0]![1]).toMatchObject({ events: [], stopCutoffMs: 1000 });
    expect(JSON.parse(f.grant.state_json!).processing).toEqual({ status: "ready" });
    await expect(
      f.service.audio(f.headers, "past-stop", {
        ...audio(),
        startMs: 1,
        endMs: 1001,
        sequence: 1,
        pcmBase64: pcm(0)
      })
    ).rejects.toThrow();
    expect(f.deps.transcribe).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "retries silent persistence and clears settled speech warning=%s",
    async (delayed) => {
      const f = fixture();
      const state = JSON.parse(f.grant.state_json!);
      const initialProcessing = delayed
        ? {
            status: "delayed",
            reason: "transcript-persistence",
            stage: "persistence",
            retryable: true
          }
        : { status: "ready" };
      state.processing = initialProcessing;
      f.grant.state_json = JSON.stringify(state);
      const input = { ...audio(), pcmBase64: pcm(0) };
      f.ingest.mockRejectedValueOnce(new Error("temporary persistence failure"));
      vi.spyOn(f.repository, "retry").mockImplementation(async (_db, _grant, receipt) => {
        receipt.result_json = null;
        receipt.attempts = (receipt.attempts ?? 1) + 1;
        return true;
      });
      expect(await f.service.audio(f.headers, "silent-failure", input)).toMatchObject({
        status: "failed",
        retryable: true
      });
      expect(JSON.parse(f.grant.state_json!).processing).toEqual(initialProcessing);
      expect(await f.service.audio(f.headers, "silent-recovery", input)).toMatchObject({
        status: "saved"
      });
      expect(JSON.parse(f.grant.state_json!).processing).toEqual({ status: "ready" });
      expect(f.deps.transcribe).not.toHaveBeenCalled();
    }
  );

  it("acknowledges silence without advancing the real transcript ledger cursor or revision", async () => {
    const f = fixture();
    f.ingest.mockImplementation(async (_db, input) => {
      const ledger = applyMeetingTranscriptBatch(null, owner, null, input);
      expect(ledger.cursor).toBe(0);
      expect(ledger.transcriptRevision).toBe(0);
      return {
        status: "saved",
        replayed: false,
        receipt: {
          version: 1,
          cursor: ledger.cursor,
          transcriptRevision: ledger.transcriptRevision,
          stopCutoffMs: null
        }
      };
    });
    const input = { ...audio(), pcmBase64: pcm(0) };
    expect(await f.service.audio(f.headers, "silent-ledger", input)).toMatchObject({
      status: "saved",
      transcriptRevision: 0
    });
    expect(f.repository.admitAudio).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      input,
      expect.any(String)
    );
    expect(JSON.parse(f.receipts.get(input.requestKey)!.result_json!)).toMatchObject({
      status: "saved",
      transcriptRevision: 0
    });
  });
  it("retains the terminal failure receipt and visible gap if silent persistence cannot recover", async () => {
    const f = fixture();
    const input = { ...audio(), pcmBase64: pcm(0) };
    f.ingest.mockRejectedValue(new Error("persistence unavailable"));
    vi.spyOn(f.repository, "retry").mockImplementation(async (_db, _grant, receipt) => {
      receipt.result_json = null;
      receipt.attempts = (receipt.attempts ?? 1) + 1;
      return true;
    });
    await f.service.audio(f.headers, "silent-retryable", input);
    f.receipts.get(input.requestKey)!.attempts = 3;
    expect(await f.service.audio(f.headers, "silent-terminal", input)).toMatchObject({
      status: "failed",
      retryable: false
    });
    expect(JSON.parse(f.grant.state_json!).gaps).toEqual([
      expect.objectContaining({
        id: input.requestKey,
        sourceId: "mic",
        epoch: 1,
        startMs: 0,
        endMs: 1000,
        reason: "processing-failed"
      })
    ]);
    expect(JSON.parse(f.receipts.get(input.requestKey)!.result_json!)).toMatchObject({
      status: "failed",
      retryable: false
    });
    expect(f.deps.transcribe).not.toHaveBeenCalled();
  });
  it.each(["pending", "acknowledged", "deadline", "complete-grant"] as const)(
    "shows delay only while Stop finalization remains pending: %s",
    (completion) => {
      const f = fixture();
      const state = JSON.parse(f.grant.state_json!);
      state.desired = "stopped";
      state.stopCutoffMs = 1000;
      state.finalizationDeadline = at(completion === "deadline" ? 2000 : 60000).toISOString();
      state.finalized = completion === "acknowledged";
      if (completion === "complete-grant") f.grant.status = "complete";
      state.processing = {
        status: "delayed",
        reason: "provider-network",
        stage: "dispatch",
        retryable: false
      };
      state.gaps = [
        {
          id: "failed-clip",
          sourceId: "mic",
          epoch: 1,
          startMs: 0,
          endMs: 1000,
          reason: "processing-failed"
        }
      ];
      const view = captureView(f.grant, state, at(2000));
      expect(view.finalization).toBe(completion === "pending" ? "pending" : "complete");
      expect(view.processing?.status).toBe(completion === "pending" ? "delayed" : "ready");
      expect(view.gaps).toEqual(state.gaps);
    }
  );
});
