import { createHash } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureAudioReceipt,
  MeetingCaptureState
} from "@moss/shared";
import {
  elapsed,
  MeetingCaptureError,
  retainCaptureGap,
  type CaptureStoredState
} from "./capture-domain.js";

export interface CaptureGrant {
  id: string;
  meeting_id: string;
  owner_user_id: string;
  device_id: string;
  device_name: string;
  verifier_hash: string;
  credential_hash: string | null;
  session_id: string | null;
  status: "pending" | "approved" | "active" | "revoked";
  created_at: Date;
  expires_at: Date;
  state_json: string | null;
}
export type CaptureLink = Pick<
  CaptureGrant,
  | "id"
  | "meeting_id"
  | "owner_user_id"
  | "device_id"
  | "device_name"
  | "verifier_hash"
  | "created_at"
  | "expires_at"
> & { status: "pending" | "approved" };
export interface CaptureReceipt {
  request_key: string;
  kind: "control" | "audio";
  fingerprint: string;
  metadata_json: string;
  result_json: string | null;
  created_at: Date;
}
export function captureState(grant: CaptureGrant): CaptureStoredState {
  if (!grant.state_json) throw new MeetingCaptureError();
  return JSON.parse(grant.state_json) as CaptureStoredState;
}
export function captureView(
  grant: CaptureGrant,
  state: CaptureStoredState,
  at: Date
): MeetingCaptureState {
  const epoch = state.epochs.at(-1);
  return {
    gaps: state.gaps,
    gapLimitReached: state.gapLimitReached,
    grantId: grant.id,
    deviceId: grant.device_id,
    deviceName: grant.device_name,
    generation: state.generation,
    epoch: epoch?.epoch ?? 0,
    desired: state.desired,
    selection: epoch?.selection ?? null,
    epochStartMs: epoch?.startMs ?? 0,
    epochEndMs: epoch?.endMs ?? null,
    stopCutoffMs: state.stopCutoffMs,
    finalizationDeadline: state.finalizationDeadline,
    expiresAt: grant.expires_at.toISOString(),
    serverTime: at.toISOString(),
    elapsedMs: elapsed(state, at),
    inventory: state.inventory,
    observed: state.observed,
    lastSeenAt: state.lastSeenAt
  };
}
/** Module-owned RLS only. Callers authenticate before passing a scoped transaction. */
export class MeetingCaptureRepository {
  async lockMeeting(db: DataContextDb, meetingId: string): Promise<void> {
    assertDataContextDb(db);
    const result =
      await sql`SELECT id FROM app.meeting_records WHERE id=${meetingId}::uuid FOR UPDATE`.execute(
        db.db
      );
    if (!result.rows.length) throw new MeetingCaptureError("meeting_capture_unavailable", 404);
  }
  async grants(db: DataContextDb, meetingId: string): Promise<CaptureGrant[]> {
    assertDataContextDb(db);
    return (
      await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE meeting_id=${meetingId}::uuid ORDER BY created_at DESC LIMIT 21`.execute(
        db.db
      )
    ).rows;
  }
  async grant(db: DataContextDb, id: string, lock = false): Promise<CaptureGrant | null> {
    assertDataContextDb(db);
    const result =
      await sql<CaptureGrant>`SELECT * FROM app.meeting_capture_grants WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
        db.db
      );
    return result.rows[0] ?? null;
  }
  async links(db: DataContextDb, meetingId: string): Promise<CaptureLink[]> {
    return (
      await sql<CaptureLink>`SELECT * FROM app.meeting_capture_links WHERE meeting_id=${meetingId}::uuid AND status='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 20`.execute(
        db.db
      )
    ).rows;
  }
  async link(db: DataContextDb, id: string, lock = false): Promise<CaptureLink | null> {
    return (
      (
        await sql<CaptureLink>`SELECT * FROM app.meeting_capture_links WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async createLink(
    db: DataContextDb,
    input: {
      meetingId: string;
      deviceId: string;
      deviceName: string;
      verifierHash: string;
      expiresAt: Date;
    }
  ): Promise<CaptureLink> {
    // Per-owner transaction lock bounds concurrent bootstrap requests without any meeting access.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id'),2981))`.execute(
      db.db
    );
    await sql`DELETE FROM app.meeting_capture_links WHERE expires_at<now()`.execute(db.db);
    const count = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_links`.execute(db.db);
    if (Number(count.rows[0]?.count) >= 20)
      throw new MeetingCaptureError("meeting_capture_limit", 413);
    const result =
      await sql<CaptureLink>`INSERT INTO app.meeting_capture_links (meeting_id,device_id,device_name,verifier_hash,expires_at) VALUES (${input.meetingId}::uuid,${input.deviceId}::uuid,${input.deviceName},${input.verifierHash},${input.expiresAt}) RETURNING *`.execute(
        db.db
      );
    return result.rows[0]!;
  }
  async approve(db: DataContextDb, link: CaptureLink, sessionId: string, expiresAt: Date) {
    await sql`INSERT INTO app.meeting_capture_grants (id,meeting_id,device_id,device_name,verifier_hash,session_id,status,created_at,expires_at) VALUES (${link.id}::uuid,${link.meeting_id}::uuid,${link.device_id}::uuid,${link.device_name},${link.verifier_hash},${sessionId}::uuid,'approved',${link.created_at},${expiresAt})`.execute(
      db.db
    );
    await sql`UPDATE app.meeting_capture_links SET status='approved' WHERE id=${link.id}::uuid`.execute(
      db.db
    );
  }
  async activate(
    db: DataContextDb,
    grant: CaptureGrant,
    credentialHash: string,
    state: CaptureStoredState
  ) {
    await sql`UPDATE app.meeting_capture_grants SET status='active',credential_hash=${credentialHash},state_json=${JSON.stringify(state)} WHERE id=${grant.id}::uuid`.execute(
      db.db
    );
  }
  async save(db: DataContextDb, grant: CaptureGrant, state: CaptureStoredState) {
    if (Buffer.byteLength(JSON.stringify(state)) > 500000)
      throw new MeetingCaptureError("meeting_capture_limit", 413);
    await sql`UPDATE app.meeting_capture_grants SET status=${state.desired === "revoked" ? "revoked" : grant.status},state_json=${JSON.stringify(state)} WHERE id=${grant.id}::uuid`.execute(
      db.db
    );
    grant.state_json = JSON.stringify(state);
    if (state.desired === "revoked") grant.status = "revoked";
  }
  async revokeExpired(db: DataContextDb, meetingId: string, at: Date) {
    await sql`UPDATE app.meeting_capture_grants SET status='revoked' WHERE meeting_id=${meetingId}::uuid AND expires_at<=${at} AND status<>'revoked'`.execute(
      db.db
    );
  }
  async receipt(
    db: DataContextDb,
    grantId: string,
    requestKey: string,
    fingerprint: string
  ): Promise<CaptureReceipt | null> {
    const result =
      await sql<CaptureReceipt>`SELECT * FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid AND request_key=${requestKey}::uuid`.execute(
        db.db
      );
    const row = result.rows[0];
    if (row && row.fingerprint !== fingerprint)
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    return row ?? null;
  }
  async reserve(
    db: DataContextDb,
    grantId: string,
    input: {
      requestKey: string;
      kind: "control" | "audio";
      fingerprint: string;
      metadata: object;
      result?: object;
    }
  ) {
    const count = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid`.execute(
      db.db
    );
    if (Number(count.rows[0]?.count) >= 4000)
      throw new MeetingCaptureError("meeting_capture_limit", 413);
    await sql`INSERT INTO app.meeting_capture_receipts (grant_id,request_key,kind,fingerprint,metadata_json,result_json) VALUES (${grantId}::uuid,${input.requestKey}::uuid,${input.kind},${input.fingerprint},${JSON.stringify(input.metadata)},${input.result ? JSON.stringify(input.result) : null})`.execute(
      db.db
    );
  }
  async admitAudio(
    db: DataContextDb,
    grant: CaptureGrant,
    input: MeetingCaptureAudioInput,
    fingerprint: string
  ) {
    // Serialize owner-level admission across meetings without holding a provider call open.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id'),2982))`.execute(
      db.db
    );
    const ownerPending = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_receipts WHERE kind='audio' AND result_json IS NULL AND created_at>now()-interval '60 seconds'`.execute(
      db.db
    );
    if (Number(ownerPending.rows[0]?.count) >= 2)
      throw new MeetingCaptureError("meeting_capture_busy", 409);
    const ownerRecent = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_receipts WHERE kind='audio' AND created_at>now()-interval '1 minute'`.execute(
      db.db
    );
    if (Number(ownerRecent.rows[0]?.count) >= 120)
      throw new MeetingCaptureError("meeting_capture_rate_limited", 429);
    const pending =
      await sql`SELECT 1 FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND result_json IS NULL LIMIT 1`.execute(
        db.db
      );
    if (pending.rows.length) throw new MeetingCaptureError("meeting_capture_busy", 409);
    const recent = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND created_at>now()-interval '1 minute'`.execute(
      db.db
    );
    if (Number(recent.rows[0]?.count) >= 120)
      throw new MeetingCaptureError("meeting_capture_rate_limited", 429);
    const previous = await sql<{
      sequence: number;
      end_ms: number;
    }>`SELECT (metadata_json::jsonb->>'sequence')::integer AS sequence,(metadata_json::jsonb->>'endMs')::integer AS end_ms FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND metadata_json::jsonb->>'sourceId'=${input.sourceId} AND (metadata_json::jsonb->>'epoch')::integer=${input.epoch} ORDER BY (metadata_json::jsonb->>'sequence')::integer DESC LIMIT 1`.execute(
      db.db
    );
    const last = previous.rows[0];
    if (input.sequence !== (last ? last.sequence + 1 : 0) || (last && input.startMs < last.end_ms))
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    await this.reserve(db, grant.id, {
      requestKey: input.requestKey,
      kind: "audio",
      fingerprint,
      metadata: {
        sourceId: input.sourceId,
        epoch: input.epoch,
        generation: input.generation,
        sequence: input.sequence,
        startMs: input.startMs,
        endMs: input.endMs
      }
    });
  }
  async finish(db: DataContextDb, grantId: string, result: MeetingCaptureAudioReceipt) {
    await sql`UPDATE app.meeting_capture_receipts SET result_json=${JSON.stringify(result)} WHERE grant_id=${grantId}::uuid AND request_key=${result.requestKey}::uuid AND result_json IS NULL`.execute(
      db.db
    );
  }
  async reconcileExpiredAudio(
    db: DataContextDb,
    grant: CaptureGrant,
    state: CaptureStoredState,
    at: Date
  ): Promise<void> {
    const expired =
      await sql<CaptureReceipt>`SELECT * FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND result_json IS NULL AND created_at<=${new Date(at.getTime() - 60000)} ORDER BY created_at LIMIT 32`.execute(
        db.db
      );
    for (const receipt of expired.rows) {
      const metadata = JSON.parse(receipt.metadata_json) as {
        sourceId: string;
        epoch: number;
        startMs: number;
        endMs: number;
      };
      const digest = createHash("sha256")
        .update(`capture-gap:${grant.id}:${receipt.request_key}`)
        .digest("hex");
      const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      retainCaptureGap(
        state,
        {
          id,
          sourceId: metadata.sourceId,
          epoch: metadata.epoch,
          startMs: metadata.startMs,
          endMs: metadata.endMs,
          reason: "interrupted"
        },
        at
      );
      await this.finish(db, grant.id, {
        requestKey: receipt.request_key,
        status: "failed",
        code: "meeting_capture_interrupted"
      });
    }
    if (expired.rows.length) await this.save(db, grant, state);
  }
  async transcriptHead(db: DataContextDb, meetingId: string) {
    const result = await sql<{
      version: number;
      cursor: number;
      transcript_revision: number;
      stop_cutoff_ms: number | null;
    }>`SELECT version,cursor,transcript_revision,stop_cutoff_ms FROM app.meeting_transcript_batches WHERE meeting_id=${meetingId}::uuid ORDER BY version DESC LIMIT 1`.execute(
      db.db
    );
    return (
      result.rows[0] ?? { version: 0, cursor: 0, transcript_revision: 0, stop_cutoff_ms: null }
    );
  }
}

/** Public owner-scoped completeness metadata; no auth material or raw source data. */
export async function readMeetingCaptureCompleteness(
  db: DataContextDb,
  meetingId: string
): Promise<{ hasGaps: boolean; gapLimitReached: boolean }> {
  assertDataContextDb(db);
  const result = await sql<{
    has_gaps: boolean;
    gap_limit: boolean;
  }>`SELECT coalesce(bool_or(jsonb_array_length(coalesce(state_json::jsonb->'gaps','[]'::jsonb))>0),false) AS has_gaps,coalesce(bool_or(coalesce((state_json::jsonb->>'gapLimitReached')::boolean,false)),false) AS gap_limit FROM app.meeting_capture_grants WHERE meeting_id=${meetingId}::uuid`.execute(
    db.db
  );
  return {
    hasGaps: result.rows[0]?.has_gaps ?? false,
    gapLimitReached: result.rows[0]?.gap_limit ?? false
  };
}
