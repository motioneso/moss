import { createHash, randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import {
  AiRepository,
  assertBuiltInSelfOperationManifests,
  grantSelfOperationForModule,
  type TerminalRpcConnectOptions,
  type TerminalRpcHandle
} from "@moss/ai";
import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createCliStructuredAdapterFactory } from "@moss/chat";
import {
  ConnectorsRepository,
  GoogleConnectionService,
  GoogleOAuthClient,
  GoogleApiClient,
  createConnectorSecretCipher
} from "@moss/connectors";
import {
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher
} from "@moss/integrations";
import {
  DataContextRunner,
  createDatabase,
  getMossDatabaseUrls,
  resolveMossEnv,
  resolveTrustProxy,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, sendModuleControl } from "@moss/jobs";
import {
  aggregateFocusSignals,
  createActiveModulesResolver,
  focusSignalProvidersFor,
  getAllQueueDefinitions,
  getBuiltInModuleManifests,
  reconcileExternalModules,
  registerBuiltInApiRoutes,
  registerRouteEnablementGuard,
  assertRouteCoverage,
  PLATFORM_UNGUARDED_ROUTES,
  type ChatEngineFactory,
  type MossModuleManifest,
  type ReconciledExternalModule
} from "@moss/module-registry";
import {
  listModulesRouteSchema,
  isValidTimeZone,
  parsePositiveIntEnv,
  type HostDiagnosticsInfo
} from "@moss/shared";
import { createModuleLogger, CORE_VERSION } from "@moss/module-sdk";
// #917: /api/modules reads enablement through the public settings API; this is legitimate
// composition-root wiring, not a module cross-import.
import { SettingsRepository } from "@moss/settings";
import {
  type ExternalModuleWorkerRuntime,
  createExternalModuleDiscoveryHolder,
  resolveModulesDir
} from "@moss/module-registry/node";

import { createModuleAiBridge } from "./external-module-ai-bridge.js";
import { createModuleDistributionPort } from "./module-distribution-port.js";
import { resolveHerdrInstall } from "./herdr-install-port.js";
import { mapEnvMode, resolveDeployMode, restartCommandFor } from "./host-diagnostics-env.js";
import type { HerdrInstallDependencies } from "@moss/settings";
import { registerStaticWeb } from "./static-web.js";
import { registerClientErrorsRoute, setMossErrorHandler } from "./error-handling.js";
import { registerExternalModuleWebAssetRoute } from "./external-module-web-route.js";
import {
  reconcileExternalModuleUserJobs,
  registerExternalModuleJobRoutes
} from "./external-module-jobs.js";
import {
  createActiveExternalModulesResolverForApi,
  createInstalledExternalModulesResolverForApi,
  createExternalActiveModulesResolver,
  createExternalModuleTools
} from "./external-module-tools.js";
import { serializeExternalModule, serializeModule } from "./module-dto.js";
import { handleBetterAuthRequest } from "./better-auth-adapter.js";
import { registerModulePreferenceRoutes } from "./module-preferences.js";

// `FastifyRequest.timeZone` is declared in `@moss/module-registry` (#801 Phase A),
// not here: module-registry is the composition root that both the writer (this
// file's onRequest hook) and every module-side reader (e.g. wellness routes)
// already import, whereas this file is invisible to TS programs that don't include
// apps/api. Ambient module augmentations only apply within the same compilation, so
// the declaration lives where everyone touching `request.timeZone` is guaranteed to
// reach it.

export interface CreateApiServerOptions {
  readonly appDb?: Kysely<MossDatabase>;
  readonly workerDb?: Kysely<MossDatabase>;
  readonly boss?: PgBoss;
  readonly authRuntime?: MossAuthRuntime;
  readonly logger?: boolean;
  readonly apiServerConfig?: ApiServerConfig;
  /** Override the live-chat engine factory (tests inject a fake); defaults to real tmux. */
  readonly chatEngineFactory?: ChatEngineFactory;
  readonly connectTerminalRpc?: (options: TerminalRpcConnectOptions) => Promise<TerminalRpcHandle>;
  readonly personaPreview?: (input: {
    readonly actorUserId: string;
    readonly userName: string;
    readonly assistantName: string;
    readonly personaText: string;
  }) => Promise<string>;
  /**
   * TEST-ONLY. Synthetic guarded routes + their manifests, used to prove the real
   * server's route-enablement guard 404s a route owned by an INACTIVE module. Never set in
   * production. Mechanism: these manifests are added to the GUARD's manifest set (so the guard
   * maps the synthetic route → synthetic module id) but NOT to the resolver's manifest set
   * (createActiveModulesResolver only knows the built-ins), so the guard's
   * `active.some(m => m.id === syntheticId)` is false → 404. No deny-row seeding needed.
   */
  readonly __testExtraGuardedRoutes?: {
    readonly manifests: readonly MossModuleManifest[];
    readonly routes: readonly { method: string; url: string }[];
  };
  /** TEST-ONLY. Injected fetch for weather HTTP calls. */
  readonly fetchFn?: typeof fetch;
  /** TEST-ONLY. Overrides the real Herdr install executor (avoids real network/exec in tests). */
  readonly installHerdr?: HerdrInstallDependencies["install"];
  /**
   * TEST-ONLY. Overrides externalModules.enabled below (default true in production —
   * see #996/#860). Never set outside tests; proves the `enabled:false` module-registry
   * envelope without a real production toggle for this setting.
   */
  readonly __testExternalModulesEnabled?: boolean;
}

export interface ApiServerConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpServerUrl: string;
  // #996/#860: external (non-compiled) trusted-operator modules are always on — the
  // JARVIS_ENABLE_EXTERNAL_MODULES flag was removed (previously required exactly "1").
  // externalModulesDir always resolves to a usable path via resolveModulesDir; it is
  // never null. Discovery still runs ONCE at boot (the mount is read-only and changes
  // only across a redeploy), so a package swap still requires a container restart.
  readonly externalModulesDir: string;
}

// Moved to @moss/db (#1505) so @moss/auth can reuse the same TLS-in-front-of-us
// signal for its secure-cookie decision without importing this app package.
// Re-exported here so existing callers/tests importing it from server.js keep working.
export { resolveTrustProxy };

export function hasAuthMaterial(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  const cookie = request.headers.cookie;
  return (
    (typeof authorization === "string" && authorization.trim().length > 0) ||
    (typeof cookie === "string" && cookie.trim().length > 0)
  );
}

export function resolveApiServerConfig(env: NodeJS.ProcessEnv = process.env): ApiServerConfig {
  const port = Number(env.PORT ?? 3000);
  const host = env.HOST ?? "0.0.0.0";
  return {
    host,
    port,
    // The api forwards this URL to the CLI launch (cli-runner RPC params). In the container
    // deploy the CLI runs in a SEPARATE container, so a hardcoded 127.0.0.1 resolves to the
    // cli-runner itself and the MCP gateway is unreachable (zero Jarvis tools). Honor the
    // compose-provided service DNS (JARVIS_MCP_SERVER_URL, e.g. http://api:3000/api/mcp) when
    // set; fall back to the loopback URL for dev/non-container runs. URL source only — this
    // does not change the MCP gateway auth/allowlist/token-mint path.
    mcpServerUrl: env.JARVIS_MCP_SERVER_URL ?? `http://127.0.0.1:${port}/api/mcp`,
    externalModulesDir: resolveModulesDir(env)
  };
}

export function createApiServer(options: CreateApiServerOptions = {}) {
  const trustProxy = resolveTrustProxy(resolveMossEnv(process.env, "JARVIS_TRUST_PROXY"));
  const apiServerConfig = options.apiServerConfig ?? resolveApiServerConfig();
  const appDb =
    options.appDb ??
    createDatabase({
      connectionString: getMossDatabaseUrls().app,
      maxConnections: Number(resolveMossEnv(process.env, "JARVIS_API_DB_POOL_SIZE") ?? 4)
    });
  const boss = options.boss ?? createPgBossClient(getMossDatabaseUrls().app);
  const ownsAppDb = options.appDb === undefined;
  const workerDb =
    options.workerDb ??
    createDatabase({
      connectionString: getMossDatabaseUrls().worker,
      maxConnections: Number(resolveMossEnv(process.env, "JARVIS_API_WORKER_DB_POOL_SIZE") ?? 2)
    });
  const ownsWorkerDb = options.workerDb === undefined;
  const workerDataContext = new DataContextRunner(workerDb);
  let externalWorkerRuntime: ExternalModuleWorkerRuntime | undefined;
  const ownsBoss = options.boss === undefined;
  const dataContext = new DataContextRunner(appDb);
  const aiRepository = new AiRepository();
  const server = Fastify({
    logger: options.logger ?? true,
    // Honor XFF only when an explicit opt-in confirms a trusted reverse proxy is in
    // front. Without this, XFF is attacker-controlled and must not key the rate limiter.
    trustProxy
  });
  const authRuntime =
    options.authRuntime ??
    createMossAuthRuntime({
      appDb,
      runner: dataContext,
      // Surfaces the legacy session-bearer observability event (#113) into the API logs.
      logger: server.log
    });
  const ownsAuthRuntime = options.authRuntime === undefined;
  const AUTH_MAX = parsePositiveIntEnv(resolveMossEnv(process.env, "JARVIS_RL_AUTH_MAX"), 10);

  registerRequestTimeZoneHook(server);

  // Security headers via @fastify/helmet.
  // This API serves JSON only, so CSP is maximally restrictive (default-src 'none').
  // HSTS is omitted on plain HTTP — the header has no effect and misleads LAN/dev
  // setups where TLS is not present. It is enabled only when JARVIS_TRUST_PROXY is
  // set, which signals a TLS-terminating reverse proxy is in front (the same signal
  // already used for XFF trust above).
  server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    // X-Frame-Options is redundant when frame-ancestors is set in CSP, but helmet
    // sets it to DENY by default, which is a safe belt-and-suspenders header for
    // older browsers.
    frameguard: { action: "deny" },
    // noSniff: true is the helmet default (X-Content-Type-Options: nosniff).
    // referrerPolicy: no-referrer keeps request metadata off third-party servers.
    referrerPolicy: { policy: "no-referrer" },
    // Only activate HSTS when we know TLS is in use. Without TLS the header is
    // not just useless — it can lock users out of plain-HTTP LAN access.
    hsts:
      trustProxy !== false
        ? {
            maxAge: 31536000,
            includeSubDomains: true
          }
        : false
  });

  // Register rate-limit first, then register all routes inside server.after() so the
  // plugin's onRoute hook is active when routes are added (Fastify defers plugin init
  // to ready(), so after() guarantees plugin-before-route ordering).
  //
  // This is a GLOBAL throttle class keyed on the presented principal (#113). Before the fix,
  // rate limiting was opt-in per-route (global:false) and keyed only on IP, so the legacy
  // session-bearer path — any caller presenting a session UUID as a bearer token — could
  // hammer arbitrary module routes unbounded; only the /api/auth/* credential POSTs were
  // throttled. Now every route that does NOT declare its own config.rateLimit inherits this
  // default per-principal limit: a leaked or abused bearer token is bounded to
  // JARVIS_RL_GLOBAL_MAX req/min on its own (UUID-keyed) bucket.
  //
  // Routes with their own config.rateLimit OVERRIDE this (they do not stack): chat / MCP /
  // AI-tools keep their stricter per-principal limits, and /api/auth/* pins its own IP-based
  // key (credential POSTs are pre-auth — see registerBetterAuthRoutes). Health probes are
  // exempt via allowList.
  const GLOBAL_RL_MAX = parsePositiveIntEnv(
    resolveMossEnv(process.env, "JARVIS_RL_GLOBAL_MAX"),
    2000
  );
  server.register(rateLimit, {
    global: true,
    max: GLOBAL_RL_MAX,
    timeWindow: "1 minute",
    // Health/readiness probes must never be throttled (monitoring + compose smoke).
    allowList: (request) => request.url === "/health" || request.url.startsWith("/health/ready"),
    keyGenerator: authPrincipalRateLimitKey
  });

  // #1059 — terminal WS relay's `{ websocket: true }` route option needs this plugin
  // registered before `server.after()` (routes are wired inside that callback).
  server.register(fastifyWebsocket);

  // Test-only: extra routes + their synthetic (inactive) manifests, to verify the guard
  // 404s an inactive module's route on the REAL server. Undefined in production. The
  // accessor lets the onReady coverage hook (which runs after after()) see the synthetic
  // manifests so it does not flag the synthetic route as an orphan.
  const guardManifestsForCoverage = (): readonly MossModuleManifest[] => [
    ...getBuiltInModuleManifests(),
    ...(options.__testExtraGuardedRoutes?.manifests ?? [])
  ];

  // Accumulate every registered route as it is added, so the onReady coverage assertion
  // can read the final route tree. printRoutes parsing is brittle; an onRoute hook is
  // exact. Add it BEFORE after() so it observes routes registered inside after().
  const registeredRoutes: { method: string; url: string }[] = [];
  server.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      // HEAD is folded into GET by routeKey (normalizeMethod), so an auto-HEAD route is
      // already covered by its GET entry — skip it here to avoid asserting a separate
      // "HEAD ..." key the index never holds. OPTIONS (CORS/preflight) is not module-gated.
      if (method === "HEAD" || method === "OPTIONS") continue;
      registeredRoutes.push({ method, url: routeOptions.url });
    }
  });

  server.after(() => {
    server.get("/health", async () => ({ ok: true }));

    server.get("/health/ready", async (_, reply) => {
      let dbStatus = "ok";
      let pgbossStatus = "ok";

      try {
        await sql`SELECT 1`.execute(appDb);
      } catch {
        dbStatus = "down";
      }

      try {
        const installed = await boss.isInstalled();
        if (!installed) {
          pgbossStatus = "down";
        }
      } catch {
        pgbossStatus = "down";
      }

      const healthy = dbStatus === "ok" && pgbossStatus === "ok";
      return reply
        .code(healthy ? 200 : 503)
        .send({ ok: healthy, db: dbStatus, pgboss: pgbossStatus });
    });

    registerBetterAuthRoutes(server, authRuntime, AUTH_MAX);

    // #1752: a live cell, not a one-time snapshot — rescan() lets an admin-triggered
    // rescan surface a module dropped onto the mount after this process booted.
    const externalModuleHolder = createExternalModuleDiscoveryHolder({
      modulesDir: apiServerConfig.externalModulesDir,
      coreVersion: CORE_VERSION,
      reservedQueueNames: new Set(getAllQueueDefinitions().map((queue) => queue.name)),
      log: server.log
    });

    const externalModulesRepository = new SettingsRepository();
    const getActiveExternalModules = createActiveExternalModulesResolverForApi({
      appDataContext: dataContext,
      settingsRepository: externalModulesRepository,
      discoveries: externalModuleHolder.getDiscoveries
    });

    // #1762: the personal Modules list needs the installed set, not the actor-filtered one.
    const listInstalledExternalModules = createInstalledExternalModulesResolverForApi({
      appDataContext: dataContext,
      settingsRepository: externalModulesRepository,
      discoveries: externalModuleHolder.getDiscoveries
    });

    const externalTools = createExternalModuleTools({
      discoveries: externalModuleHolder.getDiscoveries,
      workerDataContext,
      appDataContext: dataContext,
      settingsRepository: externalModulesRepository,
      logger: { warn: (data, message) => server.log.warn(data, message) },
      // ctx.ai bridge for module workers (#932, spec D6).
      ai: createModuleAiBridge({
        aiRepository,
        logger: server.log,
        createCliStructuredAdapter: createCliStructuredAdapterFactory(options.chatEngineFactory)
      })
    });
    externalWorkerRuntime = externalTools.runtime;
    const externalToolManifests = externalTools.manifests;
    registerPlatformRoutes(server, authRuntime, getActiveExternalModules);
    // #1725: host-owned on/off switches for installed modules.
    registerModulePreferenceRoutes(server, {
      resolveAccessContext: authRuntime.resolveAccessContext,
      getActiveExternalModules,
      runner: dataContext,
      rateLimitKey: authPrincipalRateLimitKey
    });
    registerExternalModuleWebAssetRoute(
      server,
      authRuntime,
      externalModuleHolder.getDiscoveries,
      getActiveExternalModules
    );
    registerExternalModuleJobRoutes(server, {
      boss,
      discoveries: externalModuleHolder.getDiscoveries,
      resolveAccessContext: authRuntime.resolveAccessContext,
      isModuleActive: async (access, moduleId) =>
        (await getActiveExternalModules(access)).some((module) => module.id === moduleId),
      rateLimitKey: authPrincipalRateLimitKey,
      rootDb: appDb
    });

    registerClientErrorsRoute(server, {
      recordClientError: async (event, request) => {
        const input = { id: randomUUID(), ...event };
        if (!hasAuthMaterial(request)) {
          await aiRepository.recordAnonymousError(appDb, input);
          return;
        }

        try {
          const accessContext = await authRuntime.resolveAccessContext(request);
          await dataContext.withDataContext(accessContext, (scopedDb) =>
            aiRepository.recordError(scopedDb, input)
          );
        } catch {
          request.log.warn(
            { reqId: request.id },
            "skipped error persistence after auth resolution failed"
          );
        }
      }
    });

    const resolveEnabledModules = createActiveModulesResolver({
      dataContext,
      manifests: [...getBuiltInModuleManifests(), ...externalToolManifests]
    });
    const resolveActiveModules = createExternalActiveModulesResolver(
      resolveEnabledModules,
      new Set(externalToolManifests.map((manifest) => manifest.id)),
      async (actorUserId) =>
        getActiveExternalModules({
          actorUserId,
          requestId: `external-tools:${randomUUID()}`
        })
    );

    // Task 7 wired the integrations REST routes (and their cipher) in module-registry,
    // not here — this is a second cipher instance off the same key chain, used only to
    // decrypt connection credentials at tool-call time for the synthetic chat tools below.
    const integrationsCipher = createIntegrationsCipher(process.env);
    const resolveActiveModulesWithIntegrations = createIntegrationsActiveModulesResolver(
      resolveActiveModules,
      { dataContext, cipher: integrationsCipher, logger: server.log }
    );

    // Connector collaborators for the calendar focus-time write tool. A single shared
    // repository + cipher; the service is per-call-scoped via scopedDb, so one instance
    // is fine. createConnectorSecretCipher requires JARVIS_CONNECTOR_SECRET_KEY in a
    // hardened (production) env; in dev/test it falls back to the dev default.
    // Logger adapters wire server.log into the connectors package's minimal logger
    // interfaces (observability spec: no console.* in production — the clients' noop
    // defaults must be overridden at the composition root).
    const connectorsModuleLogger = createModuleLogger(server.log, "connectors");
    const connectorsRepository = new ConnectorsRepository();
    const googleConnectionService = new GoogleConnectionService({
      repository: connectorsRepository,
      cipher: createConnectorSecretCipher(),
      oauthClient: new GoogleOAuthClient({
        logger: {
          error: (data, msg) => connectorsModuleLogger.error(data, msg)
        }
      })
    });
    const googleApiClient = new GoogleApiClient({
      logger: {
        error: (data, msg) => connectorsModuleLogger.error(data, msg)
      }
    });

    // Host diagnostics (#255): a read-only, secret-safe runtime-facts provider injected
    // into the settings admin route. info() returns only explicit, non-secret config
    // values (never env-var values or connection strings); pgBossInstalled() is a cheap
    // connectivity probe. The DTO is assembled + secret-guarded inside @moss/settings.
    const hostDiagnostics = {
      info: (): HostDiagnosticsInfo => {
        const manifests = getBuiltInModuleManifests();
        const commit = resolveMossEnv(process.env, "JARVIS_GIT_COMMIT");
        const deployMode = resolveDeployMode(resolveMossEnv(process.env, "JARVIS_DEPLOY_MODE"));
        return {
          uptimeSeconds: Math.round(process.uptime()),
          environment: mapEnvMode(process.env.NODE_ENV),
          version: resolveMossEnv(process.env, "JARVIS_APP_VERSION") ?? null,
          commit: commit ? commit.slice(0, 12) : null,
          host: apiServerConfig.host,
          port: apiServerConfig.port,
          logLevel: process.env.LOG_LEVEL ?? "info",
          deployMode,
          restartCommand: restartCommandFor(deployMode),
          moduleCount: manifests.length,
          routeCount: manifests.reduce((sum, m) => sum + (m.routes?.length ?? 0), 0)
        };
      },
      pgBossInstalled: (): Promise<boolean> =>
        boss
          .isInstalled()
          .then((v) => v === true)
          .catch(() => false)
    };
    // #964/#9.5: factored to module-distribution-port.ts to restore the file-size cap.
    const moduleDistribution = createModuleDistributionPort(server, apiServerConfig, options);

    // #993/#9.5: factored to herdr-install-port.ts (resolveHerdrInstall) to restore the
    // file-size cap; options.installHerdr lets tests inject a fake install().
    const herdrInstall = resolveHerdrInstall(server, options);

    // #1748: the bind-mounted control directory the admin "Restart app" button writes its
    // sentinel into. Absent env var ⇒ dependency undefined ⇒ the route fails closed (503),
    // which is the right default for a dev checkout with no host unit behind it.
    const hostControlDir = process.env.JARVIS_HOST_CONTROL_DIR?.trim();
    const hostRestart = hostControlDir ? { controlDir: hostControlDir } : undefined;

    // #917: externalModuleHolder is computed above (before registerPlatformRoutes),
    // because the /api/modules provider closes over it. registerBuiltInApiRoutes reuses
    // the same holder for the settings module's external-module deps below.
    registerBuiltInApiRoutes(server, {
      rootDb: appDb,
      resolveAccessContext: authRuntime.resolveAccessContext,
      listConfiguredAuthProviders: authRuntime.listConfiguredProviders,
      listModuleManifests: getBuiltInModuleManifests,
      resolveActiveModules: resolveActiveModulesWithIntegrations,
      mcpServerUrl: apiServerConfig.mcpServerUrl,
      focusSignals: async (ctx) => {
        // 1) Resolve THIS actor's active manifests (honors per-user/instance disable) — its
        //    own short context, exactly like the AI route surfaces do. A disabled module is
        //    excluded, so it contributes no focus signal.
        const activeManifests = await resolveActiveModules(ctx.actorUserId);
        const providers = focusSignalProvidersFor(activeManifests);
        if (providers.length === 0) return [];
        // 2) Run each provider in its OWN actor-scoped data context (fresh withDataContext →
        //    fresh transaction → fresh pg connection). A shared transaction is one pg client,
        //    so providers would serialize on it AND one provider's query aborting the txn
        //    (25P02) would poison every other provider — defeating aggregateFocusSignals'
        //    fail-soft guarantee. Per-provider contexts make the fail-soft real.
        return aggregateFocusSignals(
          providers,
          (work) =>
            dataContext.withDataContext(
              { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
              (scopedDb) => work(scopedDb)
            ),
          ctx,
          {
            onProviderError: (moduleId, errorName) =>
              // Sanitized: moduleId + error NAME only — never message/stack/payload.
              server.log.warn({ moduleId, errorName }, "focus-signal provider failed (soft)")
          }
        );
      },
      dataContext,
      boss,
      chatEngineFactory: options.chatEngineFactory,
      connectTerminalRpc: options.connectTerminalRpc,
      personaPreview: options.personaPreview,
      revokeUserSessions: authRuntime.revokeUserSessions,
      meSessions: authRuntime.meSessions,
      verifySelfPassword: authRuntime.verifySelfPassword,
      hasPasswordCredential: authRuntime.hasPasswordCredential,
      bootstrapConnectionString: ownsAppDb ? getMossDatabaseUrls().bootstrap : undefined,
      googleConnectionService,
      googleApiClient,
      connectorsRepository,
      hostDiagnostics,
      herdrInstall,
      hostRestart,
      externalModules: {
        // #996/#860: always-on since the JARVIS_ENABLE_EXTERNAL_MODULES flag removal —
        // packages/settings routes-module-registry.ts / routes-modules.ts gate on this
        // field with `if (!ext?.enabled) throw 409`; hardcoding true here means those
        // guards simply never fire, which is correct (verified — no change needed there).
        // #1319 D6: options.__testExternalModulesEnabled is TEST-ONLY (undefined in
        // production, so `?? true` keeps the always-on default).
        enabled: options.__testExternalModulesEnabled ?? true,
        // #1752: pass the live getter, not a called-once snapshot — otherwise an admin who
        // triggers a rescan still sees the stale list on this exact page until a restart.
        discoveries: externalModuleHolder.getDiscoveries,
        rejected: externalModuleHolder.getRejected(),
        reconcile: (states) =>
          reconcileExternalModules(externalModuleHolder.getDiscoveries(), states),
        rescan: () => externalModuleHolder.rescan().then(() => undefined)
      },
      // #1762: narrowed to the four fields the personal Modules list needs, so the settings
      // package never sees a ReconciledExternalModule (it cannot import that type).
      listInstalledExternalModules: async (accessContext) =>
        (await listInstalledExternalModules(accessContext)).map((module) => ({
          id: module.id,
          name: module.name,
          version: module.version,
          hasPreferences: module.preferences.length > 0,
          // #1759: read from the boot discovery snapshot rather than the reconciled module,
          // which does not carry credential declarations. A module with user-scope slots and no
          // switches still needs a settings page — that is exactly Finance.
          hasUserCredentials: (
            externalModuleHolder.getDiscoveries().find((d) => d.id === module.id)?.manifest.auth ??
            []
          ).some((declaration) => declaration.scope === "user"),
          // #1945: the resolver above only ever returns "draft" or "enabled" here (its filter
          // keeps `active` modules only, and drift-disabled/discovered ones are never active).
          status: module.status as "draft" | "enabled"
        })),
      moduleDistribution,
      // #1263 Task 15: install-time self-operation grants also apply on (re-)enable. Built here
      // over the one AiRepository instance this file already owns, so settings never imports
      // @moss/ai directly (module isolation).
      grantSelfOperationForModule: (scopedDb, manifest) =>
        grantSelfOperationForModule(scopedDb, aiRepository, manifest),
      reconcileExternalModuleJobs: async (change) => {
        if (change.kind === "module") {
          await sendModuleControl(boss, { moduleId: change.moduleId, action: "reconcile" });
          return;
        }
        await reconcileExternalModuleUserJobs(
          boss,
          externalModuleHolder.getDiscoveries(),
          change.userId
        );
      },
      fetchFn: options.fetchFn
    });

    const guardManifests = [
      ...getBuiltInModuleManifests(),
      ...(options.__testExtraGuardedRoutes?.manifests ?? [])
    ];
    if (options.__testExtraGuardedRoutes) {
      for (const r of options.__testExtraGuardedRoutes.routes) {
        server.route({ method: r.method, url: r.url, handler: async () => ({ ok: true }) });
      }
    }

    registerRouteEnablementGuard(server, {
      manifests: guardManifests,
      resolveActiveModules,
      resolveAccessContext: authRuntime.resolveAccessContext
    });

    registerStaticWeb(server);
  });

  // Central error handler (#413): every unhandled request error flows through
  // here. Logs a structured allowlisted line and returns a safe body (fixed
  // "Internal Server Error" on 5xx — no stack/internal detail). See
  // error-handling.ts for the secrets-never-escape invariant.
  setMossErrorHandler(server, {
    recordRequestError: async (event, request) => {
      const input = { id: randomUUID(), ...event };
      if (!hasAuthMaterial(request)) {
        await aiRepository.recordAnonymousError(appDb, input);
        return;
      }

      const accessContext = await authRuntime.resolveAccessContext(request);
      await dataContext.withDataContext(accessContext, (scopedDb) =>
        aiRepository.recordError(scopedDb, input)
      );
    }
  });

  server.addHook("onReady", async () => {
    // Coverage assertion (ADR 0009 §4) runs once the route tree is final. Throws if any
    // registered route is neither claimed by a manifest routes[] nor on the platform
    // allowlist (the guard would have a blind spot for it). Use the SAME manifest set the
    // guard uses, so the test-only synthetic routes are covered by their synthetic
    // manifest; in production __testExtraGuardedRoutes is undefined → identical to the
    // built-in set.
    assertRouteCoverage({
      registered: registeredRoutes,
      manifests: guardManifestsForCoverage(),
      platformAllowlist: PLATFORM_UNGUARDED_ROUTES
    });
  });

  server.addHook("onReady", async () => {
    // #1263 covers BUILT-IN manifests only; external module tools are deferred to #1267 and
    // stay safe today because their ABI cannot declare actionFamilyId, so
    // packages/ai/src/gateway/policy.ts:40 confirms every external write unconditionally.
    // Never pass external manifests here.
    assertBuiltInSelfOperationManifests(getBuiltInModuleManifests());
  });

  server.addHook("onReady", async () => {
    if (ownsBoss) {
      await boss.start();
    }
  });

  server.addHook("onClose", async () => {
    await externalWorkerRuntime?.close();
    await Promise.allSettled([
      ownsBoss ? boss.stop({ graceful: false }) : Promise.resolve(),
      ownsAuthRuntime ? authRuntime.close() : Promise.resolve(),
      ownsAppDb ? appDb.destroy() : Promise.resolve(),
      ownsWorkerDb ? workerDb.destroy() : Promise.resolve()
    ]);
  });

  return server;
}

export function registerRequestTimeZoneHook(server: FastifyInstance): void {
  server.addHook("onRequest", async (request) => {
    const raw = request.headers["x-timezone"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && isValidTimeZone(value)) {
      request.timeZone = value.trim();
    }
  });
}

/**
 * Graceful-shutdown helper for the api entrypoint (deployable-stack §9). On
 * SIGTERM/SIGINT we call server.close() — which runs the onClose hook tearing
 * down boss/auth/db — then exit 0, racing a bounded timeout so a hung close
 * still exits cleanly. Mirrors the worker's signal path (worker.ts:151-157).
 *
 * Exported (and parameterized with exit/timeout) so it is unit-testable without
 * spawning the real binary or sending a real signal.
 */
export async function shutdownOnSignal(
  server: { close(cb: (err?: Error) => void): void },
  opts: { timeoutMs?: number; exit?: (code: number) => never } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  await Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    })
  ]);
  exit(0);
}

/**
 * Crash-handler factory for the api entrypoint (spec §1140-E, #1527). Both
 * `unhandledRejection` and `uncaughtException` share the closure-local
 * `crashing` latch below: the first crash notification logs, races a bounded
 * shutdown, and exits; any later notification in the same window is a no-op,
 * so a second error can never re-log, re-close, or re-exit.
 *
 * Exported (and parameterized with timeout/exit) so it is unit-testable
 * without spawning the real binary or racing a second real crash.
 */
export function createCrashHandler(
  server: {
    log: { error(obj: Record<string, unknown>, msg: string): void };
    close(cb: (err?: Error) => void): void;
  },
  opts: { timeoutMs?: number; exit?: (code: number) => never } = {}
): (label: string, err: unknown) => void {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let crashing = false;
  return (label: string, err: unknown): void => {
    if (crashing) return;
    crashing = true;
    server.log.error({ err, label }, "Process crash — exiting");
    const drain = Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
    void drain.then(() => {
      exit(1);
    });
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apiServerConfig = resolveApiServerConfig();
  const server = createApiServer({ apiServerConfig });
  const port = apiServerConfig.port;
  const host = apiServerConfig.host;

  const handleCrash = createCrashHandler(server);

  process.on("unhandledRejection", (reason) => {
    handleCrash("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err: Error) => {
    handleCrash("uncaughtException", err);
  });

  process.once("SIGTERM", () => {
    void shutdownOnSignal(server);
  });
  process.once("SIGINT", () => {
    void shutdownOnSignal(server);
  });

  await server.listen({ host, port });
}

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
function authPrincipalRateLimitKey(request: FastifyRequest): string {
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

function registerBetterAuthRoutes(
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

function registerPlatformRoutes(
  server: FastifyInstance,
  authRuntime: MossAuthRuntime,
  // #996/#860: always-on provider of the ACTIVE external modules for the actor.
  getActiveExternalModules: (
    accessContext: AccessContext
  ) => Promise<readonly ReconciledExternalModule[]>
): void {
  server.get("/api/modules", { schema: listModulesRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await authRuntime.resolveAccessContext(request);

      const builtIns = getBuiltInModuleManifests().map(serializeModule);
      // #996/#860: append ACTIVE external modules (reconcile already filtered to active === true).
      // Runs in the actor's own data context, so /api/modules reflects only what is active.
      const external = (await getActiveExternalModules(accessContext)).map(serializeExternalModule);
      return {
        modules: [...builtIns, ...external]
      };
    } catch (error) {
      const code =
        (error instanceof Error && (error as Error & { code?: string }).code) || undefined;
      if (code === "account_pending_approval") {
        return reply.code(403).send({ error: "Account is pending approval", code });
      }
      if (code === "account_deactivated") {
        return reply.code(403).send({ error: "Account has been deactivated", code });
      }
      return reply.code(401).send({ error: "Session is missing or expired" });
    }
  });
}
