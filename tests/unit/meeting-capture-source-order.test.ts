import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureSelection, MeetingTranscriptLedger } from "@moss/shared";
import { applyMeetingTranscriptBatch } from "../../packages/meetings/src/transcript-batch.js";
import {
  selectMeetingTranscriptSnapshot,
  extendMeetingTranscriptSources
} from "../../packages/meetings/src/transcript.js";
import {
  applyCaptureSourceChange,
  applyCaptureControl
} from "../../packages/meetings/src/capture-domain.js";
import { captureTranscriptSources } from "../../packages/meetings/src/capture-transcript-sources.js";
import {
  at,
  audio,
  command,
  fixture,
  grantId,
  inventory,
  meetingId,
  owner,
  recording
} from "./helpers/meeting-capture-fixture.js";
const both: MeetingCaptureSelection = {
  mode: "computer-audio",
  microphone: { deviceId: "mic-device", sourceId: "mic" },
  outputSourceId: "output",
  scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
};
const systemOnly: MeetingCaptureSelection = { ...both, microphone: null };

function change() {
  return {
    meetingId,
    grantId,
    requestKey: randomUUID(),
    command: "change-sources" as const,
    expectedGeneration: 1,
    expectedEpoch: 1,
    selection: systemOnly
  };
}

describe("source epochs across reversed provider completions", () => {
  it("persists a first old source after the newer provider result without rewriting source identity", async () => {
    let now = at(2000);
    const f = fixture(both, () => now);
    const history: { ledger: MeetingTranscriptLedger | null; version: number } = {
      ledger: null,
      version: 0
    };
    vi.mocked(f.repository.transcriptHead).mockImplementation(async () => ({
      version: history.version,
      cursor: history.ledger?.cursor ?? 0,
      transcript_revision: history.ledger?.transcriptRevision ?? 0,
      stop_cutoff_ms: null
    }));
    vi.mocked(f.transcript.snapshotWithSources).mockImplementation(async () =>
      history.ledger
        ? {
            sources: history.ledger.sources,
            snapshot: selectMeetingTranscriptSnapshot(history.ledger, {
              meetingId,
              ownerUserId: owner,
              transcriptRevision: history.ledger.transcriptRevision,
              cutoffMs: 5000,
              maxSegments: 1,
              maxCharacters: 100
            })
          }
        : null
    );
    f.ingest.mockImplementation(async (_db, input) => {
      expect(input.expectedVersion).toBe(history.version);
      history.ledger = applyMeetingTranscriptBatch(history.ledger, owner, null, input);
      history.version += 1;
      return {
        status: "saved",
        replayed: false,
        receipt: {
          version: history.version,
          cursor: history.ledger.cursor,
          transcriptRevision: history.ledger.transcriptRevision,
          stopCutoffMs: null
        }
      };
    });
    const generated = {
      segments: [{ startMs: 0, endMs: 900, text: "First old source" }],
      modelRoute: "route"
    };
    let finishOld!: (value: typeof generated) => void;
    let started = false;
    vi.mocked(f.deps.transcribe).mockImplementationOnce(async (_actor, input) =>
      input.dispatch(() => {
        started = true;
        return new Promise<typeof generated>((resolve) => {
          finishOld = resolve;
        });
      })
    );
    const oldPending = f.service.audio(f.headers, "old-provider", audio());
    await vi.waitFor(() => expect(started).toBe(true));
    await f.service.nativeControl(f.headers, "change", change());
    await f.service.status(f.headers, "old-paused-status", {
      meetingId,
      grantId,
      inventory,
      observed: { generation: 1, phase: "paused" }
    });
    expect(JSON.parse(f.grant.state_json!).desired).toBe("recording");
    now = at(4000);
    await f.service.status(f.headers, "new-recording-status", {
      meetingId,
      grantId,
      inventory,
      observed: { generation: 2, phase: "recording" }
    });
    expect(
      await f.service.audio(f.headers, "new-provider", {
        ...audio(),
        sourceId: "output",
        epoch: 2,
        generation: 2,
        startMs: 2000,
        endMs: 3000
      })
    ).toMatchObject({ status: "saved" });
    finishOld(generated);
    expect(await oldPending).toMatchObject({ status: "saved" });
    expect(history.ledger?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ epoch: 1, sourceId: "mic", endMs: 2000 }),
        expect.objectContaining({ epoch: 1, sourceId: "output", endMs: 2000 }),
        expect.objectContaining({ epoch: 2, sourceId: "output", startMs: 2000, endMs: 3000 })
      ])
    );
    expect(history.ledger?.revisions.map((revision) => revision.segment.epoch)).toEqual([2, 1]);
    expect(() =>
      extendMeetingTranscriptSources(
        history.ledger!,
        history.ledger!.sources.map((source) => ({ ...source, label: "Rewritten" }))
      )
    ).toThrow();
  });

  it("omits zero-length paused selection epochs while retaining all earlier source identities", () => {
    const state = recording(both);
    applyCaptureControl(state, command("pause", 1), at(1000));
    applyCaptureSourceChange(state, { ...change(), expectedGeneration: 2 }, at(2000));
    applyCaptureControl(
      state,
      { ...command("record", 3), selection: systemOnly },
      at(3000),
      "route"
    );
    const sources = captureTranscriptSources(
      state,
      { ...audio(), generation: 4, epoch: 3, sourceId: "output", startMs: 3000, endMs: 4000 },
      []
    );
    expect(
      sources.map((source) => [source.epoch, source.sourceId, source.startMs, source.endMs])
    ).toEqual([
      [1, "mic", 0, 1000],
      [1, "output", 0, 1000],
      [3, "output", 3000, 4000]
    ]);
  });
});
