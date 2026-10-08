import { createHash, randomUUID } from "node:crypto";
import { captureMetadataJson } from "../../packages/meetings/src/capture-metadata.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { decodeCaptureAudio } from "../../packages/meetings/src/capture-domain.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import {
  closeLinkDatabase,
  context,
  linkFixture,
  setupLinkDatabase
} from "./meeting-link-fixture.js";

beforeAll(setupLinkDatabase);
afterAll(closeLinkDatabase);
const fixtures: Awaited<ReturnType<typeof linkFixture>>[] = [];
async function fixture(initialNow?: Date) {
  const f = await linkFixture(initialNow);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.server.close()));
});

describe("same-source recovery with real auth and storage (isolated gate only)", () => {
  it("serializes duplicate recovery requests into one epoch and requires recording acknowledgment", async () => {
    const f = await fixture(),
      active = await f.begin();
    const input = {
      meetingId: f.meeting.id,
      grantId: active.grantId,
      requestKey: randomUUID(),
      command: "recover-sources" as const,
      expectedGeneration: 1,
      expectedEpoch: 1,
      selection: {
        mode: "microphone-only" as const,
        microphone: { deviceId: "fixture-mic", sourceId: "mic" }
      }
    };
    await f.service.status(active.headers, "recovering", {
      ...active.statusInput,
      observed: { generation: 1, phase: "recovering" }
    });
    const [first, replay] = await Promise.all([
      f.service.nativeControl(active.headers, "first-recovery", input),
      f.service.nativeControl(active.headers, "duplicate-recovery", input)
    ]);
    expect(first.capture).toMatchObject({ epoch: 2, generation: 2, selection: input.selection });
    expect(replay).toEqual(first);
    expect(JSON.parse((await active.stored())!.state_json!)).toMatchObject({
      automaticRecoveryCount: 1,
      epochs: [expect.anything(), expect.anything()]
    });
    f.advance(2000);
    const clip = {
      ...active.audio,
      requestKey: randomUUID(),
      epoch: 2,
      generation: 2,
      startMs: first.capture.epochStartMs,
      endMs: first.capture.epochStartMs + 1000
    };
    await expect(f.service.audio(active.headers, "not-acknowledged", clip)).rejects.toMatchObject({
      code: "meeting_capture_interrupted"
    });
    await f.service.status(active.headers, "recording-replacement", {
      ...active.statusInput,
      observed: { generation: 2, phase: "recording" }
    });
    expect(await f.service.audio(active.headers, "replacement-audio", clip)).toMatchObject({
      status: "saved"
    });
    await expect(
      f.service.nativeControl(active.headers, "changed-retry", {
        ...input,
        command: "change-sources"
      })
    ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
    const repository = new MeetingCaptureRepository();
    expect(
      await context.withDataContext(f.browser, (db) =>
        repository.receipt(
          db,
          active.grantId,
          input.requestKey,
          createHash("sha256").update(captureMetadataJson(input)).digest("hex")
        )
      )
    ).toMatchObject({ kind: "control" });
  });

  it("rolls back the replacement epoch when its control receipt limit is exhausted", async () => {
    const f = await fixture(),
      active = await f.begin();
    await context.withDataContext(f.browser, (db) =>
      sql`INSERT INTO app.meeting_capture_receipts (grant_id,request_key,kind,fingerprint,metadata_json,result_json)
        SELECT ${active.grantId}::uuid,gen_random_uuid(),'control',${"a".repeat(64)},'{}','{}'
        FROM generate_series(1,4000)`.execute(db.db)
    );
    const before = (await active.stored())!.state_json;
    await expect(
      f.service.nativeControl(active.headers, "receipt-cap", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        requestKey: randomUUID(),
        expectedGeneration: 1,
        expectedEpoch: 1,
        command: "recover-sources",
        selection: {
          mode: "microphone-only",
          microphone: { deviceId: "fixture-mic", sourceId: "mic" }
        }
      })
    ).rejects.toMatchObject({ code: "meeting_capture_limit", httpStatus: 413 });
    expect((await active.stored())!.state_json).toBe(before);
  });

  it("persists the automatic recovery cap across healthy periods and manual Resume", async () => {
    const f = await fixture(),
      active = await f.begin();
    expect(JSON.parse((await active.stored())!.state_json!).automaticRecoveryCount).toBe(0);
    for (let count = 1; count <= 8; count++) {
      const input = {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        requestKey: randomUUID(),
        command: "recover-sources" as const,
        expectedGeneration: count,
        expectedEpoch: count,
        selection: {
          mode: "microphone-only" as const,
          microphone: { deviceId: "fixture-mic", sourceId: "mic" }
        }
      };
      const first = await f.service.nativeControl(active.headers, "recover", input);
      expect(await f.service.nativeControl(active.headers, "replay", input)).toEqual(first);
      expect(JSON.parse((await active.stored())!.state_json!).automaticRecoveryCount).toBe(count);
      f.advance(3000);
      await f.service.status(active.headers, "healthy-recording", {
        ...active.statusInput,
        observed: { generation: count + 1, phase: "recording" }
      });
    }
    const capped = {
      meetingId: f.meeting.id,
      grantId: active.grantId,
      requestKey: randomUUID(),
      command: "recover-sources" as const,
      expectedGeneration: 9,
      expectedEpoch: 9,
      selection: {
        mode: "microphone-only" as const,
        microphone: { deviceId: "fixture-mic", sourceId: "mic" }
      }
    };
    const before = (await active.stored())!.state_json;
    await expect(f.service.nativeControl(active.headers, "capped", capped)).rejects.toMatchObject({
      code: "meeting_capture_limit",
      httpStatus: 413
    });
    expect((await active.stored())!.state_json).toBe(before);
    await f.service.nativeControl(active.headers, "pause", {
      meetingId: f.meeting.id,
      grantId: active.grantId,
      requestKey: randomUUID(),
      command: "pause",
      expectedGeneration: 9
    });
    const resumed = await f.service.nativeControl(active.headers, "resume", {
      meetingId: f.meeting.id,
      grantId: active.grantId,
      requestKey: randomUUID(),
      command: "record",
      expectedGeneration: 10
    });
    expect(resumed.capture).toMatchObject({ desired: "recording", epoch: 10, generation: 11 });
    expect(JSON.parse((await active.stored())!.state_json!).automaticRecoveryCount).toBe(8);
    await expect(
      f.service.nativeControl(active.headers, "still-capped", {
        ...capped,
        requestKey: randomUUID(),
        expectedGeneration: 11,
        expectedEpoch: 10
      })
    ).rejects.toMatchObject({ code: "meeting_capture_limit", httpStatus: 413 });
  });

  it.each(["recover", "delayed-resume"] as const)(
    "retires an old pending receipt without blocking or pausing the new epoch after %s",
    async (kind) => {
      // Start in the past so advancing through retention never puts the service ahead of
      // PostgreSQL's real clock. Fresh receipt creation time remains immutable and real.
      const f = await fixture(new Date(Date.now() - 120000)),
        active = await f.begin(),
        repository = new MeetingCaptureRepository();
      const original = active.audio;
      const { fingerprint } = decodeCaptureAudio(original);
      // Model an earlier admitted upload whose provider result never returned. Seed only
      // its metadata through ordinary owner-scoped INSERT; all recovery paths below are real.
      const metadata = {
        sourceId: original.sourceId,
        epoch: original.epoch,
        generation: original.generation,
        sequence: original.sequence,
        startMs: original.startMs,
        endMs: original.endMs
      };
      await context.withDataContext(f.browser, (db) =>
        sql`INSERT INTO app.meeting_capture_receipts
          (grant_id,request_key,kind,fingerprint,metadata_json,created_at)
          VALUES (${active.grantId}::uuid,${original.requestKey}::uuid,'audio',${fingerprint},${JSON.stringify(metadata)},${f.now()})`.execute(
          db.db
        )
      );
      const control = {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        requestKey: randomUUID(),
        expectedGeneration: 1
      };
      let nextGeneration = 2;
      if (kind === "recover") {
        await f.service.nativeControl(active.headers, "recover", {
          ...control,
          command: "recover-sources",
          expectedEpoch: 1,
          selection: {
            mode: "microphone-only",
            microphone: { deviceId: "fixture-mic", sourceId: "mic" }
          }
        });
        await f.service.status(active.headers, "acknowledge", {
          ...active.statusInput,
          observed: { generation: 2, phase: "recording" }
        });
        f.advance(2000);
        await expect(
          f.service.audio(active.headers, "same-source-still-pending", {
            ...original,
            requestKey: randomUUID(),
            generation: 2,
            epoch: 2,
            startMs: 2000,
            endMs: 3000
          })
        ).rejects.toMatchObject({ code: "meeting_capture_busy" });
        for (let index = 0; index < 3; index++) {
          f.advance(20000);
          expect(
            (
              await f.service.status(active.headers, "keep-current-live", {
                ...active.statusInput,
                observed: { generation: 2, phase: "recording" }
              })
            ).capture
          ).toMatchObject({ desired: "recording", generation: 2, epoch: 2 });
        }
      } else {
        await f.service.nativeControl(active.headers, "pause", { ...control, command: "pause" });
        f.advance(61000);
        await f.register();
        await f.service.status(active.headers, "paused-heartbeat", {
          ...active.statusInput,
          observed: { generation: 2, phase: "paused" }
        });
        const resumed = await f.service.nativeControl(active.headers, "delayed-resume", {
          ...control,
          requestKey: randomUUID(),
          command: "record",
          expectedGeneration: 2
        });
        nextGeneration = resumed.capture.generation;
        expect(resumed.capture).toMatchObject({ desired: "recording", epoch: 2, generation: 3 });
        await f.service.status(active.headers, "resumed-acknowledgment", {
          ...active.statusInput,
          observed: { generation: nextGeneration, phase: "recording" }
        });
      }
      const state = JSON.parse((await active.stored())!.state_json!);
      expect(state.gaps).toEqual([
        expect.objectContaining({
          id: original.requestKey,
          epoch: 1,
          sourceId: "mic",
          startMs: 0,
          endMs: 1000,
          reason: "interrupted"
        })
      ]);
      const old = await context.withDataContext(f.browser, (db) =>
        repository.receipt(db, active.grantId, original.requestKey, fingerprint)
      );
      expect(JSON.parse(old!.result_json!)).toMatchObject({
        status: "failed",
        reason: "audio-expired",
        retryable: false
      });
      expect(await f.service.audio(active.headers, "unknown-old-result", original)).toMatchObject({
        status: "failed",
        reason: "audio-expired",
        replayed: true
      });
      f.advance(2000);
      const current = (
        await f.service.status(active.headers, "new-audio-time", {
          ...active.statusInput,
          observed: { generation: nextGeneration, phase: "recording" }
        })
      ).capture;
      expect(
        await f.service.audio(active.headers, "new-epoch-first-sequence", {
          ...original,
          requestKey: randomUUID(),
          generation: nextGeneration,
          epoch: 2,
          sequence: 0,
          startMs: current.elapsedMs - 1000,
          endMs: current.elapsedMs
        })
      ).toMatchObject({ status: "saved" });
      expect(JSON.parse((await active.stored())!.state_json!)).toMatchObject({
        desired: "recording",
        generation: nextGeneration
      });
    }
  );
});
