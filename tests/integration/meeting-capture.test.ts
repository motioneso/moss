import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let worker: Kysely<MossDatabase>;
let workerContext: DataContextRunner;
let context: DataContextRunner;
beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(app);
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  worker = createDatabase({ connectionString: connectionStrings.worker });
  workerContext = new DataContextRunner(worker);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy(), worker?.destroy()]);
});
async function fixture() {
  let now = new Date();
  const deviceId = randomUUID();
  const owner = { actorUserId: ids.userA };
  const browser = {
    ...owner,
    sessionId: randomUUID(),
    expiresAt: new Date(now.getTime() + 7200000)
  };
  const { meeting } = await context.withDataContext(owner, (db) =>
    new MeetingRecordsRepository().create(db, {
      title: "Synthetic capture fixture",
      requestKey: randomUUID()
    })
  );
  // Auth and provider ports are synthetic. Module storage, RLS, control and transcript are real.
  const deps: MeetingCaptureDependencies = {
    dataContext: context,
    resolveBrowser: async () => browser,
    resolveCompanion: async () => ({ ...owner, deviceId }),
    assertBinding: async () => {},
    device: async () => ({ displayName: "Synthetic Mac", expiresAt: browser.expiresAt }),
    assertModuleAvailable: async () => {},
    trustedOrigins: ["https://synthetic.example"],
    processingAvailability: async () => ({ ready: true, modelRoute: "synthetic-route" }),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 900, text: "Synthetic capture evidence" }],
        modelRoute: "synthetic-route"
      }))
    ),
    now: () => now
  };
  const service = new MeetingCaptureService(deps);
  const verifier = "v".repeat(43);
  const native = { authorization: "Bearer tm1_synthetic" };
  const link = await service.link(native, "link", {
    meetingId: meeting.id,
    verifierHash: createHash("sha256").update(verifier).digest("hex")
  });
  return {
    deps,
    service,
    meeting,
    browser,
    owner,
    native,
    link,
    verifier,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    }
  };
}
const inventory = {
  microphones: [{ deviceId: "mic-device", sourceId: "mic", label: "Synthetic mic" }],
  applications: [],
  computerAudio: { available: false, excludedProcessTreeIds: [] },
  microphonePermission: "granted" as const,
  systemAudioPermission: "unknown" as const
};
describe("meeting capture persisted protocol (isolated gate only)", () => {
  it("bootstrap does not probe arbitrary proposed meeting IDs and owner approval enforces ownership", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const link = await f.service.link(f.native, "link", {
      meetingId: missing,
      verifierHash: "a".repeat(64)
    });
    expect(link.meetingId).toBe(missing);
    await expect(f.service.approve(f.browser, missing, link.challengeId)).rejects.toThrow();
    await expect(
      f.service.approve({ ...f.browser, actorUserId: ids.userB }, f.meeting.id, f.link.challengeId)
    ).rejects.toThrow();
    const repository = new MeetingCaptureRepository();
    for (const actorUserId of [ids.userB, ids.adminUser])
      expect(
        await context.withDataContext({ actorUserId }, (db) =>
          repository.link(db, f.link.challengeId)
        )
      ).toBeNull();
  });
  it("reconciles a crashed clip on a later read even when its missing interval predates the last heartbeat", async () => {
    const f = await fixture();
    await f.service.approve(f.browser, f.meeting.id, f.link.challengeId);
    const redeemed = await f.service.redeem(f.native, "redeem", {
      meetingId: f.meeting.id,
      challengeId: f.link.challengeId,
      verifier: f.verifier
    });
    if (redeemed.status !== "issued") throw Error("expected issued");
    const grantId = redeemed.grantId,
      headers = { authorization: `Bearer ${redeemed.credential}` };
    const status = (generation: number, phase: "idle" | "recording") =>
      f.service.status(headers, "status", {
        meetingId: f.meeting.id,
        grantId,
        inventory,
        observed: { generation, phase }
      });
    await status(0, "idle");
    await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 0,
      command: "record",
      noticeAcknowledged: true,
      selection: {
        mode: "microphone-only",
        microphone: { deviceId: "mic-device", sourceId: "mic" }
      }
    });
    await status(1, "recording");
    const requestKey = randomUUID();
    await context.withDataContext(f.owner, (db) =>
      new MeetingCaptureRepository().reserve(db, grantId, {
        requestKey,
        kind: "audio",
        fingerprint: "e".repeat(64),
        metadata: { sourceId: "mic", epoch: 1, generation: 1, sequence: 0, startMs: 0, endMs: 5000 }
      })
    );
    for (let i = 0; i < 6; i++) {
      f.advance(5000);
      await status(1, "recording");
    }
    f.advance(120000);
    const first = await f.service.browserStatus(f.browser, f.meeting.id);
    expect(first.capture?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mic",
          startMs: 0,
          endMs: 5000,
          reason: "interrupted"
        }),
        expect.objectContaining({ startMs: 30000, endMs: 40000, reason: "interrupted" })
      ])
    );
    const second = await f.service.browserStatus(f.browser, f.meeting.id);
    expect(second.capture?.gaps).toEqual(first.capture?.gaps);
    expect(f.deps.transcribe).not.toHaveBeenCalled();
    const receipt = await context.withDataContext(f.owner, (db) =>
      new MeetingCaptureRepository().receipt(db, grantId, requestKey, "e".repeat(64))
    );
    expect(JSON.parse(receipt!.result_json!)).toMatchObject({
      status: "failed",
      code: "meeting_capture_interrupted"
    });
  });
  it("requires exact verifier, grants only after owner approval, and redeems once", async () => {
    const f = await fixture();
    const input = {
      meetingId: f.meeting.id,
      challengeId: f.link.challengeId,
      verifier: f.verifier
    };
    expect(await f.service.redeem(f.native, "redeem", input)).toEqual({ status: "pending" });
    await f.service.approve(f.browser, f.meeting.id, f.link.challengeId);
    await expect(
      f.service.redeem(f.native, "redeem", { ...input, verifier: "wrong" })
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      f.service.redeem(f.native, "redeem", input),
      f.service.redeem(f.native, "redeem", input)
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  });
  it("persists transcript and metadata receipts without raw audio; Pause, Stop and revocation fence sends", async () => {
    const f = await fixture();
    await f.service.approve(f.browser, f.meeting.id, f.link.challengeId);
    const redeemed = await f.service.redeem(f.native, "redeem", {
      meetingId: f.meeting.id,
      challengeId: f.link.challengeId,
      verifier: f.verifier
    });
    if (redeemed.status !== "issued") throw Error("expected issued");
    const headers = { authorization: `Bearer ${redeemed.credential}` };
    const grantId = redeemed.grantId;
    await f.service.status(headers, "status", {
      meetingId: f.meeting.id,
      grantId,
      inventory,
      observed: { generation: 0, phase: "idle" }
    });
    const record = {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 0,
      command: "record" as const,
      noticeAcknowledged: true as const,
      selection: {
        mode: "microphone-only" as const,
        microphone: { deviceId: "mic-device", sourceId: "mic" }
      }
    };
    const started = await f.service.browserControl(f.browser, f.meeting.id, record);
    expect(
      (await f.service.browserControl(f.browser, f.meeting.id, record)).capture.generation
    ).toBe(started.capture.generation);
    await f.service.status(headers, "status", {
      meetingId: f.meeting.id,
      grantId,
      inventory,
      observed: { generation: 1, phase: "recording" }
    });
    f.advance(2000);
    const clip = {
      meetingId: f.meeting.id,
      grantId,
      requestKey: randomUUID(),
      generation: 1,
      epoch: 1,
      sourceId: "mic",
      sequence: 0,
      startMs: started.capture.epochStartMs,
      endMs: started.capture.epochStartMs + 1000,
      sampleRateHz: 16000,
      pcmBase64: Buffer.alloc(32000, 1).toString("base64")
    };
    expect(await f.service.audio(headers, "audio", clip)).toMatchObject({ status: "saved" });
    expect(await f.service.audio(headers, "audio", clip)).toMatchObject({
      status: "saved",
      replayed: true
    });
    expect(f.deps.transcribe).toHaveBeenCalledOnce();
    const transcript = await context.withDataContext(f.owner, (db) =>
      new MeetingTranscriptRepository().snapshotWithSources(db, f.meeting.id, {
        maxSegments: 50,
        maxCharacters: 10000
      })
    );
    expect(transcript?.snapshot.segments[0]?.text).toBe("Synthetic capture evidence");
    const stored = await context.withDataContext(f.owner, (db) =>
      sql<{
        metadata_json: string;
        result_json: string;
      }>`SELECT metadata_json,result_json FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid`.execute(
        db.db
      )
    );
    expect(JSON.stringify(stored.rows)).not.toContain(clip.pcmBase64);
    await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "pause"
    });
    await expect(
      f.service.audio(headers, "audio", { ...clip, requestKey: randomUUID(), sequence: 1 })
    ).rejects.toThrow();
    const stopped = await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "stop"
    });
    expect(stopped.capture.stopCutoffMs).toBeGreaterThanOrEqual(2000);
    const head = await context.withDataContext(f.owner, (db) =>
      new MeetingCaptureRepository().transcriptHead(db, f.meeting.id)
    );
    expect(head.stop_cutoff_ms).toBe(stopped.capture.stopCutoffMs);
    const revoke = {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 3,
      command: "revoke" as const
    };
    await f.service.browserControl(f.browser, f.meeting.id, revoke);
    expect((await f.service.browserControl(f.browser, f.meeting.id, revoke)).capture.desired).toBe(
      "revoked"
    );
    await expect(
      f.service.status(headers, "status", {
        meetingId: f.meeting.id,
        grantId,
        inventory,
        observed: { generation: 4, phase: "stopped" }
      })
    ).rejects.toThrow();
  });
});

class CaptureIsolationProbeError extends Error {}
function assertCaptureInvisible(rows: readonly unknown[]) {
  if (rows.length) throw new CaptureIsolationProbeError("Capture owner isolation assertion failed");
}
async function retainedAuthorizationFixture() {
  const f = await fixture();
  await f.service.approve(f.browser, f.meeting.id, f.link.challengeId);
  await context.withDataContext(f.owner, (db) =>
    new MeetingCaptureRepository().reserve(db, f.link.challengeId, {
      requestKey: randomUUID(),
      kind: "control",
      fingerprint: "c".repeat(64),
      metadata: { command: "stop" },
      result: { status: "synthetic" }
    })
  );
  return f;
}
describe("capture owner and worker isolation", () => {
  for (const [table, key] of [
    ["app.meeting_capture_links", "id"],
    ["app.meeting_capture_grants", "id"],
    ["app.meeting_capture_receipts", "grant_id"]
  ] as const) {
    it(`${table} isolates other owners/admins and detects rollback-only RLS removal`, async () => {
      assertIsolatedTestDatabase(connectionStrings.bootstrap);
      const expectedDatabase = new URL(connectionStrings.bootstrap).pathname.slice(1);
      if (!/^(jarvis_gate_|jarvis_test_)/.test(expectedDatabase))
        throw Error("Mutation probe requires disposable gate/test database");
      const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(
        bootstrap
      );
      expect(database.rows[0]?.name).toBe(expectedDatabase);
      const f = await retainedAuthorizationFixture();
      const protectedCheck = async (actorUserId: string) =>
        context.withDataContext({ actorUserId }, async (db) => {
          const rows =
            await sql`SELECT ${sql.ref(key)} FROM ${sql.ref(table)} WHERE ${sql.ref(key)}=${f.link.challengeId}::uuid`.execute(
              db.db
            );
          assertCaptureInvisible(rows.rows);
        });
      for (const actor of [ids.userB, ids.adminUser]) await protectedCheck(actor);
      await expect(
        bootstrap.transaction().execute(async (transaction) => {
          await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(transaction);
          await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
          await sql`SELECT set_config('app.actor_user_id',${ids.userB},true)`.execute(transaction);
          const principal = await sql<{
            role: string;
            actor: string;
          }>`SELECT current_user AS role,current_setting('app.actor_user_id') AS actor`.execute(
            transaction
          );
          expect(principal.rows).toEqual([{ role: "jarvis_app_runtime", actor: ids.userB }]);
          const leaked =
            await sql`SELECT ${sql.ref(key)} FROM ${sql.ref(table)} WHERE ${sql.ref(key)}=${f.link.challengeId}::uuid`.execute(
              transaction
            );
          expect(leaked.rows).toHaveLength(1);
          assertCaptureInvisible(leaked.rows);
          throw Error("Mutation did not defeat owner isolation");
        })
      ).rejects.toBeInstanceOf(CaptureIsolationProbeError);
      const restored = await sql<{
        enabled: boolean;
        forced: boolean;
      }>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid=${table}::regclass`.execute(
        bootstrap
      );
      expect(restored.rows).toEqual([{ enabled: true, forced: true }]);
      await protectedCheck(ids.userB);
    });
  }
  it("worker reads only owner metadata columns, never credential/session/verifier or pending links/receipts", async () => {
    const f = await retainedAuthorizationFixture();
    const read = (actorUserId: string) =>
      workerContext.withDataContext({ actorUserId }, (db) =>
        sql`SELECT id,meeting_id,owner_user_id,device_name,status,state_json,created_at,expires_at FROM app.meeting_capture_grants WHERE id=${f.link.challengeId}::uuid`.execute(
          db.db
        )
      );
    expect((await read(ids.userA)).rows).toHaveLength(1);
    expect((await read(ids.userB)).rows).toEqual([]);
    expect((await read(ids.adminUser)).rows).toEqual([]);
    for (const column of ["credential_hash", "verifier_hash", "session_id"])
      await expect(
        workerContext.withDataContext(f.owner, (db) =>
          sql`SELECT ${sql.ref(column)} FROM app.meeting_capture_grants WHERE id=${f.link.challengeId}::uuid`.execute(
            db.db
          )
        )
      ).rejects.toMatchObject({ code: "42501" });
    for (const table of ["app.meeting_capture_links", "app.meeting_capture_receipts"])
      await expect(
        workerContext.withDataContext(f.owner, (db) =>
          sql`SELECT * FROM ${sql.ref(table)}`.execute(db.db)
        )
      ).rejects.toMatchObject({ code: "42501" });
  });
});
