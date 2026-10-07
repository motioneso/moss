import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { actAsRateLimitKey } from "./act-as.js";

// Better Auth session-token cookie names. The `__Secure-` prefix is added automatically
// when the cookie is issued over TLS (which the app does behind JARVIS_TRUST_PROXY), so a
// browser user's request carries the prefixed form. Both must be recognized or a TLS user
// silently degrades from a per-principal bucket to a shared per-IP one. Kept in sync with
// the global limiter's copy in apps/api (authPrincipalRateLimitKey).
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token=",
  "__Secure-better-auth.session_token="
] as const;

// Session bearer tokens are UUIDs minted lowercase-only (Better Auth emits randomUUID()
// hex). Kept in sync with the global limiter's `SESSION_UUID` in apps/api/src/server.ts —
// the route-local limiters must gate on the exact mint shape so a caller cannot vary the
// case of an uppercase-hex UUID to mint a distinct per-route bucket (#319).
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Per-session MCP bearer tokens are minted as lowercase `jst_<uuid>` (see
// packages/ai/src/gateway/session-tokens.ts). The regex accepts only the mint shape so a
// caller cannot vary the case (e.g. `JST_<uuid>`) to mint a distinct bucket (#319).
const MCP_TOKEN = /^jst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RateLimitKeyPolicy {
  /** Returns true when the raw bearer token matches this route's accepted credential shape. */
  readonly bearerMatches: (token: string) => boolean;
  /** Namespace prefix for a matched, hashed bearer token (e.g. `bearer`, `mcp`). */
  readonly bearerNamespace: string;
  /** Whether an unmatched/absent bearer may fall back to the Better Auth session cookie. */
  readonly allowCookie: boolean;
}

/**
 * Shared route-local rate-limit key builder. Prefer the presented credential so each valid
 * caller gets its own bucket; a credential whose shape does NOT match the route's policy is
 * treated as unauthenticated and keyed on the real peer IP, so varying malformed bearer
 * values cannot mint distinct buckets (the abuse #207 closed).
 *
 * Matched bearer tokens and session cookies are session secrets, so each is hashed to a
 * one-way fingerprint — never used raw as a limiter key — keeping it out of the limiter's
 * in-memory store and any error/header output (the discipline #113 established). Namespaced
 * prefixes prevent a bearer/MCP hash from ever colliding with a cookie hash or an IP literal.
 *
 * Internal: callers use the exported {@link sessionRateLimitKey} / {@link mcpSessionRateLimitKey}.
 */
function credentialOrIpRateLimitKey(request: FastifyRequest, policy: RateLimitKeyPolicy): string {
  // #3065: an in-process act-as call comes from loopback; key it on the grant's actor.
  const actAs = actAsRateLimitKey(request);
  if (actAs) return actAs;

  const authorization = request.headers.authorization ?? "";
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token && policy.bearerMatches(token)) {
      return `${policy.bearerNamespace}:${hash(token)}`;
    }
    // A present-but-unmatched (malformed/wrong-shape) bearer falls through to cookie/IP below.
  }

  if (policy.allowCookie) {
    const cookieParts = (request.headers.cookie ?? "").split(";").map((part) => part.trim());
    for (const name of SESSION_COOKIE_NAMES) {
      const match = cookieParts.find((part) => part.startsWith(name));
      if (match) {
        const value = match.slice(name.length).split(";")[0];
        if (value) {
          return `cookie:${hash(value)}`;
        }
      }
    }
  }

  // When JARVIS_TRUST_PROXY is set, Fastify resolves request.ip from the verified XFF
  // chain; otherwise it is the socket remote address and client-supplied XFF is ignored.
  return `ip:${request.ip}`;
}

/**
 * Per-principal rate-limit key for Better Auth / session-backed HTTP routes (chat turn,
 * assistant-tool invoke, persona preview). A UUID-shaped bearer hashes into the `bearer:`
 * namespace; a valid session cookie hashes into the `cookie:` namespace; any other bearer
 * shape (or none) falls back to `ip:<peer>`. Mirrors the global `authPrincipalRateLimitKey`.
 */
export function sessionRateLimitKey(request: FastifyRequest): string {
  return credentialOrIpRateLimitKey(request, {
    bearerMatches: (token) => SESSION_UUID.test(token),
    bearerNamespace: "bearer",
    allowCookie: true
  });
}

/**
 * Per-session rate-limit key for the MCP transport route. Only a `jst_<uuid>` token hashes
 * into the distinct `mcp:` namespace (kept separate from session bearers so the two token
 * kinds are never interchangeable); any other bearer shape (or none) falls back to
 * `ip:<peer>`. MCP carries no cookie identity, so cookie fallback is disabled.
 */
export function mcpSessionRateLimitKey(request: FastifyRequest): string {
  return credentialOrIpRateLimitKey(request, {
    bearerMatches: (token) => MCP_TOKEN.test(token),
    bearerNamespace: "mcp",
    allowCookie: false
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
