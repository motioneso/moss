import { createHash } from "node:crypto";
import { sql } from "kysely";
import { isUuid, type AccessContext, type DataContextDb } from "@moss/db";
import { scopedJobDatabase, sendJob, type PgBoss, type QueueDefinition } from "@moss/jobs";
import { captureAuthorizationError } from "./capture-authorization.js";
import { elapsed, MeetingCaptureError } from "./capture-domain.js";
import { captureState, MeetingCaptureRepository } from "./capture-repository.js";
import { MeetingCaptureConnectionRepository } from "./capture-connection-repository.js";
import type { MeetingCaptureDependencies } from "./capture-service.js";

export const MEETING_CAPTURE_MAINTENANCE_QUEUE = "meetings.capture-maintenance";
export const MEETING_CAPTURE_MAINTENANCE_MS = 5000;
export const MEETING_CAPTURE_MAINTENANCE_HANDLER_MS = 4000;
export const MEETING_CAPTURE_MAINTENANCE_QUEUES: readonly QueueDefinition[] = [
  {
    name: MEETING_CAPTURE_MAINTENANCE_QUEUE,
    options: {
      policy: "standard",
      retryLimit: 7200,
      retryDelay: 1,
      retryBackoff: false,
      expireInSeconds: 8,
      deleteAfterSeconds: 3600,
      retentionSeconds: 86400
    }
  }
];
export interface CaptureMaintenancePayload {
  actorUserId: string;
  resourceId: string;
  idempotencyKey: string;
  version: number;
}
export type CaptureMaintenanceScheduler = (
  db: DataContextDb,
  actor: AccessContext,
  input: { grantId: string; sequence: number; at: Date }
) => Promise<void>;
export function captureMaintenanceJobId(grantId: string, sequence: number): string {
  const value = createHash("sha256")
    .update(`meeting-maintenance:${grantId}:${sequence}`)
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export function createMeetingCaptureMaintenanceScheduler(
  boss: Pick<PgBoss, "send">
): CaptureMaintenanceScheduler {
  return async (db, actor, input) => {
    const id = captureMaintenanceJobId(input.grantId, input.sequence);
    const accepted = await sendJob(
      boss,
      MEETING_CAPTURE_MAINTENANCE_QUEUE,
      {
        actorUserId: actor.actorUserId,
        resourceId: input.grantId,
        idempotencyKey: id,
        version: input.sequence
      },
      {
        id,
        db: scopedJobDatabase(db),
        startAfter: new Date(input.at.getTime() + MEETING_CAPTURE_MAINTENANCE_MS)
      }
    );
    // pg-boss ON CONFLICT returns null. Never mistake a suppressed insert for durable maintenance.
    if (accepted !== id) throw new MeetingCaptureError("meeting_capture_unavailable", 503);
  };
}
export interface CaptureMaintenanceDependencies {
  withDataContext<T>(
    actor: AccessContext,
    signal: AbortSignal,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T>;
  probeBinding(
    input: Parameters<MeetingCaptureDependencies["acquireRecordingBinding"]>[0],
    signal: AbortSignal
  ): Promise<void>;
  scheduleMaintenance: CaptureMaintenanceScheduler;
}

/** Metadata-only maintenance runs in the API, where the existing auth/app ports are available. */
export async function maintainMeetingCapture(
  payload: CaptureMaintenancePayload,
  deps: CaptureMaintenanceDependencies,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  if (
    Object.keys(payload).some(
      (key) => !["actorUserId", "resourceId", "idempotencyKey", "version"].includes(key)
    ) ||
    ![payload.actorUserId, payload.resourceId, payload.idempotencyKey].every(isUuid) ||
    !Number.isInteger(payload.version) ||
    payload.version < 0 ||
    payload.version > 1440 ||
    payload.idempotencyKey !== captureMaintenanceJobId(payload.resourceId, payload.version)
  )
    throw new Error("Invalid capture maintenance metadata");
  const actor = { actorUserId: payload.actorUserId, requestId: payload.idempotencyKey };
  const repository = new MeetingCaptureRepository(),
    connections = new MeetingCaptureConnectionRepository();
  await deps.withDataContext(actor, signal, async (db) => {
    signal.throwIfAborted();
    const initial = await repository.grant(db, payload.resourceId);
    if (!initial) return;
    // The leased app connection has statement/idle deadlines and destructive cancellation.
    await sql`SET LOCAL lock_timeout='2s'`.execute(db.db);
    await connections.lock(db, initial.device_id);
    try {
      await repository.lockMeeting(db, initial.meeting_id);
    } catch (error) {
      if (error instanceof MeetingCaptureError && error.httpStatus === 404) return;
      throw error;
    }
    const grant = await repository.grant(db, initial.id, true);
    if (!grant?.state_json) return;
    const state = captureState(grant);
    if (
      state.maintenanceSequence !== payload.version ||
      ["revoked", "stopped"].includes(state.desired) ||
      ["revoked", "complete", "finalizing"].includes(grant.status)
    )
      return;
    const clock = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db.db);
    const at = clock.rows[0]!.at;
    if (
      grant.expires_at <= at ||
      (grant.status === "approved" &&
        state.desired !== "paused" &&
        (!grant.claim_expires_at || grant.claim_expires_at <= at))
    ) {
      state.desired = "revoked";
      state.revocationReason = "expired";
    } else {
      try {
        if (!grant.session_id || !grant.capability_revision) throw new MeetingCaptureError();
        await deps.probeBinding(
          {
            actorUserId: actor.actorUserId,
            sessionId: grant.session_id,
            deviceId: grant.device_id,
            capabilityRevision: grant.capability_revision
          },
          signal
        );
      } catch (error) {
        signal.throwIfAborted();
        const failure = captureAuthorizationError(error);
        if (failure.httpStatus !== 401) throw failure;
        state.desired = "revoked";
        state.revocationReason = failure.revocationReason;
      }
    }
    signal.throwIfAborted();
    if (state.desired === "revoked") {
      const epoch = state.epochs.at(-1);
      if (epoch?.endMs === null)
        epoch.endMs = elapsed(state, new Date(Math.min(at.getTime(), grant.expires_at.getTime())));
      state.generation += 1;
      state.observed = { generation: state.generation, phase: "stopped" };
      await repository.save(db, grant, state);
      return;
    }
    state.maintenanceSequence += 1;
    await repository.save(db, grant, state);
    // State and successor INSERT commit together. An old delivery after commit is a no-op.
    await deps.scheduleMaintenance(db, actor, {
      grantId: grant.id,
      sequence: state.maintenanceSequence,
      at
    });
  });
}
export async function registerMeetingCaptureMaintenanceWorker(
  boss: PgBoss,
  deps: CaptureMaintenanceDependencies
): Promise<void> {
  await boss.work<CaptureMaintenancePayload>(
    MEETING_CAPTURE_MAINTENANCE_QUEUE,
    { pollingIntervalSeconds: 1, localConcurrency: 2 },
    async ([job]) => {
      if (!job) throw new Error("Capture maintenance job missing");
      const signal = AbortSignal.any([
        job.signal,
        AbortSignal.timeout(MEETING_CAPTURE_MAINTENANCE_HANDLER_MS)
      ]);
      await maintainMeetingCapture(job.data, deps, signal);
    }
  );
}
