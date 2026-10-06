import type { IncomingHttpHeaders } from "node:http";
import type pg from "pg";
import { isUuid } from "@moss/db";
import { toWebHeaders } from "./headers.js";

export class SessionBindingError extends Error {
  readonly httpStatus = 403;
  constructor() {
    super("Session binding unavailable");
    this.name = "SessionBindingError";
  }
}

export interface BrowserSessionBinding {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}
/** Auth-owned, fresh existence checks. No session/device secrets are returned. */
export interface SessionBindingsService {
  resolveBrowser(input: {
    headers: IncomingHttpHeaders;
    requestId: string;
  }): Promise<BrowserSessionBinding>;
  assertLive(input: { actorUserId: string; sessionId?: string; deviceId?: string }): Promise<void>;
  device(input: {
    actorUserId: string;
    deviceId: string;
  }): Promise<{ displayName: string; expiresAt: Date }>;
}
interface SessionReader {
  readonly api: {
    getSession(input: { headers: Headers }): Promise<{
      session?: { id?: string | null } | null;
      user?: { id?: string | null } | null;
    } | null>;
  };
}
export function createSessionBindingsService(deps: {
  pool: pg.Pool;
  auth: SessionReader;
  now?: () => Date;
}): SessionBindingsService {
  const now = deps.now ?? (() => new Date());
  const unavailable = () => new SessionBindingError();
  async function session(actorUserId: string, sessionId: string) {
    const result = await deps.pool.query<{ expires_at: Date }>(
      `SELECT s.expires_at FROM app.better_auth_sessions s JOIN app.users u ON u.id=s.user_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>$3 AND u.status='active'`,
      [sessionId, actorUserId, now()]
    );
    const row = result.rows[0];
    if (!row) throw unavailable();
    return row;
  }
  async function device(input: { actorUserId: string; deviceId: string }) {
    const result = await deps.pool.query<{ display_name: string; expires_at: Date }>(
      `SELECT d.display_name, LEAST(d.expires_at,d.absolute_expires_at) AS expires_at
       FROM app.companion_devices d JOIN app.users u ON u.id=d.user_id
       WHERE d.id=$1 AND d.user_id=$2 AND d.expires_at>$3 AND d.absolute_expires_at>$3 AND u.status='active'`,
      [input.deviceId, input.actorUserId, now()]
    );
    const row = result.rows[0];
    if (!row) throw unavailable();
    return { displayName: row.display_name, expiresAt: row.expires_at };
  }
  return {
    async resolveBrowser({ headers, requestId }) {
      if (headers.authorization !== undefined || !headers.cookie) throw unavailable();
      const resolved = await deps.auth.api.getSession({ headers: toWebHeaders(headers) });
      const sessionId = resolved?.session?.id;
      const actorUserId = resolved?.user?.id;
      if (!sessionId || !actorUserId || !isUuid(sessionId) || !isUuid(actorUserId))
        throw unavailable();
      const row = await session(actorUserId, sessionId);
      return { actorUserId, requestId, sessionId, expiresAt: row.expires_at };
    },
    async assertLive(input) {
      if (!input.sessionId && !input.deviceId) throw unavailable();
      if (input.sessionId) await session(input.actorUserId, input.sessionId);
      if (input.deviceId)
        await device({ actorUserId: input.actorUserId, deviceId: input.deviceId });
    },
    device
  };
}
