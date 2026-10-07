import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { AccessContext } from "@moss/db";
import {
  ACT_AS_GRANT_HEADER,
  type ActAsBinding,
  type ActAsGrantRegistry
} from "@moss/module-sdk/server";

import type { MossAuthRuntime, RequestAccessContextInput } from "./index.js";

export { ACT_AS_GRANT_HEADER, type ActAsBinding, type ActAsGrantRegistry };

export const ACT_AS_GRANT_TTL_MS = 30_000;

// The exact message route-errors.ts maps to 401, so a refused grant reads like any other
// missing session.
const UNAUTHENTICATED = "Session is missing or expired";

interface HeldGrant {
  readonly binding: ActAsBinding;
  readonly expiresAt: number;
}

/**
 * #3065: single-use grants held in process memory. A grant value is a bearer secret for one
 * in-process request, so it is never logged, returned or put in a payload.
 */
export function createActAsGrantRegistry(now: () => number = Date.now): ActAsGrantRegistry {
  const held = new Map<string, HeldGrant>();

  const live = (value: string): HeldGrant | null => {
    const grant = held.get(value);
    if (!grant) return null;
    if (now() >= grant.expiresAt) {
      held.delete(value);
      return null;
    }
    return grant;
  };

  const pruneExpired = (): void => {
    const at = now();
    for (const [value, grant] of held) {
      if (at >= grant.expiresAt) held.delete(value);
    }
  };

  return {
    mint(binding) {
      pruneExpired();
      const value = randomBytes(32).toString("base64url");
      held.set(value, { binding, expiresAt: now() + ACT_AS_GRANT_TTL_MS });
      return value;
    },
    consume(value) {
      const grant = live(value);
      held.delete(value);
      return grant?.binding ?? null;
    },
    peekActor(value) {
      return live(value)?.binding.actorUserId ?? null;
    }
  };
}

export interface ActAsRequestAuth {
  readonly authRuntime: MossAuthRuntime;
  /** For the rate-limit keys. Never consumes a grant. */
  readonly actAsActor: (request: RequestAccessContextInput) => string | null;
}

/**
 * Wraps the runtime's resolver with the act-as grant check and a per-request cache.
 *
 * Auth resolves several times per request (route guard, handler, error recorder). The first
 * success is cached on the request object, so one grant serves one whole request and a second
 * request with the same grant fails. A grant request must carry no other auth material.
 *
 * Wrap the runtime before any caller captures `resolveAccessContext`.
 */
export function withActAsGrantsAndRequestCache(
  runtime: MossAuthRuntime,
  grants: ActAsGrantRegistry
): ActAsRequestAuth {
  const resolved = new WeakMap<RequestAccessContextInput, AccessContext>();
  const grantActors = new WeakMap<RequestAccessContextInput, string>();

  const resolveAccessContext = async (request: RequestAccessContextInput) => {
    const cached = resolved.get(request);
    if (cached) return cached;

    const viaGrant = readHeader(request.headers, ACT_AS_GRANT_HEADER) !== undefined;
    const context = viaGrant
      ? resolveGrant(request, grants)
      : await runtime.resolveAccessContext(request);
    resolved.set(request, context);
    if (viaGrant) grantActors.set(request, context.actorUserId);
    return context;
  };

  const actAsActor = (request: RequestAccessContextInput): string | null => {
    const consumedHere = grantActors.get(request);
    if (consumedHere) return consumedHere;
    const value = readHeader(request.headers, ACT_AS_GRANT_HEADER);
    return typeof value === "string" ? grants.peekActor(value) : null;
  };

  return { authRuntime: { ...runtime, resolveAccessContext }, actAsActor };
}

function resolveGrant(request: RequestAccessContextInput, grants: ActAsGrantRegistry) {
  const value = readHeader(request.headers, ACT_AS_GRANT_HEADER);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    readHeader(request.headers, "authorization") !== undefined ||
    readHeader(request.headers, "cookie") !== undefined
  ) {
    throw new Error(UNAUTHENTICATED);
  }

  const binding = grants.consume(value);
  if (!binding) throw new Error(UNAUTHENTICATED);
  return { actorUserId: binding.actorUserId, requestId: request.id ?? randomUUID() };
}

function readHeader(
  headers: Headers | IncomingHttpHeaders,
  name: string
): string | string[] | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name];
}
