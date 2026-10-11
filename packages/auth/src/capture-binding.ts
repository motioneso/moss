import type pg from "pg";
import type { AbortablePgPool } from "@moss/db";
import { SessionBindingError } from "./session-bindings.js";
import { RecordingCapabilityError } from "./recording-capability-error.js";

export interface CaptureBindingInput {
  readonly actorUserId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly capabilityRevision: number;
}
export interface CaptureBindingLease {
  /** Release only after the caller's bounded database transaction has committed or rolled back. */
  release(): Promise<void>;
}

/** Auth-owned row fence; it never reads a module table or receives module data. */
export async function acquireCaptureBinding(
  pool: pg.Pool,
  input: CaptureBindingInput
): Promise<CaptureBindingLease> {
  const client = await pool.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      // No writes: rollback releases the fence even after the caller failed.
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
  try {
    await client.query("BEGIN");
    // SHARE also blocks non-key updates to status, expiry, owner and capability revision.
    // KEY SHARE would allow NO KEY UPDATE and would not protect these authorization predicates.
    // NOWAIT keeps concurrent logout/revoke from occupying the auth pool while capture
    // holds its own module locks. A contended fence fails temporarily, never as revoked.
    const user = await client.query(
      "SELECT id FROM app.users WHERE id=$1 AND status='active' FOR SHARE NOWAIT",
      [input.actorUserId]
    );
    const session = await client.query(
      "SELECT id FROM app.better_auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE NOWAIT",
      [input.sessionId, input.actorUserId]
    );
    if (!user.rows.length || !session.rows.length) throw new SessionBindingError("session-ended");
    const device = await client.query(
      "SELECT id FROM app.companion_devices WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp() FOR SHARE NOWAIT",
      [input.deviceId, input.actorUserId]
    );
    if (!device.rows.length) throw new SessionBindingError("device-unavailable");
    const capability = await client.query(
      "SELECT device_id FROM app.companion_recording_capabilities WHERE device_id=$1 AND owner_user_id=$2 AND revision=$3 AND revoked_at IS NULL AND policy_version=1 FOR SHARE NOWAIT",
      [input.deviceId, input.actorUserId, input.capabilityRevision]
    );
    if (!capability.rows.length) throw new RecordingCapabilityError();
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** Bounded auth-owned maintenance pool; no returned authority. */
export async function probeCaptureBinding(
  pool: AbortablePgPool,
  input: CaptureBindingInput,
  signal: AbortSignal
): Promise<void> {
  return pool.withClient(signal, async (client) => {
    const result = await client.query<{
      session_live: boolean;
      device_live: boolean;
      capability_live: boolean;
    }>(
      `
      SELECT EXISTS(SELECT 1 FROM app.better_auth_sessions s JOIN app.users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>clock_timestamp() AND u.status='active') AS session_live,
      EXISTS(SELECT 1 FROM app.companion_devices WHERE id=$3 AND user_id=$2
        AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()) AS device_live,
      EXISTS(SELECT 1 FROM app.companion_recording_capabilities WHERE device_id=$3 AND owner_user_id=$2
        AND revision=$4 AND revoked_at IS NULL AND policy_version=1) AS capability_live`,
      [input.sessionId, input.actorUserId, input.deviceId, input.capabilityRevision]
    );
    signal.throwIfAborted();
    const row = result.rows[0];
    if (!row?.session_live) throw new SessionBindingError("session-ended");
    if (!row.device_live) throw new SessionBindingError("device-unavailable");
    if (!row.capability_live) throw new RecordingCapabilityError();
  });
}
