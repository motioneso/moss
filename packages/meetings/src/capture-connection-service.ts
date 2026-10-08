import { withCaptureBindingTransaction } from "./capture-binding.js";
import { MeetingCaptureStartLimiter } from "./capture-start-limiter.js";
import {
  MeetingPreferencesRepository,
  resolveCaptureSource,
  savedCaptureSelection
} from "./preferences.js";
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
  type MeetingCaptureStartRequest
} from "@moss/shared";
import {
  applyCaptureControl,
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
    readonly connections = new MeetingCaptureConnectionRepository(),
    private readonly preferences = new MeetingPreferencesRepository(),
    private readonly startLimiter = new MeetingCaptureStartLimiter()
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
  private async defaultConnection(
    db: DataContextDb,
    actor: CaptureBrowserBinding,
    deviceId?: string
  ) {
    const candidates = deviceId
      ? [await this.connections.connection(db, deviceId)].filter(
          (item): item is CaptureConnection => item !== null
        )
      : await this.connections.connections(db);
    // A full bounded page cannot prove that no additional eligible Mac exists.
    if (!deviceId && candidates.length >= 32)
      throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
    const eligible: CaptureConnection[] = [];
    for (const connection of candidates) {
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
      eligible.push(connection);
    }
    if (eligible.length !== 1)
      throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
    return eligible[0]!;
  }
  private async replayStart(
    db: DataContextDb,
    actor: CaptureBrowserBinding,
    meetingId: string,
    input: MeetingCaptureStartRequest,
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
      return {
        capture: captureView(previous, captureState(previous), this.now()),
        wakeConnectionId: previous.connection_id
      };
    }
    return null;
  }
  async start(actor: CaptureBrowserBinding, meetingId: string, input: MeetingCaptureStartRequest) {
    await this.deps.assertBinding({ actorUserId: actor.actorUserId, sessionId: actor.sessionId });
    await this.deps.dataContext.withDataContext(actor, (db) => this.startLimiter.consume(db));
    const fingerprint = hash(
      captureMetadataJson({ meetingId, sessionId: actor.sessionId, ...input })
    );
    const initial = await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lockRequest(db, input.requestKey);
      const prior = await this.connections.byRequest(db, input.requestKey);
      const preferences = await this.preferences.get(db);
      const connection = prior
        ? null
        : await this.defaultConnection(db, actor, preferences.rememberedSource?.deviceId);
      const deviceId = prior?.device_id ?? connection!.device_id;
      await this.connections.lock(db, deviceId);
      await this.grants.lockMeeting(db, meetingId);
      const replay = await this.replayStart(db, actor, meetingId, input, fingerprint);
      if (replay) return { replay };
      if ("deviceId" in input)
        throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
      const source = resolveCaptureSource(
        preferences,
        deviceId,
        JSON.parse(connection!.inventory_json) as MeetingCaptureInventory
      );
      return { source, preferences };
    });
    if (initial.replay) return initial.replay;
    const source = initial.source;
    const processing = await this.deps.processingAvailability(actor).catch(() => null);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.connections.lockRequest(db, input.requestKey);
      await this.connections.lock(db, source.deviceId);
      await this.grants.lockMeeting(db, meetingId);
      const raced = await this.replayStart(db, actor, meetingId, input, fingerprint);
      if (raced) return raced;
      const preferences = await this.preferences.get(db);
      if (captureMetadataJson(preferences) !== captureMetadataJson(initial.preferences))
        throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
      if (!processing?.ready || !processing.modelRoute)
        throw new MeetingCaptureError("meeting_capture_processing_unavailable", 503);
      const connection = await this.defaultConnection(
        db,
        actor,
        preferences.rememberedSource?.deviceId
      );
      if (
        connection.device_id !== source.deviceId ||
        captureMetadataJson(
          resolveCaptureSource(
            preferences,
            source.deviceId,
            JSON.parse(connection.inventory_json) as MeetingCaptureInventory
          )
        ) !== captureMetadataJson(source)
      )
        throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
      await this.deps.assertBinding({
        actorUserId: actor.actorUserId,
        sessionId: actor.sessionId,
        deviceId: source.deviceId
      });
      if (!this.deps.assertRecordingBinding) throw new MeetingCaptureError();
      const capability = await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: source.deviceId,
        capabilityRevision: connection.capability_revision
      });
      const inventory = JSON.parse(connection.inventory_json) as MeetingCaptureInventory;
      const selection = savedCaptureSelection(source, inventory);
      await this.connections.retire(db, source.deviceId, this.now());
      if (
        (await this.connections.occupied(db, source.deviceId, connection.connection_id)) ||
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
        maintenanceSequence: 0,
        automaticRecoveryCount: 0,
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
          selection
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
      await this.deps.scheduleMaintenance(db, actor, {
        grantId: grant.id,
        sequence: 0,
        at: this.now()
      });
      return {
        capture: captureView(grant, state, this.now()),
        wakeConnectionId: connection.connection_id
      };
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
    return withCaptureBindingTransaction(
      this.deps,
      actor,
      async (db) => {
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
        return grant;
      },
      async (db, grant) => {
        const connection = this.valid(
          await this.connections.connection(db, actor.deviceId),
          actor,
          input.connectionId,
          input.verifier
        );
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
      }
    );
  }
}
