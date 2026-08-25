import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";

import type { ActiveModulesResolver } from "@moss/ai";

/** A method+pattern key. Method is upper-cased; pattern is Fastify's matched-route url. */
export type RouteKey = string;

/**
 * Normalize an HTTP method for keying. Fastify auto-generates a HEAD handler for every
 * GET route (`exposeHeadRoutes`, default on), and the guard keys runtime requests by
 * `request.method` — so an inbound HEAD to a guarded GET route would key as
 * "HEAD /api/..." and miss the GET-keyed index, returning a spurious guard-404. We fold
 * HEAD into GET everywhere (index build, runtime lookup, coverage accumulator) so a HEAD
 * is gated exactly like its GET. OPTIONS is handled separately (filtered from the
 * accumulator; CORS/preflight is not module-gated).
 */
function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper === "HEAD" ? "GET" : upper;
}

export function routeKey(method: string, pattern: string): RouteKey {
  return `${normalizeMethod(method)} ${pattern}`;
}

/**
 * Platform/unguarded routes (ADR 0009 §4): the guard skips these. Settings owns
 * /api/me, /api/bootstrap/status, and /api/admin/*, so a prefix heuristic is unsafe —
 * the allowlist is explicit. Includes the new admin + self enablement endpoints (a
 * user must always be able to re-enable a module they disabled).
 */
export const PLATFORM_UNGUARDED_ROUTES: ReadonlySet<RouteKey> = new Set<RouteKey>([
  // health probes
  routeKey("GET", "/health"),
  routeKey("GET", "/health/ready"),
  // platform module listing
  routeKey("GET", "/api/modules"),
  // better-auth wildcard: registered as ONE route /api/auth/* across all methods, owned
  // by no module (platform auth). HEAD folds into GET via normalizeMethod; OPTIONS is
  // filtered from the coverage accumulator (CORS/preflight), so it is harmless here.
  routeKey("GET", "/api/auth/*"),
  routeKey("POST", "/api/auth/*"),
  routeKey("PATCH", "/api/auth/*"),
  routeKey("PUT", "/api/auth/*"),
  routeKey("DELETE", "/api/auth/*"),
  // settings: pre-auth bootstrap + own profile
  routeKey("GET", "/api/bootstrap/status"),
  routeKey("GET", "/api/me"),
  // FIN-04 (#1149): authenticated member directory (id+name of active users),
  // platform-owned like /api/me — module sharing UX resolves owner names here,
  // so it must not be gated on any one module's enablement.
  routeKey("GET", "/api/users/directory"),
  // settings admin surface (gated by assertAdminUser, not by module enablement)
  routeKey("GET", "/api/admin/auth/providers"),
  routeKey("GET", "/api/admin/users"),
  routeKey("POST", "/api/admin/users/:id/approve"),
  routeKey("POST", "/api/admin/users/:id/reject"),
  routeKey("DELETE", "/api/admin/users/:id"),
  routeKey("POST", "/api/admin/users/:id/reactivate"),
  routeKey("POST", "/api/admin/users/:id/deactivate"),
  routeKey("POST", "/api/admin/users/:id/revoke-sessions"),
  routeKey("POST", "/api/admin/users/:id/promote"),
  routeKey("POST", "/api/admin/users/:id/demote"),
  routeKey("GET", "/api/admin/settings"),
  routeKey("PATCH", "/api/admin/settings/:key"),
  // web-search Brave API key: dedicated encrypted admin route (#446), admin-gated like the
  // rest of the settings surface — not module-enablement-gated.
  routeKey("GET", "/api/admin/settings/web-search"),
  routeKey("PUT", "/api/admin/settings/web-search"),
  routeKey("DELETE", "/api/admin/settings/web-search"),
  routeKey("GET", "/api/admin/registration"),
  routeKey("PUT", "/api/admin/registration"),
  routeKey("GET", "/api/admin/chat-multiplexer"),
  routeKey("PUT", "/api/admin/chat-multiplexer"),
  // host diagnostics: admin-gated platform route owned by no module (read-only, #255)
  routeKey("GET", "/api/admin/host/diagnostics"),
  // host install: admin-gated platform route owned by no module, fixed-script-only (#993)
  routeKey("POST", "/api/admin/host/install"),
  // host restart: admin-gated platform route owned by no module (#1748). Fails closed with
  // 503 when no control directory is bind-mounted, and admin-gated by assertAdminUser —
  // never module-enablement-gated, since restarting the app is not any module's business.
  routeKey("GET", "/api/admin/host/restart"),
  routeKey("POST", "/api/admin/host/restart"),
  routeKey("GET", "/api/admin/audit-events"),
  // onboarding (Phase 2): admin-gated platform routes owned by no module
  routeKey("GET", "/api/onboarding/status"),
  routeKey("POST", "/api/onboarding/complete"),
  routeKey("POST", "/api/onboarding/skip"),
  // NOTE: /api/admin/connectors/accounts is NOT here — it is connector-OWNED (declared
  // in connectorsModuleManifest.routes[]) so it is guarded by the connectors module's
  // enablement, not the platform allowlist. Allowlisting it would leave it reachable
  // after an admin disables connectors. (Only routes owned by NO module belong here.)
  // new enablement endpoints (admin + self)
  routeKey("GET", "/api/admin/modules"),
  routeKey("PATCH", "/api/admin/modules/:id"),
  routeKey("GET", "/api/me/modules"),
  routeKey("PATCH", "/api/me/modules/:id"),
  // #917 external-module admin surface (settings-owned; settings is required/always-on).
  routeKey("GET", "/api/admin/external-modules"),
  routeKey("POST", "/api/admin/external-modules/:id"),
  // #1752: admin-triggered rescan of the modules directory — settings-owned, same
  // platform-route reasoning as the two external-module admin routes just above.
  routeKey("POST", "/api/admin/modules/rescan"),
  // #1753 Task 10: shipping a draft module — settings-owned, same platform-route
  // reasoning as the external-module admin routes above.
  routeKey("POST", "/api/admin/modules/:id/ship"),
  // #1890 Workshop 8: throwing a draft away — the other end of ship's lifecycle, same
  // settings-owned platform-route reasoning.
  routeKey("DELETE", "/api/admin/modules/:id/draft"),
  // #964 module-registry distribution surface (settings-owned, admin-gated via
  // assertAdminUser in routes-module-registry.ts — NOT module-enablement-gated; a
  // disabled/not-yet-installed module must still be discoverable/installable here).
  routeKey("GET", "/api/admin/module-registry"),
  routeKey("POST", "/api/admin/external-modules/:id/download"),
  routeKey("POST", "/api/admin/external-modules/:id/remove"),
  routeKey("DELETE", "/api/admin/external-modules/:id/purge"),
  // #918: module credential management + web asset serving are PLATFORM routes
  // (external modules cannot declare routes[]). The asset handler enforces its
  // own module-active fail-closed 404 (apps/api/src/server.ts).
  routeKey("GET", "/api/admin/modules/:moduleId/credentials"),
  routeKey("PUT", "/api/admin/modules/:moduleId/credentials/:credentialId"),
  routeKey("DELETE", "/api/admin/modules/:moduleId/credentials/:credentialId"),
  routeKey("GET", "/api/me/modules/:moduleId/credentials"),
  routeKey("PUT", "/api/me/modules/:moduleId/credentials/:credentialId"),
  routeKey("DELETE", "/api/me/modules/:moduleId/credentials/:credentialId"),
  routeKey("GET", "/api/modules/:moduleId/web/*"),
  routeKey("POST", "/api/modules/:moduleId/queues/:queueName/run"),
  // #1725: module preferences are a PLATFORM surface addressed by module id, owned by no
  // module (external modules cannot declare routes[]). Both handlers fail closed on their
  // own — 401 without a session, 404 when the module is not active for the caller
  // (apps/api/src/module-preferences.ts).
  routeKey("GET", "/api/modules/:moduleId/preferences"),
  routeKey("PATCH", "/api/modules/:moduleId/preferences"),
  // observability sink (#413): unauthenticated platform route the browser fires
  // client errors into. Owned by no module, never stores anything, only logs.
  routeKey("POST", "/api/errors")
]);

export type RouteModuleIndex = ReadonlyMap<RouteKey, string>;

/**
 * Build a method+pattern → moduleId index from every manifest's routes[]. Throws if two
 * manifests claim the same method+pattern: a silent last-writer-wins would let the wrong
 * module's enablement gate a route (e.g. a route stays reachable because a still-active
 * module accidentally claimed a disabled module's path). A collision is a build error.
 */
export function buildRouteModuleIndex(manifests: readonly MossModuleManifest[]): RouteModuleIndex {
  const index = new Map<RouteKey, string>();
  for (const manifest of manifests) {
    for (const route of manifest.routes ?? []) {
      const key = routeKey(route.method, route.path);
      const existing = index.get(key);
      if (existing !== undefined && existing !== manifest.id) {
        throw new Error(
          `Route "${key}" is claimed by two modules ("${existing}" and "${manifest.id}"). ` +
            `Each route may belong to exactly one module.`
        );
      }
      index.set(key, manifest.id);
    }
  }
  return index;
}

export function lookupModuleForRoute(
  index: RouteModuleIndex,
  method: string,
  pattern: string
): string | undefined {
  return index.get(routeKey(method, pattern));
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

interface RouteCoverageInput {
  readonly registered: readonly RegisteredRoute[];
  readonly manifests: readonly MossModuleManifest[];
  readonly platformAllowlist: ReadonlySet<RouteKey>;
}

/**
 * Boot-time coverage assertion (ADR 0009 §4). Throws if any registered route is
 * neither claimed by a manifest routes[] entry nor on the platform allowlist, OR if a
 * manifest declares a route that is not registered (drift). This makes "routes[] is
 * load-bearing" verifiable rather than aspirational. The guard would have a blind spot
 * for any uncovered route, so the process must not start.
 */
export function assertRouteCoverage(input: RouteCoverageInput): void {
  const index = buildRouteModuleIndex(input.manifests);
  const registeredKeys = new Set(input.registered.map((r) => routeKey(r.method, r.url)));

  const uncovered: string[] = [];
  for (const key of registeredKeys) {
    if (input.platformAllowlist.has(key)) continue;
    if (index.has(key)) continue;
    uncovered.push(key);
  }

  const drifted: string[] = [];
  for (const key of index.keys()) {
    if (!registeredKeys.has(key)) drifted.push(key);
  }

  if (uncovered.length > 0 || drifted.length > 0) {
    const parts: string[] = [];
    if (uncovered.length > 0) {
      parts.push(
        `registered routes not claimed by any manifest routes[] or the platform allowlist: ` +
          uncovered.sort().join(", ")
      );
    }
    if (drifted.length > 0) {
      parts.push(
        `manifest routes[] entries with no registered route (drift): ` + drifted.sort().join(", ")
      );
    }
    throw new Error(`Route-coverage assertion failed — ${parts.join("; ")}`);
  }
}

export interface RouteGuardDeps {
  readonly manifests: readonly MossModuleManifest[];
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly platformAllowlist?: ReadonlySet<RouteKey>;
}

/**
 * Register a single onRequest hook that 404s a request whose matched route belongs to
 * a module not active for the actor. onRequest runs after routing, so
 * request.routeOptions.url is the matched pattern (e.g. /api/tasks/:id). 404 (never
 * 403) — do not leak that the module exists but is disabled. Platform/unguarded routes
 * pass through with no actor resolution.
 *
 * FAIL-CLOSED + SCRUBBED on resolver/DB error: a resolver throw must NEVER let the
 * request through (that would silently re-enable a disabled module). We catch it inside
 * the hook, log the detail SERVER-SIDE only, and return a generic 503 with NO err.message
 * — the rest of the app routes errors through handleRouteError/HttpError and never lets a
 * raw error reach Fastify's default handler (which would echo err.message). This onRequest
 * hook is a new code path outside that convention, so it must scrub here itself (Hard
 * Invariant: secrets/DB detail never escape to responses or logs in a leakable form).
 */
export function registerRouteEnablementGuard(server: FastifyInstance, deps: RouteGuardDeps): void {
  const index = buildRouteModuleIndex(deps.manifests);
  const allowlist = deps.platformAllowlist ?? PLATFORM_UNGUARDED_ROUTES;

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight is never module-gated. An OPTIONS request keys as "OPTIONS <pattern>",
    // which is on neither the platform allowlist nor any manifest routes[] (manifests
    // declare only the real verbs), so without this short-circuit the guard would 404 every
    // preflight — including /api/auth/* — and break cross-origin auth/module calls the
    // moment Phase 2 introduces a containerized/`--host` topology. normalizeMethod folds
    // only HEAD→GET; OPTIONS is handled here and is filtered from the coverage accumulator.
    if (request.method === "OPTIONS") return;

    const pattern = request.routeOptions?.url;
    // No matched route (404 from the router itself) — let Fastify's 404 handler run.
    if (!pattern) return;

    const key = routeKey(request.method, pattern);
    if (allowlist.has(key)) return;

    const moduleId = index.get(key);
    // Unindexed + not allowlisted: the boot assertion should have prevented deploy.
    // Fail closed defensively at request time.
    if (!moduleId) {
      return reply.code(404).send({ error: "Not found" });
    }

    let actorUserId: string;
    try {
      const access = await deps.resolveAccessContext(request);
      actorUserId = access.actorUserId;
    } catch {
      // Not authenticated — let the route's own handler return its normal 401.
      return;
    }

    let active: readonly MossModuleManifest[];
    try {
      active = await deps.resolveActiveModules(actorUserId);
    } catch (error) {
      // FAIL CLOSED: never let a resolver/DB error fall through to the handler. Log the
      // detail server-side; return a generic 503 with no internal message.
      request.log.error({ err: error, moduleId }, "module-enablement resolver failed");
      return reply.code(503).send({ error: "Service unavailable" });
    }
    if (!active.some((m) => m.id === moduleId)) {
      return reply.code(404).send({ error: "Not found" });
    }
  });
}
