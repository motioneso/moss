import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MossAuthRuntime } from "@moss/auth";
import { actAsRateLimitKey } from "@moss/module-sdk/server";
import { handleBetterAuthRequest } from "./better-auth-adapter.js";

// Credential POST paths that must be throttled.
// `sign-in/social` initiates an OAuth flow (the provider is carried in the request body,
// not the path) and is an abuse-prone unauthenticated surface, so it is throttled too
// (OTNR-P4 #122). The OAuth *callback* (`/api/auth/callback/:provider`) is a provider-driven
// GET redirect — it is intentionally NOT throttled: it is exempted by the POST-only guard
// below, carries a per-flow state token better-auth already validates, and rate-limiting a
// provider redirect would break legitimate logins.
const THROTTLED_AUTH_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/sign-up/email",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/change-password"
]);

// Better Auth session-token cookie names. The `__Secure-` prefix is added automatically
// when the cookie is issued over TLS (which the app does behind JARVIS_TRUST_PROXY), so a
// browser user's request carries the prefixed form. Both must be recognized or TLS users
// silently degrade from a per-principal bucket to a shared per-IP one.
const SESSION_COOKIE_NAMES = ["better-auth.session_token=", "__Secure-better-auth.session_token="];

// A Better Auth session id is a v4 UUID minted lowercase-only (randomUUID() hex). The
// limiter gates on the exact mint shape so a caller cannot vary the case of an uppercase
// UUID to mint distinct per-principal buckets (#319). Kept in sync with the route-local
// copy in packages/module-sdk/src/rate-limit-key.ts.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Rate-limit key for the global throttle class. Prefer the presented credential so each
// LAN user / bearer client gets its own bucket; otherwise key on the real peer IP.
//
// Junk credentials must NOT mint fresh buckets, or an attacker varying a bogus token per
// request would evade the per-principal limit entirely (each bogus token = a new 2000/min
// bucket = unbounded resolve_auth_session DB load). So the bearer branch keys per-principal
// ONLY for a UUID-shaped token (the sole shape the legacy session-bearer path can resolve);
// anything else falls through to the peer-IP bucket, which is bounded. The cookie value is
// opaque/signed so a non-empty value is treated as a principal as-is.
//
// The token/cookie is a session secret, so it is hashed — never used raw as a key — keeping
// it out of the limiter's in-memory store and any error/header output. Namespaced prefixes
// prevent a bearer hash from ever colliding with a cookie hash or an IP literal.
export function authPrincipalRateLimitKey(request: FastifyRequest): string {
  // #3065: in-process act-as calls come from loopback; key them on the grant's actor.
  const actAs = actAsRateLimitKey(request);
  if (actAs) return actAs;

  const authorization = request.headers.authorization ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(authorization.indexOf(" ") + 1).trim();
    if (token && SESSION_UUID.test(token)) {
      return `bearer:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
    }
  }

  const cookieParts = (request.headers.cookie ?? "").split(";").map((part) => part.trim());
  for (const name of SESSION_COOKIE_NAMES) {
    const match = cookieParts.find((part) => part.startsWith(name));
    if (match) {
      const value = match.slice(name.length).split(";")[0];
      if (value) {
        return `cookie:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
      }
    }
  }

  // When JARVIS_TRUST_PROXY is set, Fastify resolves request.ip from the XFF chain after
  // verifying the proxy; otherwise it is the socket remote address and client-supplied
  // XFF headers are ignored (C1 regression guard).
  return `ip:${request.ip}`;
}

export function registerBetterAuthRoutes(
  server: FastifyInstance,
  authRuntime: MossAuthRuntime,
  authMax: number
): void {
  server.route({
    method: ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"],
    url: "/api/auth/*",
    config: {
      rateLimit: {
        max: authMax,
        timeWindow: "1 minute",
        // Credential POSTs are PRE-auth: there is no trusted principal yet, and the
        // Authorization/Cookie headers are fully attacker-controlled. Key on the peer IP
        // (C1 decision). This MUST be set explicitly: a per-route config.rateLimit with no
        // keyGenerator inherits the GLOBAL keyGenerator (authPrincipalRateLimitKey), which
        // would let an attacker vary `Authorization: Bearer <junk-N>` to mint a fresh bucket
        // per request and fully bypass the sign-in brute-force throttle (OTNR-P4 #122 / C1).
        keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
        allowList: (req: FastifyRequest) => {
          if (req.method !== "POST") return true;
          // Decode percent-encoded path before matching to close the %65mail bypass.
          // Malformed sequences fall back to the raw pathname — not in the set → throttled.
          const raw = new URL(req.url, "http://localhost").pathname;
          let pathname: string;
          try {
            pathname = decodeURIComponent(raw);
          } catch {
            pathname = raw;
          }
          return !THROTTLED_AUTH_PATHS.has(pathname);
        }
      }
    },
    handler: (request, reply) => handleBetterAuthRequest(request, reply, authRuntime)
  });
}
