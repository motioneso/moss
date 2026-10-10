import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { registerCompanionRecordingRoutes } from "./companion-recording-routes.js";

import { redactSecrets } from "@moss/ai";
import { CompanionAuthError, type CompanionContext, type MossAuthRuntime } from "@moss/auth";
import {
  BACKTRACK_INDEX_QUEUE,
  BacktrackRepository,
  type NewBacktrackSegmentInput
} from "@moss/backtrack";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { sendJob } from "@moss/jobs";
import {
  FOCUS_JUDGE_TIMEOUT_MS,
  FocusError,
  type FocusJudgmentService
} from "@moss/module-registry";
import { BACKTRACK_STORAGE_CONFIG_KEY, RuntimeConfigResolver } from "@moss/settings";
import {
  backtrackUploadRouteSchema,
  cancelPairAttemptRouteSchema,
  companionHeartbeatRouteSchema,
  companionLogoutRouteSchema,
  companionProtocolRouteSchema,
  COMPANION_PAIR_POLL_INTERVAL_SECONDS,
  COMPANION_PROTOCOL_VERSION,
  createPairAttemptRouteSchema,
  decidePairAttemptRouteSchema,
  focusContextRouteSchema,
  focusCorrectRouteSchema,
  FOCUS_JUDGE_BODY_LIMIT_BYTES,
  focusJudgeRouteSchema,
  getPairAttemptRouteSchema,
  redeemPairAttemptRouteSchema,
  renameCompanionDeviceRouteSchema,
  type BacktrackState,
  type BacktrackUploadRequest,
  type CompanionHeartbeatRequest,
  type CreatePairAttemptRequest,
  type FocusCorrectRequest,
  type FocusJudgeRequest,
  type RedeemPairAttemptRequest
} from "@moss/shared";

/**
 * Trail Marker companion routes (#2560).
 *
 * Three audiences, three ways in, and they never mix:
 *   - the Mac app, unauthenticated, starting or abandoning a pairing attempt;
 *   - the signed-in browser, deciding an attempt it was handed the code for;
 *   - the linked Mac, holding a companion credential, acting on its own device row.
 *
 * A companion credential is accepted here and by identity-only meeting approval bootstrap;
 * it never authorizes meeting capture or transcript data. The reverse also holds by
 * construction: the general resolver passes every bearer token to the legacy UUID
 * session lookup, which rejects a `tm1_` value, so this credential authenticates no
 * other route in the product.
 */

/** Starting, abandoning or probing. A person does these by hand, a few times at most. */
const PAIR_RATE_MAX = 20;

/**
 * Polling redeem. The server tells each Mac to ask every 3 seconds, which is 20 a minute,
 * and several Macs behind one home router share an address, so a 20 bucket would reject
 * ordinary use. 120 leaves room for six Macs linking at once.
 */
const REDEEM_RATE_MAX = 120;

/**
 * Unauthenticated pairing endpoints are pre-credential, so Authorization and Cookie are
 * fully attacker-controlled and cannot key a bucket. Key on the peer IP. This must be set
 * explicitly: a per-route rateLimit without a keyGenerator inherits the global principal
 * key, which an attacker mints a fresh bucket in by varying a junk bearer token.
 */
function ipRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`
    }
  };
}

/**
 * Focus routes, keyed on the peer address like the rest (the credential is not yet resolved when
 * the limiter runs, and a limiter keyed on it would give an attacker a fresh bucket per junk
 * token). A Mac asks for context about once a minute and judges at most every few minutes; the
 * limits leave room for several Macs behind one address.
 */
const FOCUS_CONTEXT_RATE_MAX = 60;
const FOCUS_JUDGE_RATE_MAX = 30;
const FOCUS_CORRECT_RATE_MAX = 30;

/**
 * Backtrack phase 2a ingest (#2638 plan 2026-10-03-backtrack-phase2.md §4.4). A Mac flushes its
 * buffer on a 60s timer (§5.1), so ten a minute leaves headroom for a retry after a lost response
 * without opening the route to abuse — keyed on IP like the other pre-credential-cheap routes
 * above (the credential is resolved inside the handler, not by the limiter).
 */
const BACKTRACK_UPLOAD_RATE_MAX = 10;

/** Decision 11: a request whose sentAt is further than this from receipt is 422 backtrack_clock. */
const BACKTRACK_MAX_SKEW_MS = 60 * 60 * 1000;

/** Decision 11: the 24-hour retention buffer plus slack, measured after shifting to server time. */
const BACKTRACK_MAX_SEGMENT_AGE_MS = 26 * 60 * 60 * 1000;

const BACKTRACK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const BACKTRACK_SEGMENT_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface CompanionRouteDeps {
  readonly authRuntime: MossAuthRuntime;
  readonly dataContext: DataContextRunner;
  readonly focus: FocusJudgmentService;
  readonly boss: PgBoss;
}

export function registerCompanionRoutes(server: FastifyInstance, deps: CompanionRouteDeps): void {
  const { authRuntime, dataContext, focus, boss } = deps;
  const pairing = authRuntime.companionPairing;
  const devices = authRuntime.companionDevices;
  registerCompanionRecordingRoutes(server, authRuntime);
  const backtrack = new BacktrackRepository();

  /** Decision 1: the instance switch alone, with no preferences read — the cheap half of state. */
  async function resolveBacktrackStorage(actorUserId: string): Promise<"off" | "on"> {
    return dataContext.withDataContext({ actorUserId }, (scopedDb) =>
      new RuntimeConfigResolver(scopedDb).resolveEnum<"off" | "on">(BACKTRACK_STORAGE_CONFIG_KEY)
    );
  }

  /** The person's current Backtrack state (decisions 1 and 6), for the heartbeat. */
  async function resolveBacktrackState(actorUserId: string): Promise<BacktrackState> {
    return dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
      const storage = await new RuntimeConfigResolver(scopedDb).resolveEnum<"off" | "on">(
        BACKTRACK_STORAGE_CONFIG_KEY
      );
      const prefs = await backtrack.getPreferences(scopedDb, actorUserId);
      return { storage, paused: prefs?.paused ?? false };
    });
  }

  /**
   * Resolves the signed-in browser. `requireTrustedOrigin` adds a same-origin check. Both
   * browser routes are POSTs carrying the approval code in the body, and a browser sends an
   * Origin header on every POST, so both can demand one.
   */
  async function requireBrowserActor(
    request: FastifyRequest,
    reply: FastifyReply,
    requireTrustedOrigin: boolean
  ): Promise<string | null> {
    let actorUserId: string;
    try {
      actorUserId = (await authRuntime.resolveAccessContext(request)).actorUserId;
    } catch (error) {
      sendAccessContextFailure(reply, error);
      return null;
    }

    if (requireTrustedOrigin) {
      // Approving a device is a state change made with a cookie, so it needs a same-origin
      // check of its own. A missing Origin is refused rather than trusted, because a browser
      // sends one on every cross-site POST.
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !authRuntime.trustedOrigins.includes(origin)) {
        reply.code(403).send({ error: "Request origin is not trusted", code: "invalid_origin" });
        return null;
      }
    }

    return actorUserId;
  }

  /** Resolves the calling Mac from its bearer credential. Never consults cookies. */
  async function requireCompanion(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<CompanionContext | null> {
    try {
      return await devices.resolve({ headers: request.headers, requestId: request.id });
    } catch (error) {
      if (error instanceof CompanionAuthError) {
        reply.code(error.httpStatus).send({ error: messageFor(error.code), code: error.code });
        return null;
      }
      throw error;
    }
  }

  // Lets the app confirm it is talking to a Moss server new enough to link, before it
  // shows the user a pairing screen. Carries no account information at all.
  server.post(
    "/api/companion/protocol",
    { schema: companionProtocolRouteSchema, config: ipRateLimit(PAIR_RATE_MAX) },
    async () => ({ product: "moss" as const, companionProtocol: COMPANION_PROTOCOL_VERSION })
  );

  server.post<{ Body: CreatePairAttemptRequest }>(
    "/api/companion/pair",
    { schema: createPairAttemptRouteSchema, config: ipRateLimit(PAIR_RATE_MAX) },
    async (request) => {
      const attempt = await pairing.create(request.body);
      return {
        attemptId: attempt.attemptId,
        approvalPath: attempt.approvalPath,
        pollIntervalSeconds: COMPANION_PAIR_POLL_INTERVAL_SECONDS,
        expiresAt: attempt.expiresAt.toISOString()
      };
    }
  );

  // A POST for a read, so the approval code sits in the body. Fastify logs every request
  // URL, and a code in the query string would land in ordinary server logs while it is
  // still live.
  server.post<{ Body: { code: string } }>(
    "/api/companion/pair/attempt",
    { schema: getPairAttemptRouteSchema },
    async (request, reply) => {
      const actorUserId = await requireBrowserActor(request, reply, true);
      if (!actorUserId) return reply;

      const summary = await pairing.summarize({ approvalCode: request.body.code });
      // Unknown, expired and already-finished all answer 404, so a guessed code tells
      // the guesser nothing about whether it ever existed.
      if (!summary) return reply.code(404).send({ error: "That link request is no longer open" });
      return summary;
    }
  );

  server.post<{ Body: { code: string; decision: "approve" | "deny"; recordingPolicyVersion?: 1 } }>(
    "/api/companion/pair/decide",
    { schema: decidePairAttemptRouteSchema },
    async (request, reply) => {
      const actorUserId = await requireBrowserActor(request, reply, true);
      if (!actorUserId) return reply;

      // Recording capability is a separate permission: never grant it through a legacy bearer.
      const summary = await pairing.summarize({ approvalCode: request.body.code });
      let browserSessionId: string | undefined;
      if (summary?.recordingPolicyVersion === 1) {
        try {
          const browser = await authRuntime.sessionBindings.resolveBrowser({
            headers: request.headers,
            requestId: request.id
          });
          if (browser.actorUserId !== actorUserId) throw new Error("Unavailable");
          browserSessionId = browser.sessionId;
        } catch {
          return reply.code(401).send({
            error: "Sign in to approve this connection",
            code: "recording_approval_required"
          });
        }
        if (request.body.decision === "approve" && request.body.recordingPolicyVersion !== 1)
          return reply.code(400).send({
            error: "Review the recording connection permission",
            code: "recording_policy_required"
          });
      }
      // The approving account comes from the session, never from the body.
      const result = await pairing.decide({
        approvalCode: request.body.code,
        decision: request.body.decision,
        actorUserId,
        browserSessionId,
        recordingPolicyVersion: request.body.recordingPolicyVersion
      });

      if (result.ok) return { status: result.decision === "approve" ? "approved" : "denied" };
      if (result.reason === "not_pending") {
        return reply.code(409).send({ error: "That link request was already answered" });
      }
      return reply.code(404).send({ error: "That link request is no longer open" });
    }
  );

  server.post<{ Body: RedeemPairAttemptRequest }>(
    "/api/companion/pair/redeem",
    { schema: redeemPairAttemptRouteSchema, config: ipRateLimit(REDEEM_RATE_MAX) },
    async (request, reply) => {
      const result = await pairing.redeem(request.body);
      if (result.status === "issued") return result.response;

      // Still waiting on the person at the browser. 202 keeps the app polling.
      if (result.status === "pending") return reply.code(202).send({ status: "pending" });
      if (result.status === "denied") {
        return reply.code(403).send({ error: "The link request was declined" });
      }
      if (result.status === "expired") {
        return reply.code(410).send({ error: "The link request expired" });
      }
      if (result.status === "redeemed") {
        return reply.code(409).send({ error: "That link request was already used" });
      }
      // Unknown covers both a nonexistent attempt and a wrong verifier, on purpose.
      return reply.code(404).send({ error: "That link request is no longer open" });
    }
  );

  server.post<{ Body: RedeemPairAttemptRequest }>(
    "/api/companion/pair/cancel",
    { schema: cancelPairAttemptRouteSchema, config: ipRateLimit(PAIR_RATE_MAX) },
    async (request, reply) => {
      // Possession of the verifier is the whole authorization, and the answer is 204
      // either way: whether a row was there is not something a caller should learn.
      await pairing.cancel(request.body);
      return reply.code(204).send();
    }
  );

  server.post<{ Body: CompanionHeartbeatRequest }>(
    "/api/companion/heartbeat",
    { schema: companionHeartbeatRouteSchema },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;
      const beat = await devices.heartbeat(ctx, request.body);
      // #2638 Q7: the upload response always carries BacktrackState (so a Mac that is never
      // offline still learns it); the heartbeat carries the same shape too, since it runs far
      // more often than an upload while storage is off or paused.
      return { ...beat, backtrack: await resolveBacktrackState(ctx.actorUserId) };
    }
  );

  server.patch<{ Body: { displayName: string } }>(
    "/api/companion/device",
    { schema: renameCompanionDeviceRouteSchema },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;

      const displayName = request.body.displayName.trim();
      if (displayName.length === 0 || displayName.length > 64) {
        return reply.code(400).send({ error: "Pick a name between 1 and 64 characters" });
      }
      return { device: await devices.rename(ctx, displayName) };
    }
  );

  server.post(
    "/api/companion/logout",
    { schema: companionLogoutRouteSchema, config: ipRateLimit(PAIR_RATE_MAX) },
    async (request, reply) => {
      try {
        await devices.logoutCredential({ headers: request.headers });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof CompanionAuthError)
          return reply
            .code(error.httpStatus)
            .send({ error: "Companion credential unavailable", code: error.code });
        throw error;
      }
    }
  );

  // ---- Focus judgment (#2570) -------------------------------------------------------------
  // Platform routes, not module routes: a module route is gated by the module guard, which
  // resolves the actor with the general resolver and so rejects the companion credential. The
  // person and the Mac come from the credential only, never from the body, and the work runs on
  // a connection scoped to that person, so the owner-only row policies decide what is visible.
  // Nothing here logs a body field: window text must never reach a log.

  function focusAccess(ctx: CompanionContext) {
    return { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
  }

  // Which block is on, and whether an admin has set up the judgment model. With nothing set up it
  // answers quietly ("not ready", no block); it never errors, so an unconfigured server does not
  // strand a linked Mac.
  server.post(
    "/api/companion/focus/context",
    { schema: focusContextRouteSchema, config: ipRateLimit(FOCUS_CONTEXT_RATE_MAX) },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;
      const result = await dataContext.withDataContext(focusAccess(ctx), (scopedDb) =>
        focus.currentContext(scopedDb, new Date())
      );
      return {
        block: result.block
          ? {
              id: result.block.id,
              title: result.block.title,
              startsAt: result.block.startsAt.toISOString(),
              endsAt: result.block.endsAt.toISOString()
            }
          : null,
        judgmentReady: result.judgmentReady,
        judgeTakesImages: result.judgeTakesImages,
        judgeName: result.judgeName
      };
    }
  );

  server.post<{ Body: FocusJudgeRequest }>(
    "/api/companion/focus/judge",
    {
      schema: focusJudgeRouteSchema,
      // #3067: room for one screenshot. Every other companion route keeps the default limit.
      bodyLimit: FOCUS_JUDGE_BODY_LIMIT_BYTES,
      config: ipRateLimit(FOCUS_JUDGE_RATE_MAX)
    },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;

      // A picture replaces the description; the two together would judge two different things.
      if (request.body.image !== undefined && request.body.description !== undefined) {
        return reply.code(400).send({ error: "Send a picture or a description, not both" });
      }

      const observedAt = new Date(request.body.observedAt);
      if (Number.isNaN(observedAt.getTime())) {
        return reply.code(400).send({ error: "observedAt must be a date and time" });
      }

      try {
        return await dataContext.withDataContext(focusAccess(ctx), (scopedDb) =>
          focus.judge(
            scopedDb,
            {
              ownerUserId: ctx.actorUserId,
              deviceId: ctx.deviceId,
              blockId: request.body.blockId,
              appName: request.body.appName,
              windowTitle: request.body.windowTitle,
              description: request.body.description,
              image: request.body.image,
              observedAt
            },
            new Date(),
            AbortSignal.timeout(FOCUS_JUDGE_TIMEOUT_MS)
          )
        );
      } catch (error) {
        if (error instanceof FocusError) {
          return reply.code(409).send({ error: focusMessageFor(error.code), code: error.code });
        }
        throw error;
      }
    }
  );

  server.post<{ Body: FocusCorrectRequest }>(
    "/api/companion/focus/correct",
    { schema: focusCorrectRouteSchema, config: ipRateLimit(FOCUS_CORRECT_RATE_MAX) },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;
      const changed = await dataContext.withDataContext(focusAccess(ctx), (scopedDb) =>
        focus.recordCorrection(scopedDb, request.body.judgmentId, request.body.verdict)
      );
      // Absent and another person's row look the same on purpose.
      if (!changed) return reply.code(404).send({ error: "That judgment was not found" });
      return reply.code(204).send();
    }
  );

  // ---- Backtrack ingest (#2638 plan §4.4) -------------------------------------------------
  // Platform route, same reasoning as focus above: the companion credential names the owner
  // and the device, never the body, and the work runs under that owner's own row policies.
  // Nothing here logs a body field — window text, the page address and the captured body must
  // never reach a log or a job payload (metadata-only payloads, secrets-never-escape).

  server.post<{ Body: BacktrackUploadRequest }>(
    "/api/companion/backtrack",
    {
      schema: backtrackUploadRouteSchema,
      bodyLimit: BACKTRACK_BODY_LIMIT_BYTES,
      config: ipRateLimit(BACKTRACK_UPLOAD_RATE_MAX)
    },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;

      const storage = await resolveBacktrackStorage(ctx.actorUserId);
      if (storage !== "on") {
        return reply.code(409).send({
          error: backtrackMessageFor("backtrack_unavailable"),
          code: "backtrack_unavailable"
        });
      }

      const result = await dataContext.withDataContext(
        { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
        (scopedDb) =>
          runBacktrackIngest(backtrack, scopedDb, ctx.actorUserId, ctx.deviceId, request.body)
      );

      if (result.kind === "paused") {
        return reply
          .code(409)
          .send({ error: backtrackMessageFor("backtrack_paused"), code: "backtrack_paused" });
      }
      if (result.kind === "clock") {
        return reply
          .code(422)
          .send({ error: backtrackMessageFor("backtrack_clock"), code: "backtrack_clock" });
      }
      if (result.kind === "bad_request") {
        return reply.code(400).send({ error: result.message });
      }

      // Decision 5: the rows are already committed. Nothing past this point — a bad id, a
      // refused enqueue — may turn a successful ingest into an error response; the hourly
      // upkeep sweep (Task C/D) re-enqueues anything still unindexed after ten minutes, so a
      // missed enqueue here only delays indexing, it never loses a row.
      if (result.segmentIds.length > 0) {
        try {
          assertBacktrackSegmentIdsForJob(result.segmentIds);
          await sendJob(boss, BACKTRACK_INDEX_QUEUE, {
            actorUserId: ctx.actorUserId,
            segmentIds: result.segmentIds
          });
        } catch {
          request.log.warn(
            { requestId: ctx.requestId },
            "backtrack.index enqueue failed after commit; the hourly sweep will retry it"
          );
        }
      }

      request.log.info(
        {
          requestId: ctx.requestId,
          accepted: result.accepted,
          duplicates: result.duplicates,
          discarded: result.discarded,
          rejectedClock: result.rejectedClock
        },
        "backtrack upload"
      );

      return {
        accepted: result.accepted,
        duplicates: result.duplicates,
        discarded: result.discarded,
        rejectedClock: result.rejectedClock,
        state: { storage, paused: false }
      };
    }
  );
}

/**
 * The owner-locked heart of ingest (decisions 3, 10, 11), run inside one `withDataContext`
 * transaction so the advisory lock (`lockOwner`) covers every read and write below it. Returns a
 * plain result instead of throwing for the two expected non-2xx outcomes (paused, clock) so the
 * route can answer without unwinding a transaction that made no writes either way.
 */
async function runBacktrackIngest(
  backtrack: BacktrackRepository,
  scopedDb: DataContextDb,
  ownerUserId: string,
  deviceId: string,
  body: BacktrackUploadRequest
): Promise<
  | { readonly kind: "paused" }
  | { readonly kind: "clock" }
  | { readonly kind: "bad_request"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly accepted: number;
      readonly duplicates: number;
      readonly discarded: number;
      readonly rejectedClock: number;
      readonly segmentIds: readonly string[];
    }
> {
  await backtrack.lockOwner(scopedDb, ownerUserId);

  const prefs = await backtrack.getPreferences(scopedDb, ownerUserId);
  if (prefs?.paused) return { kind: "paused" };

  const sentAt = new Date(body.sentAt);
  if (Number.isNaN(sentAt.getTime())) {
    return { kind: "bad_request", message: "sentAt must be a date and time" };
  }
  // Decision 10: every upload carries the Mac's clock when the request left; the server's own
  // measured skew is the only thing that ever converts a client timestamp into server time.
  const receivedAt = new Date();
  const skewMs = receivedAt.getTime() - sentAt.getTime();
  if (Math.abs(skewMs) > BACKTRACK_MAX_SKEW_MS) {
    return { kind: "clock" };
  }

  // Decision 11: shift each segment by the request's skew, then drop anything outside the
  // accepted window before it is ever compared to a deletion marker.
  interface Candidate {
    readonly index: number;
    readonly segment: BacktrackUploadRequest["segments"][number];
    readonly clientStartedAt: Date;
    readonly startedAt: Date;
    readonly endedAt: Date;
  }
  const candidates: Candidate[] = [];
  let rejectedClock = 0;
  body.segments.forEach((segment, index) => {
    const clientStartedAt = new Date(segment.startedAt);
    const clientEndedAt = new Date(segment.endedAt);
    if (Number.isNaN(clientStartedAt.getTime()) || Number.isNaN(clientEndedAt.getTime())) {
      rejectedClock += 1;
      return;
    }
    const startedAt = new Date(clientStartedAt.getTime() + skewMs);
    const endedAt = new Date(clientEndedAt.getTime() + skewMs);
    const tooOld = receivedAt.getTime() - startedAt.getTime() > BACKTRACK_MAX_SEGMENT_AGE_MS;
    const tooNew = endedAt.getTime() > receivedAt.getTime();
    if (tooOld || tooNew || endedAt.getTime() < startedAt.getTime()) {
      rejectedClock += 1;
      return;
    }
    candidates.push({ index, segment, clientStartedAt, startedAt, endedAt });
  });

  // Decision 10: one predicate, in two places. A segment whose server-time window overlaps a
  // deletion marker is refused here, exactly as delete removes it.
  const overlapping = await backtrack.findOverlappingDeletionMarkerIndexes(
    scopedDb,
    ownerUserId,
    candidates.map((candidate) => ({
      index: candidate.index,
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt
    }))
  );
  const discarded = overlapping.size;

  const toInsert: NewBacktrackSegmentInput[] = [];
  for (const candidate of candidates) {
    if (overlapping.has(candidate.index)) continue;
    const { segment } = candidate;

    // Server-side redaction, on top of whatever the Mac already did (secrets never escape —
    // belt and suspenders, never trust the client alone).
    const windowTitle = redactSecrets(segment.windowTitle);
    const address = segment.address === undefined ? null : redactSecrets(segment.address);
    const bodyText = redactSecrets(segment.body);

    // Defense in depth against the column CHECK constraints: a single oversized row (redaction
    // can only ever change length by a little, but never say never) would fail the WHOLE batch
    // insert statement, not just itself. Caught here, it is silently dropped rather than
    // bringing down everyone else's rows in the same request.
    if (
      Buffer.byteLength(segment.appName, "utf8") > 400 ||
      Buffer.byteLength(segment.bundleId, "utf8") > 255 ||
      Buffer.byteLength(windowTitle, "utf8") > 1000 ||
      (address !== null && Buffer.byteLength(address, "utf8") > 2048) ||
      Buffer.byteLength(bodyText, "utf8") > 8192
    ) {
      continue;
    }

    toInsert.push({
      deviceId,
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt,
      appName: segment.appName,
      bundleId: segment.bundleId,
      windowTitle,
      address,
      body: bodyText,
      bodyHash: createHash("sha256").update(bodyText, "utf8").digest(),
      clientStartedAt: candidate.clientStartedAt
    });
  }

  const insertedIds = await backtrack.insertSegments(scopedDb, ownerUserId, toInsert);
  return {
    kind: "ok",
    accepted: insertedIds.length,
    duplicates: toInsert.length - insertedIds.length,
    discarded,
    rejectedClock,
    segmentIds: insertedIds
  };
}

/** Decision: the send site validates before a job ever reaches pg-boss, not just at the schema. */
function assertBacktrackSegmentIdsForJob(ids: readonly string[]): void {
  if (ids.length > 200 || !ids.every((id) => BACKTRACK_SEGMENT_ID_RE.test(id))) {
    throw new Error("backtrack.index payload segmentIds must be at most 200 UUIDs");
  }
}

function sendAccessContextFailure(reply: FastifyReply, error: unknown): void {
  const code = (error instanceof Error && (error as Error & { code?: string }).code) || undefined;
  if (code === "account_pending_approval") {
    reply.code(403).send({ error: "Account is pending approval", code });
    return;
  }
  if (code === "account_deactivated") {
    reply.code(403).send({ error: "Account has been deactivated", code });
    return;
  }
  reply.code(401).send({ error: "Session is missing or expired" });
}

function focusMessageFor(code: string): string {
  if (code === "focus_no_block") return "That block is not on right now";
  return "Focus judgment is not set up on this Moss";
}

function messageFor(code: string): string {
  if (code === "account_pending_approval") return "Account is pending approval";
  if (code === "account_deactivated") return "Account has been deactivated";
  return "This Mac is no longer linked";
}

function backtrackMessageFor(
  code: "backtrack_unavailable" | "backtrack_paused" | "backtrack_clock"
): string {
  if (code === "backtrack_paused") return "Recording is paused from Moss";
  if (code === "backtrack_clock") return "This Mac's clock looks wrong";
  return "Backtrack storage is not turned on for this Moss yet";
}
