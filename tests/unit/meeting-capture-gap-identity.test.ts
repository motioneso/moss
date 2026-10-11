import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  retainCaptureGap,
  type CaptureStoredState
} from "../../packages/meetings/src/capture-domain.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant,
  type CaptureReceipt
} from "../../packages/meetings/src/capture-repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

describe("expired capture clip gap identity", () => {
  it("shares each receipt identity with native reports and keeps distinct failed clips", async () => {
    const origin = new Date("2026-10-06T00:00:00Z");
    const now = new Date(origin.getTime() + 61000);
    const state: CaptureStoredState = {
      gaps: [],
      gapLimitReached: false,
      generation: 1,
      desired: "recording",
      originAt: origin.toISOString(),
      epochs: [
        {
          epoch: 1,
          generation: 1,
          startMs: 0,
          endMs: null,
          modelRoute: "route",
          microphoneLabel: "Synthetic mic",
          outputLabel: null,
          selection: {
            mode: "microphone-only",
            microphone: { deviceId: "mic-device", sourceId: "mic" }
          }
        }
      ],
      stopCutoffMs: null,
      finalizationDeadline: null,
      inventory: null,
      observed: { generation: 1, phase: "recording" },
      lastSeenAt: now.toISOString()
    };
    const grant: CaptureGrant = {
      id: randomUUID(),
      meeting_id: randomUUID(),
      owner_user_id: randomUUID(),
      device_id: randomUUID(),
      device_name: "Synthetic Mac",
      verifier_hash: "unused",
      credential_hash: null,
      session_id: null,
      status: "active",
      created_at: origin,
      expires_at: new Date(origin.getTime() + 7200000),
      state_json: JSON.stringify(state)
    };
    const receipts = [0, 1].map(
      (index): CaptureReceipt => ({
        request_key: randomUUID(),
        kind: "audio",
        fingerprint: `clip-${index}`,
        metadata_json: JSON.stringify({
          sourceId: "mic",
          epoch: 1,
          startMs: index * 1000,
          endMs: (index + 1) * 1000
        }),
        result_json: null,
        created_at: origin
      })
    );
    const { scoped, queries } = makeRecordingDb({
      rows: receipts.map((receipt) => ({ ...receipt }))
    });
    const repository = new MeetingCaptureRepository();
    await repository.reconcileExpiredAudio(scoped, grant, state, now);
    expect(state.gaps.map((gap) => gap.id)).toEqual(receipts.map((receipt) => receipt.request_key));
    for (const [index, receipt] of receipts.entries()) {
      retainCaptureGap(
        state,
        {
          id: receipt.request_key,
          sourceId: "mic",
          epoch: 1,
          startMs: index * 1000,
          endMs: (index + 1) * 1000,
          reason: "interrupted"
        },
        now
      );
    }
    await repository.reconcileExpiredAudio(scoped, grant, state, now);
    expect(state.gaps).toHaveLength(2);
    expect(state.gaps.map((gap) => [gap.startMs, gap.endMs, gap.reason])).toEqual([
      [0, 1000, "interrupted"],
      [1000, 2000, "interrupted"]
    ]);
    const terminalResults = queries
      .filter((query) => query.sql.includes("SET result_json="))
      .map((query) => JSON.parse(String(query.parameters[0])));
    expect(terminalResults).toEqual(
      expect.arrayContaining(
        receipts.map((receipt) =>
          expect.objectContaining({
            requestKey: receipt.request_key,
            status: "failed",
            code: "meeting_capture_interrupted",
            reason: "audio-expired",
            retryable: false
          })
        )
      )
    );
  });
});
