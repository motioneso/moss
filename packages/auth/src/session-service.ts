import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type pg from "pg";

import { isUuid } from "@moss/db";
import type { MeSessionsService } from "@moss/settings";
import {
  COMPANION_PRODUCT_NAME,
  type MeSessionDeviceKind,
  type MeSessionDto,
  type MeSessionSource
} from "@moss/shared";

import { readBearerToken, toWebHeaders } from "./headers.js";

/**
 * The auth-runtime alias of the settings-owned port. Keeping it an alias guarantees the
 * implementation here and the consumer contract in `@moss/settings` never drift.
 */
export type MeSessionsRuntimeService = MeSessionsService;

/**
 * One-way public handle for a legacy bearer/CLI session. CRITICAL: `app.auth_sessions.id` IS
 * the bearer token secret (migration 0046 — its id column is the credential), so it must NEVER
 * be emitted to a client. We expose `sha256(id)` instead: a stable, preimage-resistant handle
 * the client can use to identify and revoke the session without ever holding the secret. Revoke
 * resolves it back to the real id by re-hashing the actor's own rows. (Cookie sessions in
 * `better_auth_sessions` are addressed by their non-secret row id directly — the secret there is
 * the separate `token` column, which is never selected.)
 */
function bearerSessionHandle(realId: string): string {
  return createHash("sha256").update(realId).digest("hex");
}

// Minimal structural slice of the Better Auth instance this service needs. Avoids coupling
// to better-auth's exported generics; the real `auth` object is assignable to it.
interface AuthSessionReader {
  readonly api: {
    getSession(options: {
      headers: Headers;
    }): Promise<{ session?: { id?: string | null } | null } | null>;
  };
}

interface SessionRow {
  readonly id: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly source: "cookie" | "bearer" | "companion";
  /** Companion rows only; null on every other source. */
  readonly display_name: string | null;
  readonly app_version: string | null;
  readonly os_version: string | null;
}

/**
 * Current-user session list/revoke service (#237). This is the ONLY code that reads or
 * mutates the session tables for the account-settings surface. Hard rules it enforces:
 *   - every query is scoped to the actor's `user_id` (a guessed/cross-user id matches no row);
 *   - the session `token` column is never selected or returned;
 *   - the request's current session is resolved from headers (cookie session id, or the
 *     legacy bearer token which IS an `auth_sessions` id) and never deleted by bulk revoke;
 *   - both cookie sessions (`app.better_auth_sessions`, rich metadata) and legacy bearer/CLI
 *     sessions (`app.auth_sessions`, minimal metadata) are listed and revocable.
 * Runs on the auth pool (jarvis_auth_runtime) — the same role the admin revoke already uses.
 */
export function createMeSessionsService(deps: {
  readonly pool: pg.Pool;
  readonly auth: AuthSessionReader;
}): MeSessionsRuntimeService {
  const { pool, auth } = deps;

  async function resolveCurrentSessionId(headers: IncomingHttpHeaders): Promise<string | null> {
    const webHeaders = toWebHeaders(headers);
    const bearer = readBearerToken(webHeaders);
    if (bearer) {
      // The bearer token IS an app.auth_sessions id (see #113 path). A non-UUID could never
      // have authenticated, but normalize defensively so it can't reach a uuid cast.
      return isUuid(bearer) ? bearer : null;
    }
    const session = await auth.api.getSession({ headers: webHeaders });
    const id = session?.session?.id;
    return typeof id === "string" && isUuid(id) ? id : null;
  }

  return {
    async list({ actorUserId, headers }) {
      const currentSessionId = await resolveCurrentSessionId(headers);
      // Token column is deliberately excluded from the projection — never selected.
      const result = await pool.query<SessionRow>(
        `SELECT id, created_at, updated_at, expires_at, ip_address, user_agent, 'cookie' AS source,
                NULL::text AS display_name, NULL::text AS app_version, NULL::text AS os_version
           FROM app.better_auth_sessions
          WHERE user_id = $1 AND expires_at > now()
         UNION ALL
         SELECT id, created_at, NULL::timestamptz AS updated_at, expires_at,
                NULL::text AS ip_address, NULL::text AS user_agent, 'bearer' AS source,
                NULL::text AS display_name, NULL::text AS app_version, NULL::text AS os_version
           FROM app.auth_sessions
          WHERE user_id = $1 AND expires_at > now()
         UNION ALL
         SELECT id, created_at, last_contact_at AS updated_at, expires_at,
                NULL::text AS ip_address, NULL::text AS user_agent, 'companion' AS source,
                display_name, app_version, os_version
           FROM app.companion_devices
          WHERE user_id = $1 AND expires_at > now() AND absolute_expires_at > now()`,
        [actorUserId]
      );

      const sessions = result.rows.map((row) => toDto(row, currentSessionId));
      // Current session first, then most-recently-seen first.
      return sessions.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      });
    },

    async revokeOne({ actorUserId, sessionId, headers }) {
      const currentRealId = await resolveCurrentSessionId(headers);

      // Cookie sessions are addressed by their (non-secret) UUID row id. A bearer handle is a
      // sha256 hex, never a UUID, so the format unambiguously selects the path. Note: a raw
      // bearer secret (also a UUID) passed here lands on the cookie path and matches nothing —
      // it can never delete its auth_sessions row by raw id, only via the resolved handle below.
      if (isUuid(sessionId)) {
        // Refuse current-session revoke through this surface, BEFORE any delete.
        if (currentRealId && sessionId === currentRealId) {
          return { revoked: false, wasCurrent: true };
        }
        // user_id scoping is the cross-user guard: another user's id deletes zero rows.
        const cookie = await pool.query(
          "DELETE FROM app.better_auth_sessions WHERE id = $1 AND user_id = $2",
          [sessionId, actorUserId]
        );
        if ((cookie.rowCount ?? 0) > 0) return { revoked: true, wasCurrent: false };

        // A companion device is also addressed by its non-secret row id (#2560). Deleting
        // the row is the whole revocation: the credential only exists as a hash in it.
        const companion = await pool.query(
          "DELETE FROM app.companion_devices WHERE id = $1 AND user_id = $2",
          [sessionId, actorUserId]
        );
        return { revoked: (companion.rowCount ?? 0) > 0, wasCurrent: false };
      }

      // Bearer handle path: resolve sha256(id) back to the real id among THIS actor's own,
      // non-expired bearer sessions (the cross-user/expiry guard), then delete by real id.
      const candidates = await pool.query<{ id: string }>(
        "SELECT id FROM app.auth_sessions WHERE user_id = $1 AND expires_at > now()",
        [actorUserId]
      );
      const match = candidates.rows.find((row) => bearerSessionHandle(row.id) === sessionId);
      if (!match) {
        return { revoked: false, wasCurrent: false };
      }
      if (currentRealId && match.id === currentRealId) {
        return { revoked: false, wasCurrent: true };
      }
      const bearer = await pool.query(
        "DELETE FROM app.auth_sessions WHERE id = $1 AND user_id = $2",
        [match.id, actorUserId]
      );
      return { revoked: (bearer.rowCount ?? 0) > 0, wasCurrent: false };
    },

    async revokeOthers({ actorUserId, headers }) {
      const currentSessionId = await resolveCurrentSessionId(headers);
      // `id <> $2` with a null current id evaluates to NULL (never true), so a session we
      // failed to identify deletes NOTHING — the safe failure mode (never sign self out).
      // `expires_at > now()` keeps the deleted-count consistent with the (non-expired) list
      // the user is acting on; already-expired rows are cleaned up by normal expiry.
      const cookie = await pool.query(
        "DELETE FROM app.better_auth_sessions WHERE user_id = $1 AND id <> $2 AND expires_at > now()",
        [actorUserId, currentSessionId]
      );
      const bearer = await pool.query(
        "DELETE FROM app.auth_sessions WHERE user_id = $1 AND id <> $2 AND expires_at > now()",
        [actorUserId, currentSessionId]
      );
      // A companion device is never the current session, so "sign out everywhere else"
      // always unlinks every Mac.
      const companion = await pool.query(
        "DELETE FROM app.companion_devices WHERE user_id = $1 AND expires_at > now() AND absolute_expires_at > now()",
        [actorUserId]
      );
      return (cookie.rowCount ?? 0) + (bearer.rowCount ?? 0) + (companion.rowCount ?? 0);
    }
  };
}

function toDto(row: SessionRow, currentSessionId: string | null): MeSessionDto {
  const createdAt = toIso(row.created_at);
  const lastSeenAt = row.updated_at ? toIso(row.updated_at) : createdAt;
  const device = describeDevice(row);

  // Bearer rows: emit the one-way handle, never the raw id (which IS the secret). Cookie rows:
  // the row id is non-secret and safe to emit. `isCurrent` compares REAL ids internally.
  const publicId = row.source === "bearer" ? bearerSessionHandle(row.id) : row.id;

  return {
    id: publicId,
    isCurrent: currentSessionId !== null && row.id === currentSessionId,
    createdAt,
    lastSeenAt,
    expiresAt: toIso(row.expires_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    deviceLabel: device.deviceLabel,
    browser: device.browser,
    os: device.os,
    deviceKind: device.deviceKind,
    source: SOURCE_BY_ROW[row.source],
    companion:
      row.source === "companion"
        ? {
            product: COMPANION_PRODUCT_NAME,
            displayName: row.display_name ?? "Mac",
            appVersion: row.app_version,
            osVersion: row.os_version,
            lastContactAt: row.updated_at ? toIso(row.updated_at) : null
          }
        : null
  };
}

const SOURCE_BY_ROW: Record<SessionRow["source"], MeSessionSource> = {
  cookie: "browser",
  bearer: "cli",
  companion: "companion"
};

function describeDevice(row: SessionRow): {
  deviceLabel: string;
  browser: string | null;
  os: string | null;
  deviceKind: MeSessionDeviceKind;
} {
  if (row.source === "bearer") {
    return { deviceLabel: "CLI / API session", browser: null, os: null, deviceKind: "desktop" };
  }
  if (row.source === "companion") {
    // A linked Mac names itself, so the user recognises the row without a user agent.
    return {
      deviceLabel: row.display_name ?? "Mac",
      browser: null,
      os: "macOS",
      deviceKind: "laptop"
    };
  }
  return parseUserAgent(row.user_agent);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Basic, dependency-free user-agent parsing for display labels (V1 — correctness of access
 * control matters more than polished parsing, per the spec build notes). Falls back to safe
 * generic labels when the UA is missing or unrecognized.
 */
function parseUserAgent(userAgent: string | null): {
  deviceLabel: string;
  browser: string | null;
  os: string | null;
  deviceKind: MeSessionDeviceKind;
} {
  if (!userAgent) {
    return { deviceLabel: "Unknown device", browser: null, os: null, deviceKind: "desktop" };
  }
  const os = detectOs(userAgent);
  const browser = detectBrowser(userAgent);
  const deviceKind = detectDeviceKind(userAgent);
  const deviceLabel = buildDeviceLabel(deviceKind, os);
  return { deviceLabel, browser, os, deviceKind };
}

function detectOs(ua: string): string | null {
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/linux/i.test(ua)) return "Linux";
  return null;
}

function detectBrowser(ua: string): string | null {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/chrome\/|crios/i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua)) return "Safari";
  return null;
}

function detectDeviceKind(ua: string): MeSessionDeviceKind {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/iphone|ipod|android.*mobile|mobile/i.test(ua)) return "phone";
  if (/macintosh|mac os x/i.test(ua)) return "laptop";
  return "desktop";
}

function buildDeviceLabel(kind: MeSessionDeviceKind, os: string | null): string {
  if (os) {
    if (os === "iOS") return kind === "tablet" ? "iPad" : "iPhone";
    if (os === "macOS") return "Mac";
    if (os === "Windows") return "Windows PC";
    if (os === "Android") return kind === "tablet" ? "Android tablet" : "Android phone";
    return `${os} device`;
  }
  return kind === "phone" ? "Mobile device" : "Unknown device";
}
