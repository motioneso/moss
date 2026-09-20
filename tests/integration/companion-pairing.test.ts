import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  createCompanionPairingService,
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

  it("puts the approval code in the browser path and nothing else", async () => {
    const created = await pairing.create(attemptInput());
    expect(created.approvalPath).toBe(
      `/link/trail-marker?code=${encodeURIComponent(created.approvalCode)}`
    );
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
