import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isUuid, type AccessContext, type DataContextDb, type DataContextRunner } from "@moss/db";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureAudioReceipt,
  MeetingCaptureBrowserStatus,
  MeetingCaptureControlInput,
  MeetingCaptureLink,
  MeetingCaptureLinkInput,
  MeetingCaptureRedeemInput,
  MeetingCaptureRedeemResult,
  MeetingCaptureState,
  MeetingCaptureStatusInput,
  MeetingTranscriptSource
} from "@moss/shared";
import {
  applyCaptureControl,
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
  type CaptureGrant,
  type CaptureLink
} from "./capture-repository.js";
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
export interface MeetingCaptureDependencies {
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
    private readonly transcript = new MeetingTranscriptRepository()
  ) {
    this.now = deps.now ?? (() => new Date());
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
    } catch {
      throw new MeetingCaptureError();
    }
    await this.deps.assertModuleAvailable(actor);
    return actor;
  }
  private async preflight(grant: CaptureGrant, actor: AccessContext) {
    if (!grant.session_id) throw new MeetingCaptureError();
    try {
      await this.deps.assertBinding({
        actorUserId: actor.actorUserId,
        sessionId: grant.session_id,
        deviceId: grant.device_id
      });
    } catch {
      throw new MeetingCaptureError();
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
  private async companion(headers: IncomingHttpHeaders, requestId: string) {
    if (headers.cookie) throw new MeetingCaptureError();
    try {
      return await this.deps.resolveCompanion({ headers, requestId });
    } catch {
      throw new MeetingCaptureError();
    }
  }
  async link(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureLinkInput
  ): Promise<MeetingCaptureLink> {
    const actor = await this.companion(headers, requestId);
    await this.deps.assertModuleAvailable(actor);
    const device = await this.deps.device(actor);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      const grant = await this.repository.createLink(db, {
        meetingId: input.meetingId,
        deviceId: actor.deviceId,
        deviceName: device.displayName,
        verifierHash: input.verifierHash,
        expiresAt: new Date(this.now().getTime() + 600000)
      });
      return {
        challengeId: grant.id,
        meetingId: grant.meeting_id,
        deviceId: grant.device_id,
        expiresAt: grant.expires_at.toISOString()
      };
    });
  }
  private validLink(link: CaptureLink | null, meetingId: string, deviceId?: string) {
    if (
      !link ||
      link.meeting_id !== meetingId ||
      (deviceId && link.device_id !== deviceId) ||
      link.expires_at <= this.now()
    )
      throw new MeetingCaptureError();
    return link;
  }
  async approve(actor: CaptureBrowserBinding, meetingId: string, challengeId: string) {
    const link = this.validLink(
      await this.deps.dataContext.withDataContext(actor, (db) =>
        this.repository.link(db, challengeId)
      ),
      meetingId
    );
    const device = await this.deps.device({
      actorUserId: actor.actorUserId,
      deviceId: link.device_id
    });
    const expiresAt = new Date(
      Math.min(
        this.now().getTime() + 7200000,
        actor.expiresAt.getTime(),
        device.expiresAt.getTime()
      )
    );
    await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.repository.lockMeeting(db, meetingId);
      const current = this.validLink(await this.repository.link(db, challengeId, true), meetingId);
      const existing = await this.repository.grant(db, challengeId);
      if (existing?.session_id === actor.sessionId && existing.status === "approved") return;
      if (current.status !== "pending") throw new MeetingCaptureError();
      if ((await this.repository.grants(db, meetingId)).length >= 20)
        throw new MeetingCaptureError("meeting_capture_limit", 413);
      await this.repository.approve(db, current, actor.sessionId, expiresAt);
    });
    return { approved: true as const };
  }
  async redeem(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureRedeemInput
  ): Promise<MeetingCaptureRedeemResult> {
    const actor = await this.companion(headers, requestId);
    const prove = (grant: CaptureGrant | null) => {
      const row = this.valid(grant, input.meetingId, actor.deviceId);
      if (
        !matches(input.verifier, row.verifier_hash) ||
        this.now().getTime() - row.created_at.getTime() > 600000 ||
        !["pending", "approved"].includes(row.status)
      )
        throw new MeetingCaptureError();
      return row;
    };
    const link = this.validLink(
      await this.deps.dataContext.withDataContext(actor, (db) =>
        this.repository.link(db, input.challengeId)
      ),
      input.meetingId,
      actor.deviceId
    );
    if (!matches(input.verifier, link.verifier_hash)) throw new MeetingCaptureError();
    if (link.status === "pending") return { status: "pending" };
    const initial = prove(
      await this.deps.dataContext.withDataContext(actor, (db) =>
        this.repository.grant(db, input.challengeId)
      )
    );
    if (initial.status === "pending") return { status: "pending" };
    await this.preflight(initial, actor);
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.repository.lockMeeting(db, input.meetingId);
      const grant = prove(await this.repository.grant(db, input.challengeId, true));
      await this.repository.revokeExpired(db, input.meetingId, this.now());
      if (
        (await this.repository.grants(db, input.meetingId)).some((row) => row.status === "active")
      )
        throw new MeetingCaptureError("meeting_capture_busy", 409);
      const credential = `mm1_${actor.actorUserId}.${grant.id}.${randomBytes(32).toString("base64url")}`;
      const state: CaptureStoredState = {
        gaps: [],
        gapLimitReached: false,
        generation: 0,
        desired: "idle",
        originAt: this.now().toISOString(),
        epochs: [],
        stopCutoffMs: null,
        finalizationDeadline: null,
        inventory: null,
        observed: null,
        lastSeenAt: null
      };
      await this.repository.activate(db, grant, hash(credential), state);
      return {
        status: "issued",
        credential,
        grantId: grant.id,
        expiresAt: grant.expires_at.toISOString()
      };
    });
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
    if (grant.status !== "active" || !matches(credential, grant.credential_hash))
      throw new MeetingCaptureError();
    await this.preflight(grant, actor);
    return { actor, grant, credential };
  }
  private async locked(db: DataContextDb, proof: NativeProof): Promise<CaptureGrant> {
    await this.repository.lockMeeting(db, proof.grant.meeting_id);
    const grant = this.valid(
      await this.repository.grant(db, proof.grant.id, true),
      proof.grant.meeting_id,
      proof.grant.device_id
    );
    if (grant.status !== "active" || !matches(proof.credential, grant.credential_hash))
      throw new MeetingCaptureError();
    return grant;
  }
  async status(headers: IncomingHttpHeaders, requestId: string, input: MeetingCaptureStatusInput) {
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    return this.deps.dataContext.withDataContext(proof.actor, async (db) => {
      const grant = await this.locked(db, proof);
      const state = captureState(grant);
      await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
      expireCaptureLease(state, this.now(), grant.expires_at);
      if (input.observed.generation > state.generation)
        throw new MeetingCaptureError("meeting_capture_conflict", 409);
      if (
        input.observed.generation === state.generation &&
        (input.observed.phase === "error" || input.observed.phase === "paused") &&
        state.desired === "recording"
      )
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
      for (const gap of input.gaps ?? []) retainCaptureGap(state, gap, this.now());
      state.inventory = input.inventory;
      if (!state.gapLimitReached) state.observed = input.observed;
      else if (
        input.observed.generation === state.generation &&
        (input.observed.phase === "paused" || input.observed.phase === "stopped")
      ) {
        // Keep the loss warning without hiding a current-generation safe stop acknowledgement.
        state.observed = { ...input.observed, errorCode: "meeting_capture_limit" };
      }
      state.lastSeenAt = this.now().toISOString();
      await this.repository.save(db, grant, state);
      return { capture: captureView(grant, state, this.now()) };
    });
  }
  async browserStatus(
    actor: CaptureBrowserBinding,
    meetingId: string
  ): Promise<MeetingCaptureBrowserStatus> {
    const result = await this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.repository.lockMeeting(db, meetingId);
      const grants = await this.repository.grants(db, meetingId);
      const links = await this.repository.links(db, meetingId);
      const grant =
        grants.find((row) => row.status === "active") ??
        grants.find((row) => row.state_json !== null);
      let capture: MeetingCaptureState | null = null;
      if (grant?.state_json) {
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        expireCaptureLease(state, this.now(), grant.expires_at);
        if (grant.expires_at <= this.now() || grant.status === "revoked") state.desired = "revoked";
        await this.repository.save(db, grant, state);
        capture = captureView(grant, state, this.now());
      }
      return {
        capture,
        pendingLinks: links.map((row) => ({
          challengeId: row.id,
          meetingId,
          deviceId: row.device_id,
          deviceName: row.device_name,
          expiresAt: row.expires_at.toISOString()
        }))
      };
    });
    const processing = await this.deps.processingAvailability(actor);
    return { ...result, processingReady: processing.ready };
  }
  async browserControl(
    actor: CaptureBrowserBinding,
    meetingId: string,
    input: MeetingCaptureControlInput
  ) {
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
    input: MeetingCaptureControlInput & { meetingId: string; grantId: string }
  ) {
    if (input.command !== "pause" && input.command !== "stop") throw new MeetingCaptureError();
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    return this.control(proof.actor, input.grantId, input.meetingId, input, proof);
  }
  private async control(
    actor: AccessContext,
    grantId: string,
    meetingId: string,
    input: MeetingCaptureControlInput,
    proof?: NativeProof
  ) {
    const processing =
      input.command === "record" ? await this.deps.processingAvailability(actor) : null;
    if (input.command === "record" && (!processing?.ready || !processing.modelRoute))
      throw new MeetingCaptureError("meeting_capture_processing_unavailable", 503);
    const fingerprint = hash(
      JSON.stringify({
        expectedGeneration: input.expectedGeneration,
        command: input.command,
        selection: input.selection ?? null,
        noticeAcknowledged: input.noticeAcknowledged ?? false
      })
    );
    return this.deps.dataContext.withDataContext(actor, async (db) => {
      await this.repository.lockMeeting(db, meetingId);
      const grant = proof
        ? await this.locked(db, proof)
        : await this.repository.grant(db, grantId, true);
      if (!grant || grant.meeting_id !== meetingId || grant.id !== input.grantId)
        throw new MeetingCaptureError();
      if (input.command !== "revoke") this.valid(grant, meetingId);
      const previous = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
      if (previous?.result_json)
        return JSON.parse(previous.result_json) as { capture: MeetingCaptureState };
      const state = captureState(grant);
      await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
      expireCaptureLease(state, this.now(), grant.expires_at);
      applyCaptureControl(state, input, this.now(), processing?.modelRoute ?? "");
      await this.repository.save(db, grant, state);
      if (input.command === "stop") {
        const head = await this.repository.transcriptHead(db, meetingId);
        if (head.version > 0 && head.stop_cutoff_ms === null) {
          const retained = await this.transcript.snapshotWithSources(db, meetingId, {
            maxSegments: 1,
            maxCharacters: 1
          });
          if (retained)
            await this.transcript.ingest(db, {
              meetingId,
              requestKey: input.requestKey,
              expectedVersion: head.version,
              sources: retained.sources,
              events: [],
              stopCutoffMs: state.stopCutoffMs
            });
        }
      }
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
  async audio(
    headers: IncomingHttpHeaders,
    requestId: string,
    input: MeetingCaptureAudioInput
  ): Promise<MeetingCaptureAudioReceipt> {
    const proof = await this.authenticate(headers, requestId, input.meetingId, input.grantId);
    const { pcm, fingerprint } = decodeCaptureAudio(input);
    const reservation = await this.deps.dataContext.withDataContext(proof.actor, async (db) => {
      const grant = await this.locked(db, proof);
      await this.repository.reconcileExpiredAudio(db, grant, captureState(grant), this.now());
      const prior = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
      if (prior)
        return {
          result: prior.result_json
            ? { ...(JSON.parse(prior.result_json) as MeetingCaptureAudioReceipt), replayed: true }
            : { requestKey: input.requestKey, status: "pending" as const }
        };
      const state = captureState(grant);
      await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
      const epoch = assertCaptureAudioAdmission(state, input, this.now());
      await this.repository.admitAudio(db, grant, input, fingerprint);
      return { modelRoute: epoch.modelRoute };
    });
    if (reservation.result) return reservation.result;
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
        const admitted = await this.deps.dataContext.withDataContext(proof.actor, async (db) => {
          const grant = await this.locked(db, proof);
          assertCaptureAudioAdmission(captureState(grant), input, this.now());
          if (validate) await validate(db);
          // This port uses the independent auth pool, never module availability/app connections.
          await this.deps.assertBinding({
            actorUserId: proof.actor.actorUserId,
            sessionId: grant.session_id!,
            deviceId: grant.device_id
          });
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
      const generated = await abortable(
        signal,
        this.deps.transcribe(proof.actor, {
          audio: pcmWave(pcm, input.sampleRateHz),
          sampleRateHz: input.sampleRateHz,
          signal,
          expectedModelRoute: reservation.modelRoute!,
          dispatch
        })
      );
      if (
        !dispatched ||
        signal.aborted ||
        generated.modelRoute !== reservation.modelRoute ||
        generated.segments.length > 100
      )
        throw new MeetingCaptureError("meeting_capture_processing_failed", 502);
      let characters = 0;
      for (const segment of generated.segments) {
        characters += segment.text.length;
        if (
          !Number.isSafeInteger(segment.startMs) ||
          !Number.isSafeInteger(segment.endMs) ||
          segment.startMs < 0 ||
          segment.endMs <= segment.startMs ||
          segment.endMs > input.endMs - input.startMs ||
          typeof segment.text !== "string" ||
          segment.text.includes("\0") ||
          characters > 64000
        )
          throw new MeetingCaptureError("meeting_capture_processing_failed", 502);
      }
      await this.preflight(proof.grant, proof.actor);
      return await this.deps.dataContext.withDataContext(proof.actor, async (db) => {
        const grant = await this.locked(db, proof);
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        const epoch = state.epochs.find(
          (entry) => entry.epoch === input.epoch && entry.generation === input.generation
        );
        if (
          !epoch ||
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
        const sources: MeetingTranscriptSource[] = [...(retained?.sources ?? [])];
        const source = sources.find(
          (entry) => entry.sourceId === input.sourceId && entry.epoch === input.epoch
        );
        if (source)
          sources[sources.indexOf(source)] = {
            ...source,
            endMs: Math.max(source.endMs, input.endMs)
          };
        else
          sources.push({
            sourceId: input.sourceId,
            epoch: input.epoch,
            kind: input.sourceId === epoch.selection.microphone.sourceId ? "microphone" : "output",
            label:
              input.sourceId === epoch.selection.microphone.sourceId
                ? epoch.microphoneLabel
                : epoch.outputLabel!,
            startMs: epoch.startMs,
            endMs: input.endMs
          });
        const saved = await this.transcript.ingest(db, {
          meetingId: input.meetingId,
          requestKey: input.requestKey,
          expectedVersion: head.version,
          sources,
          events: generated.segments.map((segment, index) => ({
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
          throw new MeetingCaptureError("meeting_capture_conflict", 409);
        const result: MeetingCaptureAudioReceipt = {
          requestKey: input.requestKey,
          status: "saved",
          transcriptRevision: saved.receipt.transcriptRevision,
          replayed: false
        };
        await this.repository.finish(db, grant.id, result);
        return result;
      });
    } catch {
      const result: MeetingCaptureAudioReceipt = {
        requestKey: input.requestKey,
        status: "failed",
        code: "meeting_capture_processing_failed"
      };
      // Revoked/deleted authorization suppresses even failure receipts from native callers.
      await this.preflight(proof.grant, proof.actor);
      return this.deps.dataContext.withDataContext(proof.actor, async (db) => {
        const grant = await this.locked(db, proof);
        const previous = await this.repository.receipt(db, grant.id, input.requestKey, fingerprint);
        if (previous?.result_json)
          return JSON.parse(previous.result_json) as MeetingCaptureAudioReceipt;
        const state = captureState(grant);
        await this.repository.reconcileExpiredAudio(db, grant, state, this.now());
        retainCaptureGap(
          state,
          {
            id: randomUUID(),
            sourceId: input.sourceId,
            epoch: input.epoch,
            startMs: input.startMs,
            endMs: input.endMs,
            reason: "processing-failed"
          },
          this.now()
        );
        await this.repository.save(db, grant, state);
        await this.repository.finish(db, grant.id, result);
        return result;
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
