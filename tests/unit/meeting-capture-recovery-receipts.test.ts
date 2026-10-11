import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MeetingCaptureRepository,
  type CaptureReceipt
} from "../../packages/meetings/src/capture-repository.js";
import {
  applyCaptureControl,
  applyCaptureSourceChange
} from "../../packages/meetings/src/capture-domain.js";
import {
  at,
  audio,
  command,
  fixture,
  grantId,
  meetingId,
  recording
} from "./helpers/meeting-capture-fixture.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

// The recording DB compiles the real SQL without opening a database. The isolated integration
// suite additionally proves cross-epoch admission against real receipt rows and transactions.
describe("old-epoch audio retirement", () => {
  it.each(["recovery", "resume"])(
    "settles an expired old receipt as one gap without pausing the %s epoch",
    async (kind) => {
      const state = recording(),
        clip = audio(),
        f = fixture();
      if (kind === "resume") {
        applyCaptureControl(state, command("pause", 1), at(2000));
        state.lastSeenAt = at(63000).toISOString();
        applyCaptureControl(state, command("record", 2), at(63000), "route");
      } else {
        applyCaptureSourceChange(
          state,
          {
            meetingId,
            grantId,
            requestKey: randomUUID(),
            command: "recover-sources",
            expectedGeneration: 1,
            expectedEpoch: 1,
            selection: state.epochs[0]!.selection
          },
          at(2000)
        );
        state.lastSeenAt = at(63000).toISOString();
      }
      state.observed = { generation: state.generation, phase: "recording" };
      const current = structuredClone(state.epochs.at(-1)),
        generation = state.generation;
      const expired: CaptureReceipt = {
        request_key: clip.requestKey,
        kind: "audio",
        fingerprint: "unchanged-fingerprint",
        metadata_json: JSON.stringify({
          sourceId: clip.sourceId,
          epoch: clip.epoch,
          generation: clip.generation,
          sequence: clip.sequence,
          startMs: clip.startMs,
          endMs: clip.endMs
        }),
        result_json: null,
        created_at: at(2000)
      };
      const { scoped, queries } = makeRecordingDb({ rows: [{ ...expired }] });
      const repository = new MeetingCaptureRepository();
      await repository.reconcileExpiredAudio(scoped, f.grant, state, at(63000));
      await repository.reconcileExpiredAudio(scoped, f.grant, state, at(64000));
      expect(state).toMatchObject({
        desired: "recording",
        generation,
        observed: { generation, phase: "recording" },
        gaps: [
          {
            id: clip.requestKey,
            sourceId: "mic",
            epoch: 1,
            startMs: 0,
            endMs: 1000,
            reason: "interrupted"
          }
        ]
      });
      expect(state.epochs.at(-1)).toEqual(current);
      expect(JSON.parse(expired.metadata_json)).toMatchObject({
        epoch: 1,
        generation: 1,
        sequence: 0
      });
      expect(expired.fingerprint).toBe("unchanged-fingerprint");
      const terminal = queries.filter((query) => query.sql.includes("SET result_json="));
      expect(terminal).toHaveLength(2);
      expect(JSON.parse(String(terminal[0]!.parameters[0]))).toMatchObject({
        requestKey: clip.requestKey,
        status: "failed",
        reason: "audio-expired",
        retryable: false
      });
    }
  );

  it("checks source pending work across all epochs while ordering each epoch separately", async () => {
    const clip = { ...audio(), epoch: 2, generation: 2, sequence: 0, startMs: 2000, endMs: 3000 };
    const f = fixture(),
      repository = new MeetingCaptureRepository();
    const { scoped, queries } = makeRecordingDb();
    await repository.admitAudio(scoped, f.grant, clip, "fingerprint");
    const pending = queries.find((query) =>
      query.sql.startsWith("SELECT 1 FROM app.meeting_capture_receipts")
    )!;
    expect(pending.sql).toContain("metadata_json::jsonb->>'sourceId'");
    expect(pending.sql).not.toContain("epoch");
    expect(pending.parameters).toEqual([grantId, "mic"]);
    const sequence = queries.find((query) => query.sql.includes("AS sequence"))!;
    expect(sequence.sql).toContain("metadata_json::jsonb->>'epoch'");
    expect(sequence.parameters).toEqual([grantId, "mic", 2]);
    const retryDb = makeRecordingDb();
    await repository.retry(
      retryDb.scoped,
      grantId,
      {
        request_key: clip.requestKey,
        kind: "audio",
        fingerprint: "fingerprint",
        metadata_json: JSON.stringify({ sourceId: "mic", epoch: 1 }),
        result_json: JSON.stringify({ retryable: true }),
        created_at: at(2000)
      },
      at(3000)
    );
    expect(retryDb.queries.find((query) => query.sql.includes("LIMIT 1"))!.sql).not.toContain(
      "epoch"
    );
  });

  it("reconciles pending old audio before admitting a delayed Resume", async () => {
    const f = fixture(undefined, () => at(63000));
    const state = recording();
    applyCaptureControl(state, command("pause", 1), at(2000));
    state.lastSeenAt = at(63000).toISOString();
    f.connection.last_seen_at = at(63000);
    f.grant.state_json = JSON.stringify(state);
    const clip = audio();
    const expired: CaptureReceipt = {
      request_key: clip.requestKey,
      kind: "audio",
      fingerprint: "original",
      metadata_json: JSON.stringify({ sourceId: "mic", epoch: 1, startMs: 0, endMs: 1000 }),
      result_json: null,
      created_at: at(2000)
    };
    const { scoped } = makeRecordingDb({ rows: [{ ...expired }] });
    const repository = new MeetingCaptureRepository();
    const finish = vi.spyOn(repository, "finish");
    vi.mocked(f.repository.reconcileExpiredAudio).mockImplementation(
      async (_db, grant, next, now) => {
        expect(next.desired).toBe("paused");
        expect(next.epochs).toHaveLength(1);
        await repository.reconcileExpiredAudio(scoped, grant, next, now);
      }
    );
    const resumed = await f.service.nativeControl(f.headers, "resume", {
      meetingId,
      grantId,
      requestKey: randomUUID(),
      command: "record",
      expectedGeneration: 2
    });
    expect(resumed.capture).toMatchObject({
      desired: "recording",
      generation: 3,
      epoch: 2,
      gaps: [expect.objectContaining({ id: clip.requestKey, epoch: 1, reason: "interrupted" })]
    });
    expect(finish).toHaveBeenCalledExactlyOnceWith(
      scoped,
      f.grant.id,
      expect.objectContaining({
        requestKey: clip.requestKey,
        status: "failed",
        retryable: false
      }),
      at(63000)
    );
  });
});
