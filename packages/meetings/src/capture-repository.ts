import { captureMetadataJson } from "./capture-metadata.js";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureAudioReceipt,
  MeetingCaptureState
} from "@moss/shared";
import { MEETING_CAPTURE_LEASE_MS } from "@moss/shared";
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
  status: "pending" | "approved" | "active" | "finalizing" | "complete" | "revoked";
  connection_id?: string | null;
  capability_revision?: number | null;
  claim_expires_at?: Date | null;
  start_request_key?: string | null;
  start_fingerprint?: string | null;
  notice_policy_version?: string | null;
  created_at: Date;
  expires_at: Date;
  state_json: string | null;
}
export interface CaptureReceipt {
  request_key: string;
  kind: "control" | "audio";
  fingerprint: string;
  metadata_json: string;
  result_json: string | null;
  created_at: Date;
  attempts?: number;
  retry_at?: Date | null;
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
  const semanticState = { ...state, lastSeenAt: undefined, recordedDurationMs: undefined };
  return {
    revision: createHash("sha256")
      .update(captureMetadataJson({ state: semanticState, status: grant.status }))
      .digest("hex")
      .slice(0, 32),
    transcriptRevision: state.transcriptRevision ?? 0,
    leaseMs: MEETING_CAPTURE_LEASE_MS,
    recordedDurationMs: state.recordedDurationMs ?? 0,
    finalization:
      state.desired === "stopped"
        ? state.finalized ||
          grant.status === "complete" ||
          (state.finalizationDeadline !== null &&
            at.getTime() >= Date.parse(state.finalizationDeadline))
          ? "complete"
          : "pending"
        : "none",
    processing: state.processing ?? { status: "ready" },
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
  async bindNotice(db: DataContextDb, grant: CaptureGrant, policyVersion: string): Promise<void> {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_capture_grants SET notice_policy_version=${policyVersion} WHERE id=${grant.id}::uuid`.execute(
      db.db
    );
    grant.notice_policy_version = policyVersion;
  }
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
  async renewClaim(db: DataContextDb, grant: CaptureGrant, deadline: Date) {
    await sql`UPDATE app.meeting_capture_grants SET claim_expires_at=${deadline} WHERE id=${grant.id}::uuid AND status='approved' AND credential_hash IS NULL`.execute(
      db.db
    );
    grant.claim_expires_at = deadline;
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
    if (grant.status === "approved" && !grant.credential_hash && state.desired === "stopped")
      state.finalized = true;
    const status =
      state.desired === "revoked"
        ? "revoked"
        : state.desired === "stopped" &&
            (state.finalized ||
              (state.observed?.phase === "stopped" &&
                state.observed.generation === state.generation))
          ? state.finalized
            ? "complete"
            : "finalizing"
          : grant.status;
    const serialized = JSON.stringify(state);
    if (grant.state_json === serialized && grant.status === status) return;
    await sql`UPDATE app.meeting_capture_grants SET status=${status},state_json=${serialized},recorded_duration_ms=${state.recordedDurationMs ?? null} WHERE id=${grant.id}::uuid`.execute(
      db.db
    );
    grant.state_json = serialized;
    grant.status = status;
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
      await sql`SELECT 1 FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND metadata_json::jsonb->>'sourceId'=${input.sourceId} AND result_json IS NULL LIMIT 1`.execute(
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
  async retry(
    db: DataContextDb,
    grantId: string,
    receipt: CaptureReceipt,
    at: Date
  ): Promise<boolean> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id'),2982))`.execute(
      db.db
    );
    const pending = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM app.meeting_capture_receipts WHERE kind='audio' AND result_json IS NULL AND created_at>${new Date(at.getTime() - 60000)}`.execute(
      db.db
    );
    const metadata = JSON.parse(receipt.metadata_json) as { sourceId: string };
    const sourcePending =
      await sql`SELECT 1 FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid AND kind='audio' AND result_json IS NULL AND metadata_json::jsonb->>'sourceId'=${metadata.sourceId} LIMIT 1`.execute(
        db.db
      );
    if (Number(pending.rows[0]?.count) >= 2 || sourcePending.rows.length)
      throw new MeetingCaptureError("meeting_capture_busy", 409);
    if (
      (receipt.attempts ?? 1) >= 4 ||
      at.getTime() - receipt.created_at.getTime() >= 60000 ||
      (receipt.retry_at && receipt.retry_at > at)
    )
      return false;
    const result =
      await sql`UPDATE app.meeting_capture_receipts SET result_json=NULL,retry_at=NULL,attempts=attempts+1 WHERE grant_id=${grantId}::uuid AND request_key=${receipt.request_key}::uuid AND attempts<4 AND created_at>${new Date(at.getTime() - 60000)} AND (retry_at IS NULL OR retry_at<=${at}) AND result_json::jsonb->>'retryable'='true' RETURNING request_key`.execute(
        db.db
      );
    return result.rows.length > 0;
  }
  async finish(db: DataContextDb, grantId: string, result: MeetingCaptureAudioReceipt, at: Date) {
    const retryAt = result.retryable
      ? new Date(at.getTime() + (result.retryAfterMs ?? 1000))
      : null;
    await sql`UPDATE app.meeting_capture_receipts SET result_json=${JSON.stringify(result)},retry_at=${retryAt} WHERE grant_id=${grantId}::uuid AND request_key=${result.requestKey}::uuid AND (result_json IS NULL OR result_json::jsonb->>'retryable'='true')`.execute(
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
      await sql<CaptureReceipt>`SELECT * FROM app.meeting_capture_receipts WHERE grant_id=${grant.id}::uuid AND kind='audio' AND (result_json IS NULL OR result_json::jsonb->>'retryable'='true') AND created_at<=${new Date(at.getTime() - 60000)} ORDER BY created_at LIMIT 32`.execute(
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
      await this.finish(
        db,
        grant.id,
        {
          requestKey: receipt.request_key,
          status: "failed",
          code: "meeting_capture_interrupted",
          reason: "audio-expired",
          stage: "dispatch",
          retryable: false
        },
        at
      );
    }
    if (expired.rows.length) await this.save(db, grant, state);
  }
  async hasPendingAudio(db: DataContextDb, grantId: string): Promise<boolean> {
    return (
      (
        await sql`SELECT 1 FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid AND kind='audio' AND (result_json IS NULL OR result_json::jsonb->>'retryable'='true') LIMIT 1`.execute(
          db.db
        )
      ).rows.length > 0
    );
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
