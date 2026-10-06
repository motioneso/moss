import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCompanionDevicesService,
  createCompanionPairingService,
  createRecordingCapabilitiesService,
  sha256Base64url,
  type CompanionPairingService,
  type RecordingCapabilitiesService
} from "@moss/auth";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  resetEmptyFoundationDatabase
} from "./test-database.js";

// Real auth-runtime SQL/roles; all users, proofs and sessions are disposable synthetic fixtures.
const owner = randomUUID(),
  otherOwner = randomUUID(),
  sessionId = randomUUID(),
  otherSessionId = randomUUID();
const now = new Date("2026-10-06T00:00:00Z"),
  expiresAt = new Date("2026-10-07T00:00:00Z");
const verifier = "v".repeat(43),
  proof = "p".repeat(43),
  replacementProof = "r".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let bootstrap: pg.Client, app: pg.Client, worker: pg.Client, pool: pg.Pool;
let pairing: CompanionPairingService, capabilities: RecordingCapabilitiesService;
const browser = { actorUserId: owner, sessionId, expiresAt, requestId: "synthetic-browser" };

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  app = new pg.Client({ connectionString: connectionStrings.app });
  worker = new pg.Client({ connectionString: connectionStrings.worker });
  await Promise.all([bootstrap.connect(), app.connect(), worker.connect()]);
  await bootstrap.query(
    `INSERT INTO app.users(id,email,name,status,is_instance_admin) VALUES
    ($1,'recording-owner@example.test','Recorder owner','active',false),
    ($2,'recording-other@example.test','Other owner','active',true)`,
    [owner, otherOwner]
  );
  await bootstrap.query(
    `INSERT INTO app.better_auth_sessions(id,user_id,token,expires_at) VALUES
    ($1,$2,'synthetic-recording-session',$5),($3,$4,'synthetic-other-recording-session',$5)`,
    [sessionId, owner, otherSessionId, otherOwner, expiresAt]
  );
  pool = new pg.Pool({ connectionString: connectionStrings.auth, max: 4 });
  pairing = createCompanionPairingService({ pool, now: () => now });
  const devices = createCompanionDevicesService({ pool, now: () => now });
  capabilities = createRecordingCapabilitiesService({
    pool,
    companionDevices: devices,
    now: () => now
  });
});
afterAll(async () => {
  await Promise.allSettled([bootstrap?.end(), app?.end(), worker?.end(), pool?.end()]);
});

async function link(withRecording = false) {
  const attempt = await pairing.create({
    deviceName: "Synthetic recorder",
    platform: "macos",
    appVersion: "test",
    osVersion: "test",
    verifierHash: sha256Base64url(verifier),
    ...(withRecording
      ? { recordingProofHash: hash(proof), recordingPolicyVersion: 1 as const }
      : {})
  });
  expect(
    await pairing.decide({
      approvalCode: attempt.approvalCode,
      decision: "approve",
      actorUserId: owner,
      ...(withRecording ? { browserSessionId: sessionId, recordingPolicyVersion: 1 as const } : {})
    })
  ).toEqual({ ok: true, decision: "approve" });
  const result = await pairing.redeem({ attemptId: attempt.attemptId, verifier });
  if (result.status !== "issued") throw new Error("Synthetic pairing failed");
  return result.response;
}
function request(credential: string, recordingProof = proof) {
  return {
    headers: { authorization: `Bearer ${credential}`, "x-moss-recording-proof": recordingProof },
    requestId: "synthetic-recorder"
  };
}

describe("one-time recording capability authorization", () => {
  it("leaves legacy devices unapproved and requires the independent native proof", async () => {
    const legacy = await link();
    expect(legacy.recordingCapability).toBeUndefined();
    await expect(capabilities.resolve(request(legacy.credential))).rejects.toThrow();
    const approved = await link(true);
    expect(approved.recordingCapability).toEqual({ policyVersion: 1, revision: 1 });
    const resolved = await capabilities.resolve(request(approved.credential));
    expect(resolved).toMatchObject({
      actorUserId: owner,
      deviceId: approved.device.id,
      capabilityRevision: 1
    });
    await expect(
      capabilities.resolve(request(approved.credential, replacementProof))
    ).rejects.toThrow();
    await expect(
      capabilities.resolve({
        headers: { authorization: `Bearer ${approved.credential}` },
        requestId: "stolen-tm1"
      })
    ).rejects.toThrow();
    const stored = await pool.query(
      "SELECT proof_hash FROM app.companion_recording_capabilities WHERE device_id=$1",
      [approved.device.id]
    );
    expect(stored.rows[0].proof_hash).toBe(hash(proof));
    expect(JSON.stringify(stored.rows)).not.toContain(proof);
  });
  it("cannot approve requested recording proof without current cookie-session consent", async () => {
    const attempt = await pairing.create({
      deviceName: "Pending recorder",
      platform: "macos",
      appVersion: "test",
      osVersion: "test",
      verifierHash: sha256Base64url(verifier),
      recordingProofHash: hash(proof),
      recordingPolicyVersion: 1
    });
    expect(await pairing.summarize({ approvalCode: attempt.approvalCode })).toMatchObject({
      recordingPolicyVersion: 1,
      status: "pending"
    });
    expect(
      await pairing.decide({
        approvalCode: attempt.approvalCode,
        actorUserId: owner,
        decision: "approve",
        recordingPolicyVersion: 1
      })
    ).toMatchObject({ ok: false });
    expect(await pairing.redeem({ attemptId: attempt.attemptId, verifier })).toEqual({
      status: "pending"
    });
    expect(
      await pairing.decide({
        approvalCode: attempt.approvalCode,
        actorUserId: owner,
        decision: "approve",
        recordingPolicyVersion: 1,
        browserSessionId: otherSessionId
      })
    ).toMatchObject({ ok: false });
    expect(
      await pairing.decide({
        approvalCode: attempt.approvalCode,
        actorUserId: owner,
        decision: "approve",
        recordingPolicyVersion: 1,
        browserSessionId: sessionId
      })
    ).toEqual({ ok: true, decision: "approve" });
  });
  it("upgrades once, preserves same-request retries, and never revives revoked revisions", async () => {
    const linked = await link();
    const actor = { actorUserId: owner, deviceId: linked.device.id, requestId: "upgrade" };
    const input = { requestKey: randomUUID(), proofHash: hash(proof), policyVersion: 1 as const };
    const attempt = await capabilities.createAttempt(actor, input);
    expect(await capabilities.createAttempt(actor, input)).toEqual(attempt);
    await expect(
      capabilities.createAttempt(actor, { ...input, proofHash: hash(replacementProof) })
    ).rejects.toThrow();
    await expect(
      capabilities.decide(
        { ...browser, actorUserId: otherOwner, sessionId: otherSessionId },
        { attemptId: attempt.attemptId, decision: "approve", policyVersion: 1 }
      )
    ).rejects.toThrow();
    expect(
      await capabilities.decide(browser, {
        attemptId: attempt.attemptId,
        decision: "approve",
        policyVersion: 1
      })
    ).toEqual({ status: "approved", revision: 1 });
    expect(
      await capabilities.decide(browser, {
        attemptId: attempt.attemptId,
        decision: "approve",
        policyVersion: 1
      })
    ).toEqual({ status: "approved", revision: 1 });
    expect(await capabilities.attemptStatus(actor, attempt.attemptId)).toMatchObject({
      status: "approved",
      revision: 1
    });
    const beforeDelay = now.getTime();
    try {
      now.setTime(beforeDelay + 11 * 60 * 1000);
      expect(await capabilities.attemptStatus(actor, attempt.attemptId)).toMatchObject({
        status: "approved",
        revision: 1
      });
      expect(await capabilities.createAttempt(actor, input)).toMatchObject({
        status: "approved",
        revision: 1
      });
    } finally {
      now.setTime(beforeDelay);
    }
    await capabilities.revoke(browser, linked.device.id);
    await expect(capabilities.resolve(request(linked.credential))).rejects.toThrow();
    await expect(
      capabilities.decide(browser, {
        attemptId: attempt.attemptId,
        decision: "approve",
        policyVersion: 1
      })
    ).rejects.toThrow();
    expect(await capabilities.attemptStatus(actor, attempt.attemptId)).toMatchObject({
      status: "expired"
    });
    const next = await capabilities.createAttempt(actor, {
      requestKey: randomUUID(),
      proofHash: hash(replacementProof),
      policyVersion: 1
    });
    const reapproved = await capabilities.decide(browser, {
      attemptId: next.attemptId,
      decision: "approve",
      policyVersion: 1
    });
    expect(reapproved).toEqual({ status: "approved", revision: 3 });
    await expect(capabilities.assertLive({ ...actor, capabilityRevision: 1 })).rejects.toThrow();
    await expect(capabilities.resolve(request(linked.credential))).rejects.toThrow();
    expect(await capabilities.resolve(request(linked.credential, replacementProof))).toMatchObject({
      capabilityRevision: 3
    });
  });
  it("binds upgrade status and approval to the exact owner/device and current session", async () => {
    const one = await link(),
      two = await link();
    const actor = { actorUserId: owner, deviceId: one.device.id, requestId: "scope" };
    const attempt = await capabilities.createAttempt(actor, {
      requestKey: randomUUID(),
      proofHash: hash(proof),
      policyVersion: 1
    });
    await expect(
      capabilities.attemptStatus({ ...actor, deviceId: two.device.id }, attempt.attemptId)
    ).rejects.toThrow();
    await expect(
      capabilities.decide(
        { ...browser, sessionId: randomUUID() },
        { attemptId: attempt.attemptId, decision: "approve", policyVersion: 1 }
      )
    ).rejects.toThrow();
    expect(await capabilities.attemptStatus(actor, attempt.attemptId)).toMatchObject({
      status: "pending"
    });
    const publicView = await capabilities.list(owner);
    expect(JSON.stringify(publicView)).not.toContain(hash(proof));
    expect(JSON.stringify(publicView)).not.toContain(proof);
    expect((await capabilities.list(otherOwner)).devices).toEqual([]);
  });
  it("canonicalizes uppercase IDs and releases auth connections instead of waiting on capture", async () => {
    const linked = await link(true);
    const input = { actorUserId: owner, deviceId: linked.device.id, capabilityRevision: 1 };
    await app.query("BEGIN");
    try {
      await app.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('meeting-device:' || $1::uuid::text,0))",
        [linked.device.id]
      );
      const mutations = Array.from({ length: 4 }, () =>
        capabilities.revoke(browser, linked.device.id.toUpperCase())
      );
      const results = await Promise.race([
        Promise.allSettled(mutations),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Capability mutation held auth pool behind capture")),
            5000
          );
          timer.unref();
        })
      ]);
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.httpStatus === 429 &&
            result.reason.retryAfterSeconds === 1
        )
      ).toBe(true);
      await expect(capabilities.assertLive(input)).resolves.toHaveProperty("expiresAt");
    } finally {
      await app.query("ROLLBACK");
    }
    await capabilities.revoke(browser, linked.device.id.toUpperCase());
    await expect(capabilities.assertLive(input)).rejects.toThrow();
  });
  it.each(["companion_recording_capabilities", "companion_recording_attempts"])(
    "keeps %s auth-only and detects removal of its protections",
    async (table) => {
      assertIsolatedTestDatabase(connectionStrings.bootstrap);
      const assertDenied = async (client: pg.Client) => {
        let rejected = false;
        try {
          await client.query(`SELECT * FROM app.${table}`);
        } catch (error) {
          rejected = /permission denied/i.test(String(error));
        }
        expect(rejected).toBe(true);
      };
      await assertDenied(app);
      await assertDenied(worker);
      await bootstrap.query("BEGIN");
      try {
        await bootstrap.query(`GRANT SELECT ON app.${table} TO jarvis_app_runtime`);
        await bootstrap.query(`ALTER TABLE app.${table} DISABLE ROW LEVEL SECURITY`);
        await bootstrap.query("SET LOCAL ROLE jarvis_app_runtime");
        expect((await bootstrap.query("SELECT current_user AS name")).rows[0].name).toBe(
          "jarvis_app_runtime"
        );
        const exposed = await bootstrap.query(`SELECT proof_hash FROM app.${table}`);
        expect(exposed.rows.length).toBeGreaterThan(0);
        expect(exposed.rows[0].proof_hash).toMatch(/^[a-f0-9]{64}$/);
        await expect(assertDenied(bootstrap)).rejects.toThrow();
      } finally {
        await bootstrap.query("ROLLBACK");
      }
      await assertDenied(app);
      await assertDenied(worker);
      const protection = await bootstrap.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
        [`app.${table}`]
      );
      expect(protection.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  );
});
