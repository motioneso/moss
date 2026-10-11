import type { AccessContext, DataContextDb } from "@moss/db";
import { captureAuthorizationError } from "./capture-authorization.js";
import { MeetingCaptureError, elapsed } from "./capture-domain.js";
import { MeetingCaptureConnectionRepository } from "./capture-connection-repository.js";
import { captureState, MeetingCaptureRepository, type CaptureGrant } from "./capture-repository.js";
import type { MeetingCaptureDependencies } from "./capture-service.js";

/** Persist denial after the failed operation rolls back. Infrastructure failures never revoke. */
export async function settleCaptureRevocation(
  deps: MeetingCaptureDependencies,
  actor: AccessContext,
  initial: CaptureGrant,
  error: unknown,
  repository = new MeetingCaptureRepository(),
  connections = new MeetingCaptureConnectionRepository()
): Promise<void> {
  const failure = captureAuthorizationError(error);
  if (failure.httpStatus !== 401) return;
  await deps.dataContext.withDataContext(actor, async (db) => {
    await connections.lock(db, initial.device_id);
    await repository.lockMeeting(db, initial.meeting_id);
    const grant = await repository.grant(db, initial.id, true);
    if (!grant?.state_json || !["approved", "active", "finalizing"].includes(grant.status)) return;
    const state = captureState(grant);
    const at = (deps.now ?? (() => new Date()))();
    const epoch = state.epochs.at(-1);
    if (epoch?.endMs === null) epoch.endMs = elapsed(state, at);
    state.desired = "revoked";
    state.revocationReason = failure.revocationReason;
    state.generation += 1;
    state.observed = { generation: state.generation, phase: "stopped" };
    await repository.save(db, grant, state);
  });
}

/** App locks precede the auth fence; auth release always follows app commit/rollback. */
export async function withCaptureBindingTransaction<T>(
  deps: MeetingCaptureDependencies,
  actor: AccessContext,
  prepare: (db: DataContextDb) => Promise<CaptureGrant>,
  work: (db: DataContextDb, grant: CaptureGrant) => Promise<T>,
  protect = true
): Promise<T> {
  let lease: { release(): Promise<void> } | undefined;
  try {
    return await deps.dataContext.withDataContext(actor, async (db) => {
      const grant = await prepare(db);
      if (protect) {
        if (!grant.session_id || !grant.capability_revision) throw new MeetingCaptureError();
        lease = await deps
          .acquireRecordingBinding({
            actorUserId: actor.actorUserId,
            sessionId: grant.session_id,
            deviceId: grant.device_id,
            capabilityRevision: grant.capability_revision
          })
          .catch((error: unknown) => {
            throw captureAuthorizationError(error);
          });
      }
      if (protect && grant.expires_at <= (deps.now ?? (() => new Date()))())
        throw new MeetingCaptureError("meeting_capture_unavailable", 401, 1, "expired");
      return work(db, grant);
    });
  } finally {
    await lease?.release();
  }
}
