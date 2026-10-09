import { isNearSilentCapturePcm } from "./capture-silence.js";
import type { CaptureMaintenanceScheduler } from "./capture-maintenance.js";
import { settleCaptureRevocation, withCaptureBindingTransaction } from "./capture-binding.js";
import type { MeetingStopSummaryRepository } from "./stop-summary-repository.js";
import {
  MeetingPreferencesRepository,
  resolveCaptureSource,
  savedCaptureSelection
} from "./preferences.js";
import { captureAuthorizationError } from "./capture-authorization.js";
import { captureMetadataJson } from "./capture-metadata.js";
import { captureTranscriptSources } from "./capture-transcript-sources.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isUuid, type AccessContext, type DataContextDb, type DataContextRunner } from "@moss/db";
import { MEETING_CAPTURE_LEASE_MS } from "@moss/shared";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureAudioReceipt,
  MeetingCaptureCancelStartInput,
  MeetingCaptureCancelStartResult,
  MeetingCaptureProcessingFailure,
  MeetingCaptureBrowserStatus,
  MeetingCaptureControlInput,
  MeetingCaptureNativeControlInput,
  MeetingCaptureState,
  MeetingCaptureStatusInput
} from "@moss/shared";
import {
  applyCaptureControl,
  applyCaptureSourceChange,
  assertCaptureAudioAdmission,
  decodeCaptureAudio,
  expireCaptureLease,
  MeetingCaptureError,
  pcmWave,
  retainCaptureGap,
  type CaptureStoredState
} from "./capture-domain.js";
import {
  captureState,
  captureView,
  MeetingCaptureRepository,
  type CaptureGrant
} from "./capture-repository.js";
import {
  CaptureProcessingError,
  captureProcessingFailure,
  normalizeCaptureSegments
} from "./capture-processing.js";
import { MeetingCaptureConnectionRepository } from "./capture-connection-repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";

export type MeetingCaptureTranscriber = (
  actor: AccessContext,
  input: {
    audio: Uint8Array;
    sampleRateHz: number;
    signal: AbortSignal;
    expectedModelRoute: string;
    dispatch: <T>(
      initiate: () => Promise<T>,
      validate?: (db: DataContextDb) => Promise<void>
    ) => Promise<T>;
  }
) => Promise<{
  segments: readonly { startMs: number; endMs: number; text: string }[];
  modelRoute: string;
}>;
export interface CaptureBrowserBinding extends AccessContext {
  readonly sessionId: string;
  readonly expiresAt: Date;
}
export interface CaptureCompanionBinding extends AccessContext {
  readonly deviceId: string;
}
export interface CaptureRecordingBinding extends CaptureCompanionBinding {
  readonly capabilityRevision: number;
  readonly expiresAt: Date;
}
export interface MeetingCaptureDependencies {
  readonly scheduleMaintenance: CaptureMaintenanceScheduler;
  readonly acquireRecordingBinding: (input: {
    actorUserId: string;
    sessionId: string;
    deviceId: string;
    capabilityRevision: number;
  }) => Promise<{ release(): Promise<void> }>;
  readonly resolveRecording?: (input: {
    headers: IncomingHttpHeaders;
    requestId: string;
  }) => Promise<CaptureRecordingBinding>;
  readonly assertRecordingBinding?: (input: {
    actorUserId: string;
    deviceId: string;
    capabilityRevision: number;
  }) => Promise<{ expiresAt: Date }>;
  readonly describeProcessingFailure?: (error: unknown) => MeetingCaptureProcessingFailure | null;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly resolveBrowser: (input: {
    headers: IncomingHttpHeaders;
    requestId: string;
  }) => Promise<CaptureBrowserBinding>;
  readonly resolveCompanion: (input: {
    headers: IncomingHttpHeaders;
    requestId: string;
  }) => Promise<CaptureCompanionBinding>;
  readonly assertBinding: (input: {
    actorUserId: string;
    sessionId?: string;
    deviceId?: string;
  }) => Promise<void>;
  readonly device: (input: {
    actorUserId: string;
    deviceId: string;
  }) => Promise<{ displayName: string; expiresAt: Date }>;
  readonly assertModuleAvailable: (actor: AccessContext) => Promise<void>;
  readonly processingAvailability: (
    actor: AccessContext
  ) => Promise<{ ready: boolean; modelRoute: string | null }>;
  readonly transcribe: MeetingCaptureTranscriber;
  readonly trustedOrigins: readonly string[];
  readonly now?: () => Date;
  readonly scheduleSummary?: (
    db: DataContextDb,
    actor: AccessContext,
    input: Parameters<MeetingStopSummaryRepository["schedule"]>[2]
  ) => Promise<void>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function matches(value: string, expected: string | null) {
  return (
    expected !== null &&
    /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"))
  );
}
interface NativeProof {
  actor: AccessContext;
  grant: CaptureGrant;
  credential: string;
}
export class MeetingCaptureService {
  private readonly now: () => Date;
  constructor(
    private readonly deps: MeetingCaptureDependencies,
    private readonly repository = new MeetingCaptureRepository(),
    private readonly transcript = new MeetingTranscriptRepository(),
    private readonly connections = new MeetingCaptureConnectionRepository(),
    private readonly preferences = new MeetingPreferencesRepository()
  ) {
    this.now = deps.now ?? (() => new Date());
  }
  private async scheduleSummary(
    db: DataContextDb,
    actor: AccessContext,
    grant: CaptureGrant,
    state: CaptureStoredState,
    stoppedNow = false
  ): Promise<void> {
    if (state.desired === "stopped" && state.stopCutoffMs !== null && state.finalizationDeadline)
      await this.deps.scheduleSummary?.(db, actor, {
        meetingId: grant.meeting_id,
        grantId: grant.id,
        deadline: state.finalizationDeadline,
        finalized: state.finalized === true,
        stoppedNow
      });
  }
  async browser(
    headers: IncomingHttpHeaders,
    requestId: string,
    mutating: boolean
  ): Promise<CaptureBrowserBinding> {
    if (
      headers.authorization !== undefined ||
      (mutating &&
        (typeof headers.origin !== "string" || !this.deps.trustedOrigins.includes(headers.origin)))
    )
      throw new MeetingCaptureError();
    let actor: CaptureBrowserBinding;
    try {
      actor = await this.deps.resolveBrowser({ headers, requestId });
    } catch (error) {
      throw captureAuthorizationError(error);
    }
    await this.deps.assertModuleAvailable(actor);
    return actor;
  }
  /** Uses the independent auth pool; safe while the capture transaction holds its lock. */
  private async liveBinding(grant: CaptureGrant, actor: AccessContext) {
    if (
      !grant.session_id ||
      !grant.capability_revision ||
      !grant.connection_id ||
      !this.deps.assertRecordingBinding
    )
      throw new MeetingCaptureError();
    try {
      await this.deps.assertBinding({
        actorUserId: actor.actorUserId,
        sessionId: grant.session_id,
        deviceId: grant.device_id
      });
      await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: grant.device_id,
        capabilityRevision: grant.capability_revision
      });
    } catch (error) {
      throw captureAuthorizationError(error);
    }
  }
  private async preflight(grant: CaptureGrant, actor: AccessContext) {
    try {
      await this.liveBinding(grant, actor);
    } catch (error) {
      await settleCaptureRevocation(
        this.deps,
        actor,
        grant,
        error,
        this.repository,
        this.connections
      );
      throw error;
    }
    await this.deps.assertModuleAvailable(actor);
  }
  private valid(grant: CaptureGrant | null, meetingId: string, deviceId?: string) {
    if (
      !grant ||
      grant.meeting_id !== meetingId ||
      (deviceId && grant.device_id !== deviceId) ||
      grant.expires_at <= this.now() ||
      grant.status === "revoked"
    )
      throw new MeetingCaptureError();
    return grant;
  }
  private async authenticate(
    headers: IncomingHttpHeaders,
    requestId: string,
    meetingId: string,
    grantId: string
  ): Promise<NativeProof> {
    const match =
      typeof headers.authorization === "string" &&
      /^Bearer (mm1_([a-f0-9-]{36})\.([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(
        headers.authorization
      );
    if (headers.cookie || !match || !isUuid(match[2]!) || match[3] !== grantId)
      throw new MeetingCaptureError();
    const actor = { actorUserId: match[2]!, requestId };
    const credential = match[1]!;
    const grant = this.valid(
      await this.deps.dataContext.withDataContext(actor, (db) =>
        this.repository.grant(db, grantId)
      ),
      meetingId
    );
    if (
      !["active", "finalizing", "complete"].includes(grant.status) ||
      !matches(credential, grant.credential_hash)
    )
      throw new MeetingCaptureError();
    await this.preflight(grant, actor);
    return { actor, grant, credential };
  }
  private async locked(db: DataContextDb, proof: NativeProof): Promise<CaptureGrant> {
    await this.connections.lock(db, proof.grant.device_id);
    await this.repository.lockMeeting(db, proof.grant.meeting_id);
    const grant = this.valid(
      await this.repository.grant(db, proof.grant.id, true),
      proof.grant.meeting_id,
      proof.grant.device_id
    );
    if (
      !["active", "finalizing", "complete"].includes(grant.status) ||
      !matches(proof.credential, grant.credential_hash)
    )
      throw new MeetingCaptureError();
    const connection = await this.connections.connection(db, grant.device_id);
    if (
      !connection ||
      connection.connection_id !== grant.connection_id ||
      connection.capability_revision !== grant.capability_revision ||
      connection.verifier_hash !== grant.verifier_hash
    )
      throw new MeetingCaptureError();
    await this.liveBinding(grant, proof.actor);
    return grant;
  }
  private async nativeTransaction<T>(
    proof: NativeProof,
    work: (db: DataContextDb, grant: CaptureGrant) => Promise<T>
  ) {
    try {
      return await withCaptureBindingTransaction(
        this.deps,
        proof.actor,
        (db) => this.locked(db, proof),
        work
      );
    } catch (error) {
      await settleCaptureRevocation(
        this.deps,
        proof.actor,
        proof.grant,
        error,
        this.repository,
        this.connections
      );
      throw error;
    }
  }
  async status(headers: IncomingHttpHeaders, requestId: string, input: MeetingCaptureStatusInput) {
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    return this.nativeTransaction(proof, async (db, grant) => {
      const state = captureState(grant);
      const previousRevision = captureView(grant, state, this.now()).revision;
      await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
      expireCaptureLease(state, this.now(), grant.expires_at);
      if (input.observed.generation > state.generation)
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      let observed = input.observed;
      if (
        input.observed.generation === state.generation &&
        (input.observed.phase === "error" || input.observed.phase === "paused") &&
        state.desired === "recording"
      ) {
        applyCaptureControl(
          state,
          {
            grantId: grant.id,
            requestKey: randomUUID(),
            expectedGeneration: state.generation,
            command: "pause"
          },
          this.now()
        );
        // This report already confirms the pause it caused; an error alone does not.
        if (observed.phase === "paused") observed = { ...observed, generation: state.generation };
      }
      for (const gap of input.gaps ?? []) retainCaptureGap(state, gap, this.now());
      state.inventory = input.inventory;
      if (observed.generation >= (state.observed?.generation ?? 0)) {
        if (!state.gapLimitReached) state.observed = observed;
        else if (
          observed.generation === state.generation &&
          (observed.phase === "paused" || observed.phase === "stopped")
        ) {
          // Keep the loss warning without hiding a current-generation safe stop acknowledgement.
          state.observed = { ...observed, errorCode: "meeting_capture_limit" };
        }
      }
      if (
        input.recordedDurationMs !== undefined &&
        input.observed.generation === state.generation
      ) {
        if (
          !Number.isSafeInteger(input.recordedDurationMs) ||
          input.recordedDurationMs < (state.recordedDurationMs ?? 0) ||
          input.recordedDurationMs > this.now().getTime() - Date.parse(state.originAt)
        )
          throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
        state.recordedDurationMs = input.recordedDurationMs;
      }
      if (
        input.finalized &&
        state.desired === "stopped" &&
        input.observed.phase === "stopped" &&
        input.observed.generation === state.generation &&
        !(await this.repository.hasPendingAudio(db, grant.id))
      )
        state.finalized = true;
      state.lastSeenAt = this.now().toISOString();
      await this.repository.save(db, grant, state);
      await this.scheduleSummary(db, proof.actor, grant, state);
      const capture = captureView(grant, state, this.now());
      return { capture, changed: capture.revision !== previousRevision };
    });
  }
  async browserStatus(
    actor: CaptureBrowserBinding,
    meetingId: string
  ): Promise<MeetingCaptureBrowserStatus> {
    const result = await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.repository.lockMeeting(db, meetingId);
      const grants = await this.repository.grants(db, meetingId);
      await this.deps.assertBinding({ actorUserId: actor.actorUserId, sessionId: actor.sessionId });
      const grant =
        grants.find((row) => row.status === "active") ??
        grants.find((row) => row.state_json !== null);
      let capture: MeetingCaptureState | null = null;
      if (grant?.state_json) {
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        if (grant.status === "approved") {
          if (
            state.desired !== "paused" &&
            (!grant.claim_expires_at || grant.claim_expires_at <= this.now())
          )
            state.desired = "revoked";
        } else expireCaptureLease(state, this.now(), grant.expires_at);
        if (["active", "approved", "finalizing"].includes(grant.status)) {
          try {
            await this.liveBinding(grant, actor);
          } catch (error) {
            if (error instanceof MeetingCaptureError && error.httpStatus === 401) {
              state.desired = "revoked";
              state.revocationReason = error.revocationReason;
            } else throw error;
          }
        }
        if (grant.expires_at <= this.now() || grant.status === "revoked") {
          state.desired = "revoked";
          state.revocationReason ??= grant.expires_at <= this.now() ? "expired" : undefined;
        }
        if (
          state.desired === "stopped" &&
          state.finalizationDeadline !== null &&
          this.now().getTime() >= Date.parse(state.finalizationDeadline)
        )
          state.finalized = true;
        const head = await this.repository.transcriptHead(db, meetingId);
        state.transcriptRevision = head.transcript_revision;
        if (JSON.stringify(state) !== grant.state_json)
          await this.repository.save(db, grant, state);
        if (grant.status === "approved") {
          const connection = await this.connections.connection(db, grant.device_id);
          if (
            connection &&
            connection.connection_id === grant.connection_id &&
            connection.capability_revision === grant.capability_revision
          ) {
            state.inventory = JSON.parse(connection.inventory_json) as typeof state.inventory;
            state.lastSeenAt = connection.last_seen_at.toISOString();
          }
        }
        await this.scheduleSummary(db, actor, grant, state);
        capture = captureView(grant, state, this.now());
      }
      return {
        capture,
        pendingLinks: []
      };
    });
    const processing = await this.deps.processingAvailability(actor);
    return {
      ...result,
      processingReady: processing.ready,
      revision: result.capture?.revision ?? "none",
      retryAfterMs: 1000
    };
  }
  async browserControl(
    actor: CaptureBrowserBinding,
    meetingId: string,
    input: MeetingCaptureControlInput
  ) {
    if (!["record", "pause", "stop", "revoke"].includes(input.command))
      throw new MeetingCaptureError();
    const grant = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.repository.grant(db, input.grantId)
    );
    if (!grant || grant.meeting_id !== meetingId) throw new MeetingCaptureError();
    if (input.command !== "revoke") {
      this.valid(grant, meetingId);
      await this.preflight(grant, actor);
    }
    return this.control(actor, grant.id, meetingId, input);
  }
  async nativeControl(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureNativeControlInput
  ) {
    if (input.command === "change-sources" || input.command === "recover-sources") {
      if (!input.selection || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1)
        throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
      const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
      const fingerprint = hash(captureMetadataJson(input));
      return this.nativeTransaction(proof, async (db, grant) => {
        const prior = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        if (prior?.result_json)
          return { capture: captureView(grant, captureState(grant), this.now()) };
        if (grant.status !== "active" || !grant.credential_hash)
          throw new MeetingCaptureError("meeting_capture_conflict", 409);
        const connection = await this.connections.connection(db, grant.device_id);
        if (
          !connection ||
          connection.expires_at <= this.now() ||
          this.now().getTime() - connection.last_seen_at.getTime() > MEETING_CAPTURE_LEASE_MS
        )
          throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        expireCaptureLease(state, this.now(), grant.expires_at);
        state.inventory = JSON.parse(connection.inventory_json) as NonNullable<
          typeof state.inventory
        >;
        applyCaptureSourceChange(state, input, this.now());
        await this.repository.save(db, grant, state);
        const result = { capture: captureView(grant, state, this.now()) };
        await this.repository.reserve(db, grant.id, {
          requestKey: input.requestKey,
          kind: "control",
          fingerprint,
          metadata: { command: input.command },
          result
        });
        return result;
      });
    }
    if (
      !["pause", "stop", "record"].includes(input.command) ||
      input.selection !== undefined ||
      input.expectedEpoch !== undefined
    )
      throw new MeetingCaptureError();
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    return this.control(proof.actor, input.grantId, input.meetingId, input, proof);
  }
  private async controlGrant(
    db: DataContextDb,
    actor: AccessContext,
    grantId: string,
    meetingId: string,
    input: MeetingCaptureControlInput,
    proof?: NativeProof
  ) {
    const initial = proof?.grant ?? (await this.repository.grant(db, grantId));
    if (!initial) throw new MeetingCaptureError();
    await this.connections.lock(db, initial.device_id);
    await this.repository.lockMeeting(db, meetingId);
    const grant = proof
      ? await this.locked(db, proof)
      : await this.repository.grant(db, grantId, true);
    if (!grant || grant.meeting_id !== meetingId || grant.id !== input.grantId)
      throw new MeetingCaptureError();
    if (input.command !== "revoke") {
      this.valid(grant, meetingId);
      await this.liveBinding(grant, actor);
    }
    return grant;
  }
  private async control(
    actor: AccessContext,
    grantId: string,
    meetingId: string,
    input: MeetingCaptureControlInput,
    proof?: NativeProof
  ) {
    const fingerprint = hash(
      captureMetadataJson({
        expectedGeneration: input.expectedGeneration,
        command: input.command,
        selection: input.selection ?? null
      })
    );
    if (input.command === "record") {
      const replay = await this.deps.dataContext.withDataContext(actor, async (db) => {
        const grant = await this.controlGrant(db, actor, grantId, meetingId, input, proof);
        const prior = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        return prior?.result_json
          ? { capture: captureView(grant, captureState(grant), this.now()) }
          : null;
      });
      if (replay) return replay;
    }
    const processing =
      input.command === "record"
        ? await this.deps.processingAvailability(actor).catch(() => null)
        : null;
    return withCaptureBindingTransaction(
      this.deps,
      actor,
      (db) => this.controlGrant(db, actor, grantId, meetingId, input, proof),
      async (db, grant) => {
        const previous = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        if (previous?.result_json)
          return { capture: captureView(grant, captureState(grant), this.now()) };
        if (input.command === "record" && (!processing?.ready || !processing.modelRoute))
          throw new MeetingCaptureError("meeting_capture_processing_unavailable", 503);
        const state = captureState(grant);
        // Native Record is only an explicit Resume of this already claimed, paused epoch.
        // Receipt replay above remains idempotent even after the accepted Resume advanced it.
        if (
          proof &&
          input.command === "record" &&
          (grant.status !== "active" ||
            !grant.credential_hash ||
            state.desired !== "paused" ||
            !state.epochs.at(-1)?.selection)
        )
          throw new MeetingCaptureError();
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        if (grant.status !== "approved") expireCaptureLease(state, this.now(), grant.expires_at);
        let command = input;
        if (input.command === "record") {
          // Legacy source-bearing controls can replay their receipt, but cannot create a new epoch.
          if (input.selection)
            throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
          const connection = await this.connections.connection(db, grant.device_id);
          if (
            !connection ||
            connection.connection_id !== grant.connection_id ||
            connection.capability_revision !== grant.capability_revision ||
            connection.expires_at <= this.now() ||
            this.now().getTime() - connection.last_seen_at.getTime() > MEETING_CAPTURE_LEASE_MS
          )
            throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
          state.inventory = JSON.parse(connection.inventory_json) as NonNullable<
            typeof state.inventory
          >;
          if (grant.status === "approved") state.lastSeenAt = connection.last_seen_at.toISOString();
          command = {
            ...input,
            selection:
              state.desired === "paused"
                ? state.epochs.at(-1)?.selection
                : savedCaptureSelection(
                    resolveCaptureSource(
                      await this.preferences.get(db),
                      grant.device_id,
                      state.inventory
                    ),
                    state.inventory
                  )
          };
        }
        const resumingPausedSelection =
          input.command === "record" &&
          !input.selection &&
          state.desired === "paused" &&
          command.selection &&
          state.inventory;
        try {
          applyCaptureControl(state, command, this.now(), processing?.modelRoute ?? "");
        } catch (error) {
          // Only a previously valid, retained source becoming unavailable gets recovery guidance.
          if (
            resumingPausedSelection &&
            error instanceof MeetingCaptureError &&
            error.code === "meeting_capture_invalid_input" &&
            error.httpStatus === 400
          )
            throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
          throw error;
        }
        if (grant.status === "approved" && input.command === "record")
          await this.repository.renewClaim(
            db,
            grant,
            new Date(Math.min(this.now().getTime() + 60000, grant.expires_at.getTime()))
          );
        if (grant.status === "approved" && !grant.credential_hash) {
          state.observed =
            input.command === "record"
              ? null
              : {
                  generation: state.generation,
                  phase: input.command === "pause" ? "paused" : "stopped"
                };
        }
        await this.repository.save(db, grant, state);
        if (input.command === "stop")
          await this.stopTranscript(db, meetingId, input.requestKey, state);
        await this.scheduleSummary(db, actor, grant, state, input.command === "stop");
        const result = { capture: captureView(grant, state, this.now()) };
        await this.repository.reserve(db, grant.id, {
          requestKey: input.requestKey,
          kind: "control",
          fingerprint,
          metadata: { command: input.command },
          result
        });
        return result;
      },
      input.command !== "revoke"
    );
  }
  private async stopTranscript(
    db: DataContextDb,
    meetingId: string,
    requestKey: string,
    state: CaptureStoredState
  ) {
    const head = await this.repository.transcriptHead(db, meetingId);
    if (head.version > 0 && head.stop_cutoff_ms === null) {
      const retained = await this.transcript.snapshotWithSources(db, meetingId, {
        maxSegments: 1,
        maxCharacters: 1
      });
      if (retained)
        await this.transcript.ingest(db, {
          meetingId,
          requestKey: requestKey,
          expectedVersion: head.version,
          sources: retained.sources,
          events: [],
          stopCutoffMs: state.stopCutoffMs
        });
    }
  }
  async cancelStart(
    actor: CaptureBrowserBinding,
    meetingId: string,
    input: MeetingCaptureCancelStartInput
  ): Promise<MeetingCaptureCancelStartResult & { readonly wakeConnectionId?: string }> {
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lockRequest(db, input.requestKey);
      const initial = await this.connections.byRequest(db, input.requestKey);
      if (initial) await this.connections.lock(db, initial.device_id);
      await this.repository.lockMeeting(db, meetingId);
      // Claim/status can finish while the device lock is awaited. Never mutate its old snapshot.
      const grant = await this.connections.byRequest(db, input.requestKey);
      await this.deps.assertBinding({ actorUserId: actor.actorUserId, sessionId: actor.sessionId });
      if (
        grant &&
        (grant.meeting_id !== meetingId ||
          (input.deviceId !== undefined && grant.device_id !== input.deviceId) ||
          (input.connectionId !== undefined && grant.connection_id !== input.connectionId))
      )
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      await this.connections.cancel(db, meetingId, input);
      if (!grant) return { cancelled: true, capture: null };
      const state = captureState(grant);
      if (grant.status === "revoked") state.desired = "revoked";
      else if (state.desired !== "stopped")
        applyCaptureControl(
          state,
          {
            grantId: grant.id,
            requestKey: input.requestKey,
            expectedGeneration: state.generation,
            command: "stop"
          },
          this.now()
        );
      if (!grant.credential_hash && state.desired === "stopped")
        state.observed = { generation: state.generation, phase: "stopped" };
      await this.repository.save(db, grant, state);
      if (state.desired === "stopped")
        await this.stopTranscript(db, meetingId, input.requestKey, state);
      await this.scheduleSummary(db, actor, grant, state, true);
      return {
        cancelled: true,
        capture: captureView(grant, state, this.now()),
        ...(grant.connection_id ? { wakeConnectionId: grant.connection_id } : {})
      };
    });
  }
  async audio(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureAudioInput
  ): Promise<MeetingCaptureAudioReceipt> {
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    const { pcm, fingerprint } = decodeCaptureAudio(input);
    const reservation = await this.nativeTransaction(proof, async (db, grant) => {
      await this.repository.reconcileExpiredAudio(db, grant, captureState(grant), this.now());
      const prior = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
      if (prior) {
        if (!prior.result_json)
          return { result: { requestKey: input.requestKey, status: "pending" as const } };
        const result = JSON.parse(prior.result_json) as MeetingCaptureAudioReceipt;
        if (!result.retryable || !(await this.repository.retry(db, grant.id, prior, this.now())))
          return {
            result: {
              ...result,
              replayed: true,
              retryAfterMs: prior.retry_at
                ? Math.max(0, prior.retry_at.getTime() - this.now().getTime())
                : result.retryAfterMs
            }
          };
        const state = captureState(grant);
        const epoch = assertCaptureAudioAdmission(state, input, this.now());
        return { modelRoute: epoch.modelRoute };
      }
      const state = captureState(grant);
      await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
      const epoch = assertCaptureAudioAdmission(state, input, this.now());
      await this.repository.admitAudio(db, grant, input, fingerprint);
      return { modelRoute: epoch.modelRoute };
    });
    if (reservation.result) {
      pcm.fill(0);
      return reservation.result;
    }
    const nearSilent = isNearSilentCapturePcm(pcm);
    let processingStage: "dispatch" | "validation" | "persistence" = "dispatch";
    try {
      // Module availability stays outside app transactions; auth-only binding is repeated at dispatch.
      await this.preflight(proof.grant, proof.actor);
      const signal = AbortSignal.timeout(35000);
      let dispatched = false;
      const dispatch = async <T>(
        initiate: () => Promise<T>,
        validate?: (db: DataContextDb) => Promise<void>
      ): Promise<T> => {
        if (dispatched) throw new MeetingCaptureError("meeting_capture_conflict", 409);
        await this.preflight(proof.grant, proof.actor);
        const admitted = await this.nativeTransaction(proof, async (db, grant) => {
          assertCaptureAudioAdmission(captureState(grant), input, this.now());
          if (validate) await validate(db);
          // The bounded admission transaction holds its auth fence through commit.
          this.valid(grant, input.meetingId, grant.device_id);
          assertCaptureAudioAdmission(captureState(grant), input, this.now());
          if (signal.aborted) throw new MeetingCaptureError("meeting_capture_interrupted", 409);
          dispatched = true;
          const pending = initiate();
          void pending.catch(() => undefined);
          return { pending };
        });
        return admitted.pending;
      };
      // Silence still crosses the same admission fence and completes its source/epoch receipt.
      // No provider call means no live route check; speech still validates the reserved route.
      const generated = nearSilent
        ? await dispatch(async () => ({ segments: [], modelRoute: reservation.modelRoute! }))
        : await abortable(
            signal,
            this.deps.transcribe(proof.actor, {
              audio: pcmWave(pcm, input.sampleRateHz),
              sampleRateHz: input.sampleRateHz,
              signal,
              expectedModelRoute: reservation.modelRoute!,
              dispatch
            })
          );
      processingStage = "validation";
      if (
        !dispatched ||
        signal.aborted ||
        generated.modelRoute !== reservation.modelRoute ||
        generated.segments.length > 100
      )
        throw new CaptureProcessingError({
          code: "meeting_capture_processing_failed",
          reason:
            generated.modelRoute !== reservation.modelRoute
              ? "route-changed"
              : "provider-response-invalid",
          stage: "validation",
          retryable: false
        });
      const segments = normalizeCaptureSegments(generated.segments, input.endMs - input.startMs);
      await this.preflight(proof.grant, proof.actor);
      processingStage = "persistence";
      return await this.nativeTransaction(proof, async (db, grant) => {
        this.valid(grant, input.meetingId, grant.device_id);
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        const epoch = state.epochs.find(
          (entry) => entry.epoch === input.epoch && entry.generation === input.generation
        );
        if (
          !epoch ||
          state.finalized ||
          (state.finalizationDeadline !== null &&
            this.now().getTime() > Date.parse(state.finalizationDeadline)) ||
          (epoch.endMs !== null && input.endMs > epoch.endMs) ||
          (state.stopCutoffMs !== null && input.endMs > state.stopCutoffMs)
        )
          throw new MeetingCaptureError("meeting_capture_interrupted", 409);
        const previous = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        if (!previous) throw new MeetingCaptureError();
        if (previous.result_json)
          return JSON.parse(previous.result_json) as MeetingCaptureAudioReceipt;
        const head = await this.repository.transcriptHead(db, input.meetingId);
        const retained = await this.transcript.snapshotWithSources(db, input.meetingId, {
          maxSegments: 1,
          maxCharacters: 1
        });
        const sources = captureTranscriptSources(state, input, retained?.sources ?? []);
        const saved = await this.transcript.ingest(db, {
          meetingId: input.meetingId,
          requestKey: input.requestKey,
          expectedVersion: head.version,
          sources,
          events: segments.map((segment, index) => ({
            cursor: head.cursor + index + 1,
            segment: {
              meetingId: input.meetingId,
              segmentId: `${input.requestKey}:${index}`,
              sourceId: input.sourceId,
              epoch: input.epoch,
              startMs: input.startMs + segment.startMs,
              endMs: input.startMs + segment.endMs,
              revision: 1,
              text: segment.text,
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          })),
          stopCutoffMs: state.stopCutoffMs ?? head.stop_cutoff_ms
        });
        if (saved.status !== "saved")
          throw new CaptureProcessingError({
            code: "meeting_capture_processing_failed",
            reason: "transcript-conflict",
            stage: "persistence",
            retryable: true,
            retryAfterMs: 250
          });
        const result: MeetingCaptureAudioReceipt = {
          requestKey: input.requestKey,
          status: "saved",
          transcriptRevision: saved.receipt.transcriptRevision,
          replayed: false
        };
        state.transcriptRevision = saved.receipt.transcriptRevision;
        await this.repository.finish(db, grant.id, result, this.now());
        // Clear settled warnings, without masking other in-flight/retryable source audio.
        if (!nearSilent || !(await this.repository.hasPendingAudio(db, grant.id)))
          state.processing = { status: "ready" };
        await this.repository.save(db, grant, state);
        return result;
      });
    } catch (error) {
      const failure = captureProcessingFailure(
        error,
        processingStage,
        this.deps.describeProcessingFailure
      );
      const result: MeetingCaptureAudioReceipt = {
        requestKey: input.requestKey,
        status: "failed",
        ...failure
      };
      // Revoked/deleted authorization suppresses even failure receipts from native callers.
      await this.preflight(proof.grant, proof.actor);
      return this.nativeTransaction(proof, async (db, grant) => {
        this.valid(grant, input.meetingId, grant.device_id);
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        const previous = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        if (previous?.result_json)
          return JSON.parse(previous.result_json) as MeetingCaptureAudioReceipt;
        const retryable =
          failure.retryable &&
          (previous?.attempts ?? 1) < 4 &&
          this.now().getTime() - (previous?.created_at.getTime() ?? 0) < 60000;
        const finalResult = { ...result, retryable };
        // No speech was dispatched: receipt retries must not replace another clip's warning.
        if (!nearSilent)
          state.processing = {
            status: "delayed",
            reason: failure.reason,
            stage: failure.stage,
            retryable,
            ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
            ...(retryable ? { retryAfterMs: failure.retryAfterMs ?? 1000 } : {})
          };
        if (!retryable)
          retainCaptureGap(
            state,
            {
              id: input.requestKey,
              sourceId: input.sourceId,
              epoch: input.epoch,
              startMs: input.startMs,
              endMs: input.endMs,
              reason: "processing-failed"
            },
            this.now()
          );
        await this.repository.save(db, grant, state);
        await this.repository.finish(db, grant.id, finalResult, this.now());
        return finalResult;
      });
    } finally {
      pcm.fill(0);
    }
  }
}

async function abortable<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  let cancel = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new MeetingCaptureError("meeting_capture_interrupted", 409));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
