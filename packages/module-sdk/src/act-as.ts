import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * #3065: an act-as grant lets chat call the app's own HTTP routes in process as the chat user.
 * The registry lives in `@moss/auth`. The header name, the binding shape and the rate-limit peek
 * live here, because the route-local rate-limit keys in this package must read the grant and
 * this package cannot import auth.
 */

export const ACT_AS_GRANT_HEADER = "x-moss-act-as";

export interface ActAsBinding {
  readonly actorUserId: string;
  readonly chatSessionId: string;
  readonly turnId: string | null;
}

export interface ActAsGrantRegistry {
  /** 256-bit random value, base64url. */
  mint(binding: ActAsBinding): string;
  /** Single use. Null when the value is unknown, already used or expired. */
  consume(value: string): ActAsBinding | null;
  /** The bound actor of a live grant, for the rate-limit key. Does not consume. */
  peekActor(value: string): string | null;
}

const ACT_AS_ACTOR_LOOKUP = Symbol.for("moss.actAsActorLookup");

/**
 * The grant's actor for a request: from a live grant, or from the grant this same request
 * already consumed. The route guard is an app-level onRequest hook, so it consumes the grant
 * before any route-level rate-limit hook computes its key.
 */
export type ActAsActorLookup = (request: FastifyRequest) => string | null;

/** Lets every rate-limit key on this server see the grant's actor. */
export function installActAsActorLookup(server: FastifyInstance, lookup: ActAsActorLookup): void {
  server.decorate(ACT_AS_ACTOR_LOOKUP, lookup);
}

/**
 * `act:<actorUserId>` for a request carrying a grant that is live or was consumed by this
 * request, else null. Each user's in-process calls get their own bucket instead of sharing the
 * loopback address. An unknown, expired or replayed value returns null, so it falls back to the
 * caller's IP bucket.
 */
export function actAsRateLimitKey(request: FastifyRequest): string | null {
  const value = request.headers[ACT_AS_GRANT_HEADER];
  if (typeof value !== "string" || value.length === 0) return null;

  const server = request.server as (FastifyInstance & Record<symbol, unknown>) | undefined;
  const lookup = server?.[ACT_AS_ACTOR_LOOKUP] as ActAsActorLookup | undefined;
  const actor = lookup?.(request);
  return actor ? `act:${actor}` : null;
}
