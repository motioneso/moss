import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  createCompanionPairingService,
  createCompanionDevicesService,
  sha256Base64url,
  type CompanionPairingService
} from "@moss/auth";
import { COMPANION_CREDENTIAL_PREFIX, type CreatePairAttemptRequest } from "@moss/shared";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client, Pool } = pg;

// The pairing exchange is the whole security boundary for linking a Mac (#2560). These
// assertions are what stands between "the browser approved this app" and "anyone holding a
// public attempt id gets a credential". Read each as a rule, not a scenario.

const userId = "00000000-0000-4000-8000-0000000025a0";
const otherUserId = "00000000-0000-4000-8000-0000000025a1";

let pool: pg.Pool;
let bootstrapClient: pg.Client;
let pairing: CompanionPairingService;

/** Fake clock so expiry is provable without waiting ten minutes. */
let clock = new Date("2026-09-20T09:00:00.000Z");
const now = () => clock;

const VERIFIER = "v".repeat(43);

function attemptInput(overrides: Partial<CreatePairAttemptRequest> = {}): CreatePairAttemptRequest {
  return {
    deviceName: "Studio Mac",
    platform: "macos",
    appVersion: "1.0.0",
    osVersion: "14.5",
    verifierHash: sha256Base64url(VERIFIER),
    ...overrides
  };
}

async function countDevices(): Promise<number> {
  const result = await pool.query<{ count: string }>("SELECT count(*) FROM app.companion_devices");
  return Number(result.rows[0]?.count ?? "0");
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  bootstrapClient = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrapClient.connect();
  await bootstrapClient.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
     VALUES ($1, 'companion-pairing@example.test', 'Pairing Owner', false, false, 'active'),
            ($2, 'companion-pairing-other@example.test', 'Other Owner', false, false, 'active')`,
    [userId, otherUserId]
  );

  pool = new Pool({ connectionString: connectionStrings.auth, max: 4 });
  pairing = createCompanionPairingService({ pool, now });
});

afterAll(async () => {
  await Promise.allSettled([bootstrapClient?.end(), pool?.end()]);
});

describe("Android browser-approved linking", () => {
  const issuedIds: string[] = [];
  afterAll(async () => {
    await pool.query("DELETE FROM app.companion_devices WHERE id=ANY($1::uuid[])", [issuedIds]);
    await pool.query("DELETE FROM app.companion_pair_attempts WHERE platform='android'");
    await pool.query("DELETE FROM app.better_auth_sessions WHERE id=$1", [sessionId]);
  });
  const sessionId = "00000000-0000-4000-8000-0000000025b0";
  beforeAll(async () => {
    await bootstrapClient.query(
      "INSERT INTO app.better_auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,'synthetic-android-browser','2100-01-01')",
      [sessionId, userId]
    );
  });
  async function issue() {
    const attempt = await pairing.create(attemptInput({ platform: "android" }));
    expect(
      (
        await pairing.decide({
          approvalCode: attempt.approvalCode,
          actorUserId: userId,
          browserSessionId: sessionId,
          decision: "approve"
        })
      ).ok
    ).toBe(true);
    const result = await pairing.redeem({ attemptId: attempt.attemptId, verifier: VERIFIER });
    if (result.status !== "issued") throw new Error("Expected Android credential");
    issuedIds.push(result.response.device.id);
    return {
      attempt,
      response: result.response,
      headers: { authorization: `Bearer ${result.response.credential}` },
      requestId: "android-boundary"
    };
  }
  it("requires a live browser session belonging to the approving owner", async () => {
    const attempt = await pairing.create(attemptInput({ platform: "android" }));
    expect(await pairing.summarize({ approvalCode: attempt.approvalCode })).toMatchObject({
      platform: "android"
    });
    for (const input of [{}, { browserSessionId: sessionId, actorUserId: otherUserId }]) {
      expect(
        (
          await pairing.decide({
            approvalCode: attempt.approvalCode,
            actorUserId: userId,
            decision: "approve",
            ...input
          })
        ).ok
      ).toBe(false);
    }
  });
  it("issues the Android credential/account shape once without Mac capture authority", async () => {
    const { attempt, response } = await issue();
    expect(response.credential).toMatch(/^vr1_[A-Za-z0-9_-]{43}$/);
    expect(response.account.id).toBe(userId);
    expect(response.recordingCapability).toBeUndefined();
    expect(
      (await pairing.redeem({ attemptId: attempt.attemptId, verifier: VERIFIER })).status
    ).toBe("redeemed");
    await pairing.cancel({ attemptId: attempt.attemptId, verifier: VERIFIER });
  });
  it("can cancel a lost Android redemption after approval expiry and another pairing request", async () => {
    const input = await issue();
    const originalClock = clock;
    const android = createCompanionDevicesService({ pool, now, platform: "android" });
    try {
      clock = new Date(clock.getTime() + 11 * 60 * 1000);
      await pairing.create(attemptInput({ platform: "android" }));
      expect(await pairing.summarize({ approvalCode: input.attempt.approvalCode })).toBeNull();
      await pairing.cancel({ attemptId: input.attempt.attemptId, verifier: "w".repeat(43) });
      expect((await android.resolve(input)).actorUserId).toBe(userId);
      await pairing.cancel({ attemptId: input.attempt.attemptId, verifier: VERIFIER });
      await expect(android.resolve(input)).rejects.toMatchObject({ httpStatus: 401 });
    } finally {
      clock = originalClock;
    }
  });
  it.each(["expiry cleanup", "explicit cancellation"])(
    "preserves cancellation when redemption overlaps %s",
    async (operation) => {
      const originalClock = clock;
      const attempt = await pairing.create(attemptInput({ platform: "android" }));
      await pairing.decide({
        approvalCode: attempt.approvalCode,
        actorUserId: userId,
        browserSessionId: sessionId,
        decision: "approve"
      });
      // Pause the real redemption after its attempt claim, before its device insert
      // becomes visible to another transaction. No service responses are replaced.
      await bootstrapClient.query(`CREATE FUNCTION app.test_pause_companion_issue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(3565, 3566); RETURN NEW; END $$`);
      await bootstrapClient.query(`CREATE TRIGGER test_pause_companion_issue BEFORE INSERT ON app.companion_devices
      FOR EACH ROW WHEN (NEW.pair_attempt_id = '${attempt.attemptId}'::uuid) EXECUTE FUNCTION app.test_pause_companion_issue()`);
      await bootstrapClient.query("SELECT pg_advisory_lock(3565, 3566)");
      let redemption: ReturnType<CompanionPairingService["redeem"]> | undefined;
      let overlapping: Promise<unknown> | undefined;
      try {
        redemption = pairing.redeem({ attemptId: attempt.attemptId, verifier: VERIFIER });
        const blocked = async () =>
          Number(
            (
              await bootstrapClient.query<{ count: string }>(
                "SELECT count(*) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE $1",
                ["%INSERT INTO app.companion_devices%"]
              )
            ).rows[0]?.count
          ) > 0;
        await expect.poll(blocked).toBe(true);
        if (operation === "expiry cleanup") clock = new Date(clock.getTime() + 11 * 60 * 1000);
        let completed = false;
        overlapping = (
          operation === "expiry cleanup"
            ? pairing.create(attemptInput({ platform: "android" }))
            : pairing.cancel({ attemptId: attempt.attemptId, verifier: VERIFIER })
        ).then((value) => {
          completed = true;
          return value;
        });
        await expect
          .poll(
            async () =>
              completed ||
              Number(
                (
                  await bootstrapClient.query<{ count: string }>(
                    "SELECT count(*) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE $1",
                    ["%companion_pair_attempts%"]
                  )
                ).rows[0]?.count
              ) > 0
          )
          .toBe(true);
        await bootstrapClient.query("SELECT pg_advisory_unlock(3565, 3566)");
        const issued = await redemption;
        await overlapping;
        if (issued.status !== "issued") throw new Error("Expected Android credential");
        issuedIds.push(issued.response.device.id);
        const android = createCompanionDevicesService({ pool, now, platform: "android" });
        const input = {
          headers: { authorization: `Bearer ${issued.response.credential}` },
          requestId: "overlapping-cleanup"
        };
        if (operation === "expiry cleanup") {
          expect((await android.resolve(input)).actorUserId).toBe(userId);
          await pairing.cancel({ attemptId: attempt.attemptId, verifier: VERIFIER });
        }
        await expect(android.resolve(input)).rejects.toMatchObject({ httpStatus: 401 });
      } finally {
        await bootstrapClient.query("SELECT pg_advisory_unlock(3565, 3566)");
        await Promise.allSettled([redemption, overlapping]);
        await bootstrapClient.query(
          "DROP TRIGGER test_pause_companion_issue ON app.companion_devices"
        );
        await bootstrapClient.query("DROP FUNCTION app.test_pause_companion_issue()");
        clock = originalClock;
      }
    }
  );
  it("accepts Android through its resolver while the Mac resolver rejects that prefix", async () => {
    const input = await issue();
    const android = createCompanionDevicesService({ pool, now, platform: "android" });
    expect((await android.resolve(input)).actorUserId).toBe(userId);
    await expect(createCompanionDevicesService({ pool, now }).resolve(input)).rejects.toMatchObject(
      { httpStatus: 401 }
    );
  });
  it("checks the stored platform independently of the credential prefix", async () => {
    const input = await issue();
    await pool.query("UPDATE app.companion_devices SET platform='macos' WHERE id=$1", [
      input.response.device.id
    ]);
    await expect(
      createCompanionDevicesService({ pool, now, platform: "android" }).resolve(input)
    ).rejects.toMatchObject({ httpStatus: 401 });
  });
  it("rejects mixed browser and Android credentials", async () => {
    const input = await issue();
    await expect(
      createCompanionDevicesService({ pool, now, platform: "android" }).resolve({
        ...input,
        headers: { ...input.headers, cookie: "synthetic" }
      })
    ).rejects.toMatchObject({ httpStatus: 401 });
  });
  it("rejects a revoked Android credential and permits idempotent logout", async () => {
    const input = await issue();
    const android = createCompanionDevicesService({ pool, now, platform: "android" });
    await android.logoutCredential(input);
    await expect(android.resolve(input)).rejects.toMatchObject({ httpStatus: 401 });
    await android.logoutCredential(input);
  });
  it("retains reported versions when a ring owner check updates reachability", async () => {
    const input = await issue();
    const android = createCompanionDevicesService({ pool, now, platform: "android" });
    const actor = await android.resolve(input);
    await android.heartbeat(actor, { appVersion: "1.2.3", osVersion: "16" });
    await android.heartbeat(actor);
    const result = await pool.query(
      "SELECT app_version,os_version,last_contact_at FROM app.companion_devices WHERE id=$1",
      [input.response.device.id]
    );
    expect(result.rows[0]).toMatchObject({
      app_version: "1.2.3",
      os_version: "16",
      last_contact_at: now()
    });
  });
});

describe("creating a pairing attempt", () => {
  it("stores only digests, never the approval code or the verifier", async () => {
    const created = await pairing.create(attemptInput());

    const stored = await pool.query<{ approval_code_hash: string; verifier_hash: string }>(
      "SELECT approval_code_hash, verifier_hash FROM app.companion_pair_attempts WHERE id = $1",
      [created.attemptId]
    );
    const row = stored.rows[0];

    expect(row?.approval_code_hash).toBe(sha256Base64url(created.approvalCode));
    expect(row?.approval_code_hash).not.toBe(created.approvalCode);
    expect(row?.verifier_hash).toBe(sha256Base64url(VERIFIER));
    expect(row?.verifier_hash).not.toBe(VERIFIER);
  });

  it("puts the approval code in the link fragment and nothing else", async () => {
    const created = await pairing.create(attemptInput());
    // A fragment never reaches a server, so the code stays out of request logs and out of
    // any Referer header the approval page would otherwise send.
    expect(created.approvalPath).toBe(
      `/link/trail-marker#code=${encodeURIComponent(created.approvalCode)}`
    );
    expect(created.approvalPath).not.toContain("?");
    expect(created.approvalPath).not.toContain(VERIFIER);
  });

  it("deletes attempts whose window has closed", async () => {
    const stale = await pairing.create(attemptInput());

    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    await pairing.create(attemptInput());

    const remaining = await pool.query("SELECT 1 FROM app.companion_pair_attempts WHERE id = $1", [
      stale.attemptId
    ]);
    expect(remaining.rows).toHaveLength(0);
  });
});

describe("redeeming an attempt", () => {
  it("returns pending while the browser has not decided", async () => {
    const created = await pairing.create(attemptInput());
    const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    expect(result).toEqual({ status: "pending" });
    expect(await countDevices()).toBe(0);
  });

  it("returns denied and mints nothing after the browser refuses", async () => {
    const created = await pairing.create(attemptInput());
    const decided = await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "deny",
      actorUserId: userId
    });
    expect(decided).toEqual({ ok: true, decision: "deny" });

    const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    expect(result).toEqual({ status: "denied" });
    expect(await countDevices()).toBe(0);
  });

  it("issues a credential once the browser approves, and stores only its digest", async () => {
    const created = await pairing.create(attemptInput({ deviceName: "Approved Mac" }));
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    if (result.status !== "issued") throw new Error(`expected issued, got ${result.status}`);

    expect(result.response.credential.startsWith(COMPANION_CREDENTIAL_PREFIX)).toBe(true);
    expect(result.response.device.displayName).toBe("Approved Mac");
    expect(result.response.account.email).toBe("companion-pairing@example.test");

    const stored = await pool.query<{ credential_hash: string; user_id: string }>(
      "SELECT credential_hash, user_id FROM app.companion_devices WHERE id = $1",
      [result.response.device.id]
    );
    expect(stored.rows[0]?.credential_hash).toBe(sha256Base64url(result.response.credential));
    expect(stored.rows[0]?.credential_hash).not.toBe(result.response.credential);
    expect(stored.rows[0]?.user_id).toBe(userId);

    const attempt = await pool.query<{ status: string }>(
      "SELECT status FROM app.companion_pair_attempts WHERE id = $1",
      [created.attemptId]
    );
    expect(attempt.rows[0]?.status).toBe("redeemed");
  });

  it("refuses a second redemption of the same approval", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });
    await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });

    const second = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    expect(second).toEqual({ status: "redeemed" });
  });

  it("refuses a caller who has the attempt id but not the verifier", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    const before = await countDevices();
    const result = await pairing.redeem({
      attemptId: created.attemptId,
      verifier: "w".repeat(43)
    });

    // Same answer a nonexistent attempt gets, so the public id leaks nothing.
    expect(result).toEqual({ status: "unknown" });
    expect(await countDevices()).toBe(before);

    const attempt = await pool.query<{ status: string }>(
      "SELECT status FROM app.companion_pair_attempts WHERE id = $1",
      [created.attemptId]
    );
    expect(attempt.rows[0]?.status).toBe("approved");
  });

  it("answers an unknown attempt id exactly as it answers a wrong verifier", async () => {
    const result = await pairing.redeem({
      attemptId: "00000000-0000-4000-8000-00000000dead",
      verifier: VERIFIER
    });
    expect(result).toEqual({ status: "unknown" });
  });

  it("refuses an approval that sat past its window", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    clock = new Date(clock.getTime() + 11 * 60 * 1000);
    const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    expect(result).toEqual({ status: "expired" });
    clock = new Date(clock.getTime() - 11 * 60 * 1000);
  });

  it("mints exactly one credential when two redemptions race", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    const before = await countDevices();
    const [first, second] = await Promise.all([
      pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER }),
      pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER })
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["issued", "redeemed"]);
    expect(await countDevices()).toBe(before + 1);
  });
});

describe("deciding an attempt", () => {
  it("binds the approving account from the caller, not from the attempt", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: otherUserId
    });

    const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
    if (result.status !== "issued") throw new Error(`expected issued, got ${result.status}`);
    expect(result.response.account.email).toBe("companion-pairing-other@example.test");
  });

  it("refuses to decide an attempt twice", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    const second = await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "deny",
      actorUserId: otherUserId
    });
    expect(second).toEqual({ ok: false, reason: "not_pending" });
  });

  it("reports an unknown code as unknown", async () => {
    const result = await pairing.decide({
      approvalCode: "no-such-code-value-here",
      decision: "approve",
      actorUserId: userId
    });
    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  it("hides a redeemed attempt from the browser summary", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });
    await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });

    expect(await pairing.summarize({ approvalCode: created.approvalCode })).toBeNull();
  });

  it("shows the browser the device name waiting for a decision", async () => {
    const created = await pairing.create(attemptInput({ deviceName: "Kitchen iMac" }));
    expect(await pairing.summarize({ approvalCode: created.approvalCode })).toEqual({
      deviceName: "Kitchen iMac",
      status: "pending"
    });
  });
});

describe("cancelling an attempt", () => {
  it("removes an approved attempt so a late browser decision cannot resurrect it", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.decide({
      approvalCode: created.approvalCode,
      decision: "approve",
      actorUserId: userId
    });

    const before = await countDevices();
    await pairing.cancel({ attemptId: created.attemptId, verifier: VERIFIER });

    expect(await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER })).toEqual({
      status: "unknown"
    });
    expect(
      await pairing.decide({
        approvalCode: created.approvalCode,
        decision: "approve",
        actorUserId: userId
      })
    ).toEqual({ ok: false, reason: "unknown" });
    expect(await countDevices()).toBe(before);
  });

  it("ignores a cancel from a caller without the verifier", async () => {
    const created = await pairing.create(attemptInput());
    await pairing.cancel({ attemptId: created.attemptId, verifier: "w".repeat(43) });

    const remaining = await pool.query("SELECT 1 FROM app.companion_pair_attempts WHERE id = $1", [
      created.attemptId
    ]);
    expect(remaining.rows).toHaveLength(1);
  });
});
