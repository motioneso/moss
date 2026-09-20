import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CompanionAuthError, type CompanionContext, type MossAuthRuntime } from "@moss/auth";
import {
  cancelPairAttemptRouteSchema,
  companionHeartbeatRouteSchema,
  companionLogoutRouteSchema,
  companionProtocolRouteSchema,
  COMPANION_PAIR_POLL_INTERVAL_SECONDS,
  COMPANION_PROTOCOL_VERSION,
  createPairAttemptRouteSchema,
  decidePairAttemptRouteSchema,
  getPairAttemptRouteSchema,
  redeemPairAttemptRouteSchema,
  renameCompanionDeviceRouteSchema,
  type CompanionHeartbeatRequest,
  type CreatePairAttemptRequest,
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
 * A companion credential is accepted here and nowhere else. The reverse also holds by
 * construction: the general resolver passes every bearer token to the legacy UUID
 * session lookup, which rejects a `tm1_` value, so this credential authenticates no
 * other route in the product.
 */

const PAIR_RATE_MAX = 20;

/**
 * Unauthenticated pairing endpoints are pre-credential, so Authorization and Cookie are
 * fully attacker-controlled and cannot key a bucket. Key on the peer IP. This must be set
 * explicitly: a per-route rateLimit without a keyGenerator inherits the global principal
 * key, which an attacker mints a fresh bucket in by varying a junk bearer token.
 */
const ipRateLimit = {
  rateLimit: {
    max: PAIR_RATE_MAX,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`
  }
};

export interface CompanionRouteDeps {
  readonly authRuntime: MossAuthRuntime;
}

export function registerCompanionRoutes(server: FastifyInstance, deps: CompanionRouteDeps): void {
  const { authRuntime } = deps;
  const pairing = authRuntime.companionPairing;
  const devices = authRuntime.companionDevices;

  /** Resolves the signed-in browser, and requires the request to come from a trusted origin. */
  async function requireBrowserActor(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<string | null> {
    let actorUserId: string;
    try {
      actorUserId = (await authRuntime.resolveAccessContext(request)).actorUserId;
    } catch (error) {
      sendAccessContextFailure(reply, error);
      return null;
    }

    // Approving a device is a state change made with a cookie, so it needs a same-origin
    // check of its own. A missing Origin is refused rather than trusted: a browser sends
    // one on every cross-site POST, so its absence is never a signal of safety.
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !authRuntime.trustedOrigins.includes(origin)) {
      reply.code(403).send({ error: "Request origin is not trusted", code: "invalid_origin" });
      return null;
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
    { schema: companionProtocolRouteSchema, config: ipRateLimit },
    async () => ({ product: "moss" as const, companionProtocol: COMPANION_PROTOCOL_VERSION })
  );

  server.post<{ Body: CreatePairAttemptRequest }>(
    "/api/companion/pair",
    { schema: createPairAttemptRouteSchema, config: ipRateLimit },
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

  server.get<{ Querystring: { code: string } }>(
    "/api/companion/pair/attempt",
    { schema: getPairAttemptRouteSchema },
    async (request, reply) => {
      const actorUserId = await requireBrowserActor(request, reply);
      if (!actorUserId) return reply;

      const summary = await pairing.summarize({ approvalCode: request.query.code });
      // Unknown, expired and already-finished all answer 404, so a guessed code tells
      // the guesser nothing about whether it ever existed.
      if (!summary) return reply.code(404).send({ error: "That link request is no longer open" });
      return summary;
    }
  );

  server.post<{ Body: { code: string; decision: "approve" | "deny" } }>(
    "/api/companion/pair/decide",
    { schema: decidePairAttemptRouteSchema },
    async (request, reply) => {
      const actorUserId = await requireBrowserActor(request, reply);
      if (!actorUserId) return reply;

      // The approving account comes from the session, never from the body.
      const result = await pairing.decide({
        approvalCode: request.body.code,
        decision: request.body.decision,
        actorUserId
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
    { schema: redeemPairAttemptRouteSchema, config: ipRateLimit },
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
    { schema: cancelPairAttemptRouteSchema, config: ipRateLimit },
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
      return devices.heartbeat(ctx, request.body);
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
    { schema: companionLogoutRouteSchema },
    async (request, reply) => {
      const ctx = await requireCompanion(request, reply);
      if (!ctx) return reply;
      await devices.logout(ctx);
      return reply.code(204).send();
    }
  );
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

function messageFor(code: string): string {
  if (code === "account_pending_approval") return "Account is pending approval";
  if (code === "account_deactivated") return "Account has been deactivated";
  return "This Mac is no longer linked";
}
