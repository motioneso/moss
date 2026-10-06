import { captureMetadataJson } from "./capture-metadata.js";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  MEETING_CAPTURE_LEASE_MS,
  type MeetingCaptureCancelStartInput,
  type MeetingCaptureInventory
} from "@moss/shared";
import {
  expireCaptureLease,
  MeetingCaptureError,
  type CaptureStoredState
} from "./capture-domain.js";
import { captureState, MeetingCaptureRepository, type CaptureGrant } from "./capture-repository.js";

export interface CaptureConnection {
  owner_user_id: string;
  device_id: string;
  connection_id: string;
  device_name: string;
  verifier_hash: string;
  capability_revision: number;
  revision: number;
  inventory_json: string;
  last_seen_at: Date;
  expires_at: Date;
}
/** Connection identities and exact Start commands are module-owned, owner-scoped metadata. */
export class MeetingCaptureConnectionRepository {
  async lock(db: DataContextDb, deviceId: string) {
    assertDataContextDb(db);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('meeting-device:' || ${deviceId}::uuid::text,0))`.execute(
      db.db
    );
  }
  async connection(db: DataContextDb, deviceId: string): Promise<CaptureConnection | null> {
    assertDataContextDb(db);
    return (
      (
        await sql<CaptureConnection>`SELECT * FROM app.meeting_capture_connections WHERE device_id=${deviceId}::uuid`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async connections(db: DataContextDb): Promise<CaptureConnection[]> {
    assertDataContextDb(db);
    return (
      await sql<CaptureConnection>`SELECT * FROM app.meeting_capture_connections ORDER BY last_seen_at DESC LIMIT 32`.execute(
        db.db
      )
    ).rows;
  }
  async register(
    db: DataContextDb,
    input: {
      deviceId: string;
      connectionId: string;
      deviceName: string;
      verifierHash: string;
      capabilityRevision: number;
      inventory: MeetingCaptureInventory;
      at: Date;
      expiresAt: Date;
    }
  ): Promise<CaptureConnection> {
    const current = await this.connection(db, input.deviceId);
    if (
      current?.connection_id === input.connectionId &&
      current.verifier_hash !== input.verifierHash
    )
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    if (
      current &&
      (current.connection_id !== input.connectionId ||
        current.capability_revision !== input.capabilityRevision)
    ) {
      await sql`UPDATE app.meeting_capture_grants SET status='revoked' WHERE device_id=${input.deviceId}::uuid AND status NOT IN ('revoked','complete')`.execute(
        db.db
      );
    }
    const inventory = captureMetadataJson(input.inventory);
    const revision =
      current && current.connection_id === input.connectionId
        ? current.revision +
          (current.capability_revision === input.capabilityRevision &&
          current.inventory_json === inventory
            ? 0
            : 1)
        : 1;
    const result =
      await sql<CaptureConnection>`INSERT INTO app.meeting_capture_connections (device_id,connection_id,device_name,verifier_hash,capability_revision,revision,inventory_json,last_seen_at,expires_at)
      VALUES (${input.deviceId}::uuid,${input.connectionId}::uuid,${input.deviceName},${input.verifierHash},${input.capabilityRevision},${revision},${inventory},${input.at},${input.expiresAt})
      ON CONFLICT (owner_user_id,device_id) DO UPDATE SET connection_id=excluded.connection_id,device_name=excluded.device_name,verifier_hash=excluded.verifier_hash,capability_revision=excluded.capability_revision,revision=excluded.revision,inventory_json=excluded.inventory_json,last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at RETURNING *`.execute(
        db.db
      );
    return result.rows[0]!;
  }
  async retire(db: DataContextDb, deviceId: string, at: Date) {
    const abandoned =
      await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE device_id=${deviceId}::uuid AND status='active' AND state_json::jsonb->>'desired'<>'stopped' AND coalesce(state_json::jsonb->>'lastSeenAt',state_json::jsonb->>'originAt')::timestamptz<=${new Date(at.getTime() - MEETING_CAPTURE_LEASE_MS)} FOR UPDATE`.execute(
        db.db
      );
    const grants = new MeetingCaptureRepository();
    for (const grant of abandoned.rows) {
      const state = captureState(grant);
      expireCaptureLease(state, at, grant.expires_at);
      state.desired = "revoked";
      await grants.save(db, grant, state);
    }
    await sql`UPDATE app.meeting_capture_grants SET status='revoked' WHERE device_id=${deviceId}::uuid AND (expires_at<=${at} OR (status='approved' AND state_json::jsonb->>'desired'<>'paused' AND claim_expires_at<=${at})) AND status NOT IN ('complete','revoked')`.execute(
      db.db
    );
    await sql`UPDATE app.meeting_capture_grants SET status='complete' WHERE device_id=${deviceId}::uuid AND status IN ('active','finalizing') AND state_json::jsonb->>'desired'='stopped' AND (state_json::jsonb->>'finalizationDeadline')::timestamptz<=${at}`.execute(
      db.db
    );
  }
  async occupied(db: DataContextDb, deviceId: string, connectionId: string): Promise<boolean> {
    return (
      (
        await sql`SELECT 1 FROM app.meeting_capture_grants WHERE device_id=${deviceId}::uuid AND connection_id=${connectionId}::uuid AND status IN ('approved','active','finalizing') LIMIT 1`.execute(
          db.db
        )
      ).rows.length > 0
    );
  }
  async occupyingGrant(
    db: DataContextDb,
    connection: CaptureConnection,
    at: Date
  ): Promise<CaptureGrant | null> {
    return (
      (
        await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE device_id=${connection.device_id}::uuid AND connection_id=${connection.connection_id}::uuid AND status IN ('approved','active','finalizing') AND expires_at>${at} AND (status<>'approved' OR state_json::jsonb->>'desired'='paused' OR claim_expires_at>${at}) AND (state_json::jsonb->>'desired'<>'stopped' OR (state_json::jsonb->>'finalizationDeadline')::timestamptz>${at}) ORDER BY created_at DESC LIMIT 1`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async cancelled(db: DataContextDb, requestKey: string): Promise<boolean> {
    return (
      (
        await sql`SELECT 1 FROM app.meeting_capture_start_cancellations WHERE request_key=${requestKey}::uuid`.execute(
          db.db
        )
      ).rows.length > 0
    );
  }
  async cancel(db: DataContextDb, meetingId: string, input: MeetingCaptureCancelStartInput) {
    const existing = await sql<{
      meeting_id: string;
      device_id: string;
      connection_id: string;
    }>`SELECT meeting_id,device_id,connection_id FROM app.meeting_capture_start_cancellations WHERE request_key=${input.requestKey}::uuid`.execute(
      db.db
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.meeting_id !== meetingId ||
        row.device_id !== input.deviceId ||
        row.connection_id !== input.connectionId
      )
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      return;
    }
    await sql`INSERT INTO app.meeting_capture_start_cancellations (request_key,meeting_id,device_id,connection_id) VALUES (${input.requestKey}::uuid,${meetingId}::uuid,${input.deviceId}::uuid,${input.connectionId}::uuid)`.execute(
      db.db
    );
  }
  async byRequest(db: DataContextDb, requestKey: string): Promise<CaptureGrant | null> {
    return (
      (
        await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE start_request_key=${requestKey}::uuid`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async command(
    db: DataContextDb,
    connection: CaptureConnection,
    at: Date
  ): Promise<CaptureGrant | null> {
    return (
      (
        await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE device_id=${connection.device_id}::uuid AND connection_id=${connection.connection_id}::uuid AND capability_revision=${connection.capability_revision} AND status='approved' AND state_json::jsonb->>'desired'='recording' AND claim_expires_at>${at} AND expires_at>${at} ORDER BY created_at LIMIT 1`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async create(
    db: DataContextDb,
    input: {
      meetingId: string;
      sessionId: string;
      connection: CaptureConnection;
      requestKey: string;
      fingerprint: string;
      expiresAt: Date;
      claimExpiresAt: Date;
      state: CaptureStoredState;
    }
  ): Promise<CaptureGrant> {
    const c = input.connection;
    return (
      await sql<CaptureGrant>`INSERT INTO app.meeting_capture_grants (meeting_id,device_id,device_name,verifier_hash,session_id,status,expires_at,state_json,connection_id,capability_revision,claim_expires_at,start_request_key,start_fingerprint)
      VALUES (${input.meetingId}::uuid,${c.device_id}::uuid,${c.device_name},${c.verifier_hash},${input.sessionId}::uuid,'approved',${input.expiresAt},${JSON.stringify(input.state)},${c.connection_id}::uuid,${c.capability_revision},${input.claimExpiresAt},${input.requestKey}::uuid,${input.fingerprint}) RETURNING *`.execute(
        db.db
      )
    ).rows[0]!;
  }
}
