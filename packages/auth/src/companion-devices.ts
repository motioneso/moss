import type { IncomingHttpHeaders } from "node:http";

import type pg from "pg";

import {
  COMPANION_CREDENTIAL_PREFIX,
  type CompanionErrorCode,
  type CompanionHeartbeatRequest,
  type CompanionHeartbeatResponse
} from "@moss/shared";

import { sha256Base64url } from "./companion-crypto.js";

/**
 * The authenticated half of the Trail Marker companion (#2560).
 *
 * `resolve` is a separate resolver from `resolveAccessContext` and is wired only to
 * `/api/companion/*`. It reads a bearer credential and never a cookie, so a signed-in
 * browser cannot reach these operations, and a companion credential cannot reach any
 * other route: the general resolver hands every bearer token to the legacy UUID
 * session lookup, which rejects a `tm1_` value outright.
 *
 * Everything here is scoped to the caller's own device row. There is no operation that
 * names another device, another account, or any user content.
 */

const CREDENTIAL_INACTIVITY_DAYS = 90;

export interface CompanionContext {
  readonly actorUserId: string;
  readonly deviceId: string;
  readonly requestId: string;
}

export class CompanionAuthError extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    readonly httpStatus: 401 | 403
  ) {
    super(code);
    this.name = "CompanionAuthError";
  }
}

export interface CompanionDeviceSummary {
  readonly id: string;
  readonly displayName: string;
}

export interface CompanionDevicesService {
  resolve(input: { headers: IncomingHttpHeaders; requestId: string }): Promise<CompanionContext>;
  heartbeat(
    ctx: CompanionContext,
    input: CompanionHeartbeatRequest
  ): Promise<CompanionHeartbeatResponse>;
  rename(ctx: CompanionContext, displayName: string): Promise<CompanionDeviceSummary>;
  logout(ctx: CompanionContext): Promise<void>;
}

interface CompanionDevicesDeps {
  readonly pool: pg.Pool;
  readonly now?: () => Date;
}

interface ResolvedRow {
  readonly id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly user_status: string;
  readonly user_name: string | null;
  readonly user_email: string;
}

export function createCompanionDevicesService(deps: CompanionDevicesDeps): CompanionDevicesService {
  const { pool } = deps;
  const now = deps.now ?? (() => new Date());

  async function loadDevice(deviceId: string): Promise<ResolvedRow> {
    const result = await pool.query<ResolvedRow>(
      `SELECT d.id, d.user_id, d.display_name, d.expires_at, d.absolute_expires_at,
              u.status AS user_status, u.name AS user_name, u.email AS user_email
         FROM app.companion_devices d
         JOIN app.users u ON u.id = d.user_id
        WHERE d.id = $1`,
      [deviceId]
    );
    const row = result.rows[0];
    if (!row) throw new CompanionAuthError("companion_credential_invalid", 401);
    return row;
  }

  return {
    async resolve({ headers, requestId }) {
      const credential = readCompanionCredential(headers);
      if (!credential) throw new CompanionAuthError("companion_credential_invalid", 401);

      const at = now();

      // Expiry is enforced in the lookup itself, so an expired credential can never
      // reach the account-status check or any handler.
      const result = await pool.query<ResolvedRow>(
        `SELECT d.id, d.user_id, d.display_name, d.expires_at, d.absolute_expires_at,
                u.status AS user_status, u.name AS user_name, u.email AS user_email
           FROM app.companion_devices d
           JOIN app.users u ON u.id = d.user_id
          WHERE d.credential_hash = $1
            AND d.expires_at > $2
            AND d.absolute_expires_at > $2`,
        [sha256Base64url(credential), at]
      );

      const row = result.rows[0];
      if (!row) throw new CompanionAuthError("companion_credential_invalid", 401);
      if (row.user_status === "pending") {
        throw new CompanionAuthError("account_pending_approval", 403);
      }
      if (row.user_status === "deactivated") {
        throw new CompanionAuthError("account_deactivated", 403);
      }

      // Slide the inactivity window forward, never past the absolute ceiling.
      const slid = new Date(at.getTime() + CREDENTIAL_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);
      const nextExpiry = slid < row.absolute_expires_at ? slid : row.absolute_expires_at;
      await pool.query("UPDATE app.companion_devices SET expires_at = $1 WHERE id = $2", [
        nextExpiry,
        row.id
      ]);

      return { actorUserId: row.user_id, deviceId: row.id, requestId };
    },

    async heartbeat(ctx, input) {
      // Records reachability and the app's reported versions. No activity event: a
      // heartbeat is not something the user did.
      await pool.query(
        `UPDATE app.companion_devices
            SET last_contact_at = $1, app_version = $2, os_version = $3
          WHERE id = $4 AND user_id = $5`,
        [now(), input.appVersion, input.osVersion, ctx.deviceId, ctx.actorUserId]
      );

      const row = await loadDevice(ctx.deviceId);
      return {
        device: { id: row.id, displayName: row.display_name },
        account: { name: row.user_name ?? row.user_email, email: row.user_email },
        serverTime: now().toISOString(),
        expiresAt: row.expires_at.toISOString()
      };
    },

    async rename(ctx, displayName) {
      const result = await pool.query<{ id: string; display_name: string }>(
        `UPDATE app.companion_devices
            SET display_name = $1
          WHERE id = $2 AND user_id = $3
          RETURNING id, display_name`,
        [displayName, ctx.deviceId, ctx.actorUserId]
      );
      const row = result.rows[0];
      if (!row) throw new CompanionAuthError("companion_credential_invalid", 401);
      return { id: row.id, displayName: row.display_name };
    },

    async logout(ctx) {
      // Deleting the row is the revocation. Nothing is retained to retry with.
      await pool.query("DELETE FROM app.companion_devices WHERE id = $1 AND user_id = $2", [
        ctx.deviceId,
        ctx.actorUserId
      ]);
    }
  };
}

/**
 * Reads a companion bearer credential. The prefix check keeps a browser session token
 * or a legacy CLI bearer from even reaching the device lookup.
 */
function readCompanionCredential(headers: IncomingHttpHeaders): string | null {
  const header = headers.authorization;
  if (typeof header !== "string") return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;
  if (!token.startsWith(COMPANION_CREDENTIAL_PREFIX)) return null;
  return token;
}
