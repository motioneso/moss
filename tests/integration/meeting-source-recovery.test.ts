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
async function fixture() {
  const f = await linkFixture();
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
    expect(JSON.parse((await active.stored())!.state_json!).epochs).toHaveLength(2);
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

  it.each(["recover", "delayed-resume"] as const)(
    "retires an old pending receipt without blocking or pausing the new epoch after %s",
    async (kind) => {
      const f = await fixture(),
        active = await f.begin(),
        repository = new MeetingCaptureRepository();
      // Advancing the service clock must also advance receipt creation time. PostgreSQL's
      // real now() would otherwise make newly uploaded audio look more than 60 seconds old.
      // Keep the real reservation, admission guards and transaction; only align fixture time.
      const reserve = repository.reserve.bind(repository);
      vi.spyOn(MeetingCaptureRepository.prototype, "reserve").mockImplementation(
        async (...args) => {
          await reserve(...args);
          const [db, grantId, input] = args;
          if (grantId === active.grantId && input.kind === "audio")
            await sql`UPDATE app.meeting_capture_receipts SET created_at=${f.now()}
            WHERE grant_id=${grantId}::uuid AND request_key=${input.requestKey}::uuid`.execute(
              db.db
            );
        }
      );
      const original = active.audio;
      const { fingerprint } = decodeCaptureAudio(original);
      await context.withDataContext(f.browser, async (db) => {
        const grant = (await repository.grant(db, active.grantId, true))!;
        await repository.admitAudio(db, grant, original, fingerprint);
      });
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
