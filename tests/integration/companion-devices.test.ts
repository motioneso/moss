import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  CompanionAuthError,
  createCompanionDevicesService,
  createCompanionPairingService,
  sha256Base64url,
  type CompanionContext,
  type CompanionDevicesService,
  type CompanionPairingService
} from "@moss/auth";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client, Pool } = pg;

// What a linked Mac may do (#2560). The credential authorizes identity and this one
// device's own connection, nothing else, and it stops working the moment it expires or
// the account stops being eligible.

const activeUserId = "00000000-0000-4000-8000-0000000025b0";
const pendingUserId = "00000000-0000-4000-8000-0000000025b1";
const deactivatedUserId = "00000000-0000-4000-8000-0000000025b2";

let pool: pg.Pool;
let bootstrapClient: pg.Client;
let pairing: CompanionPairingService;
let devices: CompanionDevicesService;

let clock = new Date("2026-09-20T09:00:00.000Z");
const now = () => clock;

const VERIFIER = "v".repeat(43);

/** Runs a full browser-approved link and hands back the credential the Mac would hold. */
async function linkDevice(
  userId: string,
  deviceName = "Studio Mac"
): Promise<{ credential: string; deviceId: string }> {
  const created = await pairing.create({
    deviceName,
    platform: "macos",
    appVersion: "1.0.0",
    osVersion: "14.5",
    verifierHash: sha256Base64url(VERIFIER)
  });
  await pairing.decide({
    approvalCode: created.approvalCode,
    decision: "approve",
    actorUserId: userId
  });
  const result = await pairing.redeem({ attemptId: created.attemptId, verifier: VERIFIER });
  if (result.status !== "issued") throw new Error(`link failed: ${result.status}`);
  return { credential: result.response.credential, deviceId: result.response.device.id };
}

function bearer(credential: string) {
  return { headers: { authorization: `Bearer ${credential}` }, requestId: "req-test" };
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: string,
  httpStatus: number
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CompanionAuthError);
  await promise.catch((error: unknown) => {
    const authError = error as CompanionAuthError;
    expect(authError.code).toBe(code);
    expect(authError.httpStatus).toBe(httpStatus);
  });
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();

  bootstrapClient = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrapClient.connect();
  await bootstrapClient.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
     VALUES ($1, 'companion-active@example.test',      'Active Owner',      false, false, 'active'),
            ($2, 'companion-pending@example.test',     'Pending Owner',     false, false, 'pending'),
            ($3, 'companion-deactivated@example.test', 'Deactivated Owner', false, false, 'deactivated')`,
    [activeUserId, pendingUserId, deactivatedUserId]
  );

  pool = new Pool({ connectionString: connectionStrings.auth, max: 4 });
  pairing = createCompanionPairingService({ pool, now });
  devices = createCompanionDevicesService({ pool, now });
});

afterAll(async () => {
  await Promise.allSettled([bootstrapClient?.end(), pool?.end()]);
});

describe("resolving a companion credential", () => {
  it("identifies the device and the account that approved it", async () => {
    const { credential, deviceId } = await linkDevice(activeUserId);
    const ctx = await devices.resolve(bearer(credential));
    expect(ctx).toEqual({ actorUserId: activeUserId, deviceId, requestId: "req-test" });
  });

  it("refuses a request with no credential at all", async () => {
    await expectAuthError(
      devices.resolve({ headers: {}, requestId: "req-test" }),
      "companion_credential_invalid",
      401
    );
  });

  it("refuses a bearer token that is not a companion credential", async () => {
    // A browser or legacy CLI session token reaching this resolver must get nowhere.
    await expectAuthError(
      devices.resolve(bearer("4e0d2a1c-0000-4000-8000-000000000000")),
      "companion_credential_invalid",
      401
    );
  });

  it("refuses a credential that was never issued", async () => {
    await expectAuthError(
      devices.resolve(bearer(`tm1_${"z".repeat(43)}`)),
      "companion_credential_invalid",
      401
    );
  });

  it("refuses a credential whose inactivity window has closed", async () => {
    const { credential } = await linkDevice(activeUserId);

    clock = new Date(clock.getTime() + 91 * 24 * 60 * 60 * 1000);
    await expectAuthError(devices.resolve(bearer(credential)), "companion_credential_invalid", 401);
    clock = new Date(clock.getTime() - 91 * 24 * 60 * 60 * 1000);
  });

  it("refuses a credential past its absolute ceiling even if recently used", async () => {
    const { credential, deviceId } = await linkDevice(activeUserId);

    // Simulate a Mac that has kept the window sliding for a year.
    await pool.query(
      `UPDATE app.companion_devices
          SET expires_at = $1, absolute_expires_at = $2
        WHERE id = $3`,
      [new Date(clock.getTime() + 24 * 60 * 60 * 1000), new Date(clock.getTime() - 1000), deviceId]
    );

    await expectAuthError(devices.resolve(bearer(credential)), "companion_credential_invalid", 401);
  });

  it("refuses an account still waiting for approval", async () => {
    const { credential } = await linkDevice(pendingUserId);
    await expectAuthError(devices.resolve(bearer(credential)), "account_pending_approval", 403);
  });

  it("refuses a deactivated account", async () => {
    const { credential } = await linkDevice(deactivatedUserId);
    await expectAuthError(devices.resolve(bearer(credential)), "account_deactivated", 403);
  });

  it("slides the inactivity window forward on use, never past the ceiling", async () => {
    const { credential, deviceId } = await linkDevice(activeUserId);
    const ceiling = new Date(clock.getTime() + 2 * 24 * 60 * 60 * 1000);
    await pool.query("UPDATE app.companion_devices SET absolute_expires_at = $1 WHERE id = $2", [
      ceiling,
      deviceId
    ]);

    await devices.resolve(bearer(credential));

    const row = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM app.companion_devices WHERE id = $1",
      [deviceId]
    );
    expect(row.rows[0]?.expires_at.getTime()).toBe(ceiling.getTime());
  });
});

describe("own-device operations", () => {
  it("records reachability and returns the account identity", async () => {
    const { credential, deviceId } = await linkDevice(activeUserId, "Heartbeat Mac");
    const ctx = await devices.resolve(bearer(credential));

    const response = await devices.heartbeat(ctx, { appVersion: "1.1.0", osVersion: "15.0" });
    expect(response.device).toEqual({ id: deviceId, displayName: "Heartbeat Mac" });
    expect(response.account.email).toBe("companion-active@example.test");

    const row = await pool.query<{ last_contact_at: Date | null; app_version: string }>(
      "SELECT last_contact_at, app_version FROM app.companion_devices WHERE id = $1",
      [deviceId]
    );
    expect(row.rows[0]?.last_contact_at).not.toBeNull();
    expect(row.rows[0]?.app_version).toBe("1.1.0");
  });

  it("renames only the calling device", async () => {
    const mine = await linkDevice(activeUserId, "Mine");
    const theirs = await linkDevice(activeUserId, "Theirs");
    const ctx = await devices.resolve(bearer(mine.credential));

    await devices.rename(ctx, "Renamed");

    const rows = await pool.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM app.companion_devices WHERE id = ANY($1)",
      [[mine.deviceId, theirs.deviceId]]
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.display_name]));
    expect(byId.get(mine.deviceId)).toBe("Renamed");
    expect(byId.get(theirs.deviceId)).toBe("Theirs");
  });

  it("cannot act on a device belonging to another account", async () => {
    const mine = await linkDevice(activeUserId, "Mine Again");
    const ctx = await devices.resolve(bearer(mine.credential));

    // A context naming someone else's device id is the shape a stolen-id attack takes.
    const theirs = await linkDevice(pendingUserId, "Not Mine");
    const forged: CompanionContext = { ...ctx, deviceId: theirs.deviceId };

    await expectAuthError(devices.rename(forged, "Hijacked"), "companion_credential_invalid", 401);
    await devices.logout(forged);

    const survived = await pool.query("SELECT 1 FROM app.companion_devices WHERE id = $1", [
      theirs.deviceId
    ]);
    expect(survived.rows).toHaveLength(1);
  });

  it("logging out removes the credential and nothing works afterwards", async () => {
    const { credential, deviceId } = await linkDevice(activeUserId, "Logout Mac");
    const ctx = await devices.resolve(bearer(credential));

    await devices.logout(ctx);

    const row = await pool.query("SELECT 1 FROM app.companion_devices WHERE id = $1", [deviceId]);
    expect(row.rows).toHaveLength(0);
    await expectAuthError(devices.resolve(bearer(credential)), "companion_credential_invalid", 401);
  });

  it("two Macs sharing a display name stay separate rows", async () => {
    const first = await linkDevice(activeUserId, "MacBook Pro");
    const second = await linkDevice(activeUserId, "MacBook Pro");
    expect(first.deviceId).not.toBe(second.deviceId);

    const firstCtx = await devices.resolve(bearer(first.credential));
    await devices.logout(firstCtx);

    const survivor = await devices.resolve(bearer(second.credential));
    expect(survivor.deviceId).toBe(second.deviceId);
  });
});
