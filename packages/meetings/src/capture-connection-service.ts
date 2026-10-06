import { captureAuthorizationError } from "./capture-authorization.js";
import { captureMetadataJson } from "./capture-metadata.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AccessContext, DataContextDb } from "@moss/db";
import {
  MEETING_CAPTURE_CLAIM_MS,
  MEETING_CAPTURE_LEASE_MS,
  type MeetingCaptureClaimInput,
  type MeetingCaptureClaimResult,
  type MeetingCaptureCommandsInput,
  type MeetingCaptureCommandsResult,
  type MeetingCaptureConnectionInput,
  type MeetingCaptureConnectionResult,
  type MeetingCaptureDevicesResult,
  type MeetingCaptureInventory,
  type MeetingCaptureStartInput
} from "@moss/shared";
import {
  applyCaptureControl,
  assertCaptureNoticeAcknowledged,
  MeetingCaptureError,
  validateCaptureSelection,
  type CaptureStoredState
} from "./capture-domain.js";
import {
  captureState,
  captureView,
  MeetingCaptureRepository,
  type CaptureGrant
} from "./capture-repository.js";
import {
  MeetingCaptureConnectionRepository,
  type CaptureConnection
} from "./capture-connection-repository.js";
import type {
  CaptureBrowserBinding,
  MeetingCaptureDependencies,
  CaptureRecordingBinding
} from "./capture-service.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const proofMatches = (value: string, expected: string) =>
  /^[a-f0-9]{64}$/.test(expected) &&
  timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));

export class MeetingCaptureConnectionService {
  private readonly now: () => Date;
  constructor(
    private readonly deps: MeetingCaptureDependencies,
    private readonly grants = new MeetingCaptureRepository(),
    readonly connections = new MeetingCaptureConnectionRepository()
  ) {
    this.now = deps.now ?? (() => new Date());
  }
  private async native(
    headers: IncomingHttpHeaders,
    requestId: string
  ): Promise<CaptureRecordingBinding> {
    if (headers.cookie || !this.deps.resolveRecording) throw new MeetingCaptureError();
    let actor: CaptureRecordingBinding;
    try {
      actor = await this.deps.resolveRecording({ headers, requestId });
    } catch (error) {
      throw captureAuthorizationError(error);
    }
    await this.deps.assertModuleAvailable(actor);
    return actor;
  }
  private valid(
    connection: CaptureConnection | null,
    actor: CaptureRecordingBinding,
    connectionId: string,
    verifier?: string
  ) {
    if (
      !connection ||
      connection.connection_id !== connectionId ||
      connection.device_id !== actor.deviceId ||
      connection.capability_revision !== actor.capabilityRevision ||
      connection.expires_at <= this.now() ||
      this.now().getTime() - connection.last_seen_at.getTime() > MEETING_CAPTURE_LEASE_MS ||
      (verifier !== undefined && !proofMatches(verifier, connection.verifier_hash))
    )
      throw new MeetingCaptureError();
    return connection;
  }
  async register(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureConnectionInput
  ): Promise<MeetingCaptureConnectionResult> {
    const actor = await this.native(headers, requestId);
    const device = await this.deps.device(actor);
    const connection = await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lock(db, actor.deviceId);
      if (!this.deps.assertRecordingBinding) throw new MeetingCaptureError();
      await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: actor.deviceId,
        capabilityRevision: actor.capabilityRevision
      });
      return this.connections.register(db, {
        ...input,
        deviceId: actor.deviceId,
        deviceName: device.displayName,
        capabilityRevision: actor.capabilityRevision,
        at: this.now(),
        expiresAt: new Date(Math.min(actor.expiresAt.getTime(), device.expiresAt.getTime()))
      });
    });
    return {
      connectionId: connection.connection_id,
      revision: connection.revision,
      leaseMs: MEETING_CAPTURE_LEASE_MS,
      expiresAt: connection.expires_at.toISOString()
    };
  }
  async devices(actor: CaptureBrowserBinding): Promise<MeetingCaptureDevicesResult> {
    await this.deps.assertBinding({ actorUserId: actor.actorUserId, sessionId: actor.sessionId });
    const connections = await this.deps.dataContext.withDataContext(actor, (db) =>
      this.connections.connections(db)
    );
    const devices: MeetingCaptureDevicesResult["devices"][number][] = [];
    for (const connection of connections) {
      if (
        connection.expires_at <= this.now() ||
        this.now().getTime() - connection.last_seen_at.getTime() > MEETING_CAPTURE_LEASE_MS ||
        !this.deps.assertRecordingBinding
      )
        continue;
      try {
        await this.deps.assertRecordingBinding({
          actorUserId: actor.actorUserId,
          deviceId: connection.device_id,
          capabilityRevision: connection.capability_revision
        });
      } catch (error) {
        const failure = captureAuthorizationError(error);
        if (failure.httpStatus === 401) continue;
        throw failure;
      }
      const occupied = await this.deps.dataContext.withDataContext(actor, (db) =>
        this.connections.occupyingGrant(db, connection, this.now())
      );
      const occupiedState = occupied?.state_json ? captureState(occupied) : null;
      const busy =
        !!occupied &&
        (occupied.status !== "active" ||
          (occupiedState?.lastSeenAt !== null &&
            this.now().getTime() -
              Date.parse(occupiedState?.lastSeenAt ?? occupiedState?.originAt ?? "") <
              MEETING_CAPTURE_LEASE_MS));
      devices.push({
        busy,
        capturePhase: !busy
          ? null
          : occupied?.status === "finalizing"
            ? "finalizing"
            : occupiedState?.desired === "paused"
              ? "paused"
              : occupied?.status === "approved"
                ? "starting"
                : "recording",
        finalizationDeadline: occupiedState?.finalizationDeadline ?? null,
        deviceId: connection.device_id,
        deviceName: connection.device_name,
        connectionId: connection.connection_id,
        revision: connection.revision,
        capabilityRevision: connection.capability_revision,
        inventory: JSON.parse(connection.inventory_json) as MeetingCaptureInventory,
        lastSeenAt: connection.last_seen_at.toISOString(),
        expiresAt: connection.expires_at.toISOString()
      });
    }
    return { devices, processingReady: (await this.deps.processingAvailability(actor)).ready };
  }
  private async live(actor: AccessContext, grant: CaptureGrant) {
    if (!grant.session_id || !grant.capability_revision || !this.deps.assertRecordingBinding)
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
  private async replayStart(
    db: DataContextDb,
    actor: CaptureBrowserBinding,
    meetingId: string,
    input: MeetingCaptureStartInput,
    fingerprint: string
  ) {
    if (await this.connections.cancelled(db, input.requestKey))
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    const previous = await this.connections.byRequest(db, input.requestKey);
    if (previous) {
      if (
        previous.start_fingerprint !== fingerprint ||
        previous.meeting_id !== meetingId ||
        previous.status === "revoked" ||
        (previous.status === "approved" &&
          captureState(previous).desired !== "paused" &&
          (!previous.claim_expires_at || previous.claim_expires_at <= this.now())) ||
        previous.expires_at <= this.now()
      )
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      await this.live(actor, previous);
      return { capture: captureView(previous, captureState(previous), this.now()) };
    }
    return null;
  }
  async start(actor: CaptureBrowserBinding, meetingId: string, input: MeetingCaptureStartInput) {
    assertCaptureNoticeAcknowledged(input);
    await this.deps.assertBinding({
      actorUserId: actor.actorUserId,
      sessionId: actor.sessionId,
      deviceId: input.deviceId
    });
    const fingerprint = hash(
      captureMetadataJson({ meetingId, sessionId: actor.sessionId, ...input })
    );
    const replay = await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lock(db, input.deviceId);
      await this.grants.lockMeeting(db, meetingId);
      return this.replayStart(db, actor, meetingId, input, fingerprint);
    });
    if (replay) return replay;
    const processing = await this.deps.processingAvailability(actor).catch(() => null);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lock(db, input.deviceId);
      await this.grants.lockMeeting(db, meetingId);
      const raced = await this.replayStart(db, actor, meetingId, input, fingerprint);
      if (raced) return raced;
      if (!processing?.ready || !processing.modelRoute)
        throw new MeetingCaptureError("meeting_capture_processing_unavailable", 503);
      const connection = await this.connections.connection(db, input.deviceId);
      if (
        !connection ||
        connection.connection_id !== input.connectionId ||
        connection.revision !== input.expectedRevision ||
        connection.expires_at <= this.now() ||
        this.now().getTime() - connection.last_seen_at.getTime() > MEETING_CAPTURE_LEASE_MS
      )
        throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
      await this.deps.assertBinding({
        actorUserId: actor.actorUserId,
        sessionId: actor.sessionId,
        deviceId: input.deviceId
      });
      if (!this.deps.assertRecordingBinding) throw new MeetingCaptureError();
      const capability = await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: input.deviceId,
        capabilityRevision: connection.capability_revision
      });
      const inventory = JSON.parse(connection.inventory_json) as MeetingCaptureInventory;
      validateCaptureSelection(input.selection, inventory);
      await this.connections.retire(db, input.deviceId, this.now());
      if (
        (await this.connections.occupied(db, input.deviceId, input.connectionId)) ||
        (await this.grants.grants(db, meetingId)).some(
          (g) => g.status === "active" || g.status === "approved"
        )
      )
        throw new MeetingCaptureError("meeting_capture_busy", 409);
      const previousGrants = await this.grants.grants(db, meetingId);
      if (previousGrants.length >= 20) throw new MeetingCaptureError("meeting_capture_limit", 413);
      if (
        previousGrants.some(
          (row) => row.state_json !== null && captureState(row).observed !== null
        ) ||
        (await this.grants.transcriptHead(db, meetingId)).version > 0
      )
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      const state: CaptureStoredState = {
        gaps: [],
        gapLimitReached: false,
        generation: 0,
        desired: "idle",
        originAt: this.now().toISOString(),
        epochs: [],
        stopCutoffMs: null,
        finalizationDeadline: null,
        inventory,
        observed: null,
        lastSeenAt: connection.last_seen_at.toISOString(),
        recordedDurationMs: 0,
        processing: { status: "ready" },
        transcriptRevision: 0
      };
      applyCaptureControl(
        state,
        {
          grantId: input.requestKey,
          requestKey: input.requestKey,
          expectedGeneration: 0,
          command: "record",
          noticeAcknowledged: input.noticeAcknowledged,
          selection: input.selection
        },
        this.now(),
        processing.modelRoute!
      );
      const grant = await this.connections.create(db, {
        meetingId,
        sessionId: actor.sessionId,
        connection,
        requestKey: input.requestKey,
        fingerprint,
        expiresAt: new Date(
          Math.min(
            this.now().getTime() + 7200000,
            actor.expiresAt.getTime(),
            capability.expiresAt.getTime(),
            connection.expires_at.getTime()
          )
        ),
        claimExpiresAt: new Date(this.now().getTime() + MEETING_CAPTURE_CLAIM_MS),
        state
      });
      return { capture: captureView(grant, state, this.now()) };
    });
  }
  async commands(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureCommandsInput
  ): Promise<MeetingCaptureCommandsResult> {
    const actor = await this.native(headers, requestId);
    const grant = await this.deps.dataContext.withDataContext(actor, async (db) => {
      const connection = this.valid(
        await this.connections.connection(db, actor.deviceId),
        actor,
        input.connectionId,
        input.verifier
      );
      return this.connections.command(db, connection, this.now());
    });
    if (!grant) return { revision: "none", retryAfterMs: 1000, command: null };
    await this.live(actor, grant);
    return {
      revision: `${grant.id}:${captureState(grant).generation}:${grant.claim_expires_at!.getTime()}`,
      retryAfterMs: 1000,
      command: {
        meetingId: grant.meeting_id,
        grantId: grant.id,
        ownerUserId: actor.actorUserId,
        generation: captureState(grant).generation,
        capabilityRevision: grant.capability_revision!,
        expiresAt: grant.claim_expires_at!.toISOString(),
        selection: captureState(grant).epochs.at(-1)!.selection
      }
    };
  }
  async claim(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureClaimInput
  ): Promise<MeetingCaptureClaimResult> {
    const actor = await this.native(headers, requestId);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lock(db, actor.deviceId);
      const connection = this.valid(
        await this.connections.connection(db, actor.deviceId),
        actor,
        input.connectionId,
        input.verifier
      );
      const initial = await this.grants.grant(db, input.grantId);
      if (!initial) throw new MeetingCaptureError();
      await this.grants.lockMeeting(db, initial.meeting_id);
      const grant = await this.grants.grant(db, input.grantId, true);
      if (
        !grant ||
        grant.device_id !== actor.deviceId ||
        grant.connection_id !== connection.connection_id ||
        grant.capability_revision !== actor.capabilityRevision ||
        grant.verifier_hash !== connection.verifier_hash ||
        grant.expires_at <= this.now()
      )
        throw new MeetingCaptureError();
      await this.live(actor, grant);
      if (grant.credential_hash) {
        if (
          grant.credential_hash !== input.credentialHash ||
          !["active", "finalizing", "complete"].includes(grant.status)
        )
          throw new MeetingCaptureError("meeting_capture_conflict", 409);
      } else {
        if (
          grant.status !== "approved" ||
          !grant.claim_expires_at ||
          grant.claim_expires_at <= this.now()
        )
          throw new MeetingCaptureError();
        const state = captureState(grant);
        if (state.desired !== "recording")
          throw new MeetingCaptureError("meeting_capture_conflict", 409);
        const epoch = state.epochs.at(-1)!;
        validateCaptureSelection(
          epoch.selection,
          JSON.parse(connection.inventory_json) as MeetingCaptureInventory
        );
        // A pending Start owns no hardware time. Anchor the meeting clock at activation.
        state.originAt = this.now().toISOString();
        state.epochs = [{ ...epoch, epoch: 1, startMs: 0, endMs: null }];
        state.lastSeenAt = this.now().toISOString();
        await this.grants.activate(db, grant, input.credentialHash, state);
        grant.status = "active";
        grant.credential_hash = input.credentialHash;
        grant.state_json = JSON.stringify(state);
      }
      return {
        meetingId: grant.meeting_id,
        grantId: grant.id,
        expiresAt: grant.expires_at.toISOString(),
        capture: captureView(grant, captureState(grant), this.now())
      };
    });
  }
}
